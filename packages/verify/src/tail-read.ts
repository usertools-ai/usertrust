// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Acquiring what `tail-state.ts` classifies, never blind and always bounded:
 *  - a file is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (`O_NONBLOCK`: opening a FIFO with no writer
 *    would otherwise block forever), `fstat`ed, and read only when it is a regular file, up to a limit;
 *  - a directory is `lstat`ed first, so a symlink in its place is never listed through, except the
 *    audit directory itself, which is the directory the OS opens at its path (`followLink`): the
 *    files in it are opened through it by every writer and reader alike;
 *  - a segment read whole is split into lines as BYTES (`splitLines`), never decoded as one string:
 *    a log over V8's string limit (512 MiB) could not be;
 *  - a log's tail is read BACKWARD from its end, until it holds its last two complete lines, never
 *    the whole file (`countLogLines`, a full read, is for a legacy log only: its last event carries
 *    no sequence, so its position is its line count).
 *
 * IDENTICAL in packages/core/src/audit/tail-read.ts and packages/verify/src/tail-read.ts (the
 * file-diff test pins them, import lines aside).
 */

import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	type Stats,
	statSync,
} from "node:fs";
import type {
	FileKind,
	FileObservation,
	InventoryObservation,
	LogObservation,
	LogTail,
} from "./tail-state.js";

/** The most bytes a log's last two lines and its trailing bytes may take. */
export const MAX_TAIL_BYTES = 64 * 1024 * 1024;

/**
 * The most bytes one event's line may take. The writer refuses a larger event before writing it, and
 * one that, with the last line before it, would not fit `MAX_TAIL_BYTES` (a last line an older writer
 * left over this bound): a writer never writes a tail it would then refuse to read.
 */
export const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;

/** The most bytes a file read whole (a log segment, the dead-letter queue, the anchor mirror) may take. */
export const MAX_SEGMENT_BYTES = 1024 * 1024 * 1024;

/**
 * The most bytes a snapshot's log segments may take TOGETHER: a verdict holds every segment at once (it walks
 * the chain across them), so a vault of many segments each under the bound for one read is bounded too.
 */
export const MAX_SNAPSHOT_BYTES = 2 * MAX_SEGMENT_BYTES;

/** The most names a vault directory listing may hold. */
export const MAX_INVENTORY_NAMES = 100_000;

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/** A non-regular file's kind, in words the classifier uses. */
export function fileKindOf(st: Stats): FileKind {
	if (st.isSymbolicLink()) return "symlink";
	if (st.isDirectory()) return "directory";
	if (st.isFIFO()) return "fifo";
	if (st.isSocket()) return "socket";
	if (st.isCharacterDevice() || st.isBlockDevice()) return "device";
	return "other";
}

function codeOf(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "EUNKNOWN";
}

/**
 * The observation an open that failed stands for. `ELOOP` is a symlink (`O_NOFOLLOW` refuses it,
 * live or dangling), `EISDIR` a directory opened for writing, `ENXIO` a FIFO opened for writing with
 * no reader; anything else could not be read.
 */
export function openFailure(err: unknown): FileObservation & LogObservation {
	switch (codeOf(err)) {
		case "ENOENT":
			return { kind: "absent" };
		case "ELOOP":
			return { kind: "not_regular", fileKind: "symlink" };
		case "EISDIR":
			return { kind: "not_regular", fileKind: "directory" };
		case "ENXIO":
			return { kind: "not_regular", fileKind: "fifo" };
		default:
			return { kind: "unavailable", code: codeOf(err) };
	}
}

/** Read `length` bytes at `position` through `fd`, looping short reads; fewer only at end of file. */
function readAt(fd: number, length: number, position: number): Buffer {
	const buf = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buf, got, length - got, position + got);
		if (n === 0) break;
		got += n;
	}
	return got === length ? buf : buf.subarray(0, got);
}

/** Acquire a small file whole (the anchor), within `maxBytes`. */
export function acquireSmallFile(path: string, maxBytes: number): FileObservation {
	let fd: number;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		return openFailure(err);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return { kind: "not_regular", fileKind: fileKindOf(st) };
		if (st.size > maxBytes) return { kind: "oversize", size: st.size };
		// One byte past the limit: a file that grew since the fstat is still caught.
		const bytes = readAt(fd, maxBytes + 1, 0);
		if (bytes.length > maxBytes) return { kind: "oversize", size: bytes.length };
		return { kind: "read", bytes };
	} catch (err) {
		return { kind: "unavailable", code: codeOf(err) };
	} finally {
		closeSync(fd);
	}
}

/**
 * Acquire a file whole (a log segment: verification reads every line), through one no-follow
 * descriptor, within `maxBytes`, and say whether it changed while it was read (its size or mtime
 * moved, or it held more or fewer bytes than its size said). A larger file is `oversize`, named, never
 * read: nothing is held in memory without a bound.
 */
export function acquireWholeFile(
	path: string,
	maxBytes = MAX_SEGMENT_BYTES,
): { file: FileObservation; changed: boolean } {
	let fd: number;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (err) {
		return { file: openFailure(err), changed: false };
	}
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile()) {
			return { file: { kind: "not_regular", fileKind: fileKindOf(fstatSync(fd)) }, changed: false };
		}
		if (before.size > BigInt(maxBytes)) {
			return { file: { kind: "oversize", size: Number(before.size) }, changed: false };
		}
		const chunks: Buffer[] = [];
		let position = 0;
		for (;;) {
			const chunk = Buffer.alloc(CHUNK);
			const n = readSync(fd, chunk, 0, chunk.length, position);
			if (n === 0) break;
			chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
			position += n;
			// It grew past the bound while it was read: oversize, and changed.
			if (position > maxBytes) return { file: { kind: "oversize", size: position }, changed: true };
		}
		const after = fstatSync(fd, { bigint: true });
		const changed =
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			BigInt(position) !== after.size;
		return { file: { kind: "read", bytes: Buffer.concat(chunks) }, changed };
	} catch (err) {
		return { file: { kind: "unavailable", code: codeOf(err) }, changed: false };
	} finally {
		closeSync(fd);
	}
}

/**
 * List a vault directory: absent is `missing`; a non-directory in its place is unreadable, and so is a
 * symlink, unless `followLink` (the audit directory: the directory the OS opens at its path, as every
 * file in it is opened through it). A link that leads nowhere is unreadable, never `missing`.
 */
export function listDirectory(
	path: string,
	maxNames = MAX_INVENTORY_NAMES,
	followLink = false,
): InventoryObservation {
	let st: Stats;
	try {
		st = lstatSync(path);
	} catch (err) {
		return codeOf(err) === "ENOENT"
			? { kind: "missing" }
			: { kind: "unreadable", code: codeOf(err) };
	}
	if (st.isSymbolicLink() && followLink) {
		try {
			st = statSync(path);
		} catch (err) {
			return { kind: "unreadable", code: codeOf(err) };
		}
	}
	if (!st.isDirectory()) return { kind: "unreadable", code: "ENOTDIR" };
	let names: string[];
	try {
		names = readdirSync(path);
	} catch (err) {
		return { kind: "unreadable", code: codeOf(err) };
	}
	if (names.length > maxNames) return { kind: "oversize", count: names.length };
	return { kind: "ok", names };
}

/**
 * Read the tail of a log through `fd` (a regular file of `size` bytes): its last two complete lines
 * and the bytes after its last newline, read backward from the end, within `maxBytes`.
 */
export function readLogTail(fd: number, size: number, maxBytes = MAX_TAIL_BYTES): LogObservation {
	// Newline offsets found so far, from the end backward: the last three are all that are needed.
	const newlines: number[] = [];
	let start = size;
	const chunks: Buffer[] = [];
	while (start > 0 && newlines.length < 3) {
		if (size - start >= maxBytes) return { kind: "oversize", size };
		const from = Math.max(0, start - CHUNK);
		const chunk = readAt(fd, start - from, from);
		if (chunk.length !== start - from) return { kind: "unavailable", code: "ESHORTREAD" };
		for (let i = chunk.length - 1; i >= 0 && newlines.length < 3; i--) {
			if (chunk[i] === NEWLINE) newlines.push(from + i);
		}
		chunks.unshift(chunk);
		start = from;
	}
	const region = Buffer.concat(chunks);
	const at = (offset: number) => offset - start;
	const lastNl = newlines[0];
	if (lastNl === undefined) {
		// No newline at all: no complete line, every byte is trailing.
		return {
			kind: "tail",
			tail: { lines: [], fromStart: true, trailing: region, trailingOffset: 0 },
		};
	}
	const trailing = region.subarray(at(lastNl + 1));
	const lines: Buffer[] = [];
	const secondNl = newlines[1];
	const thirdNl = newlines[2];
	const lastStart = secondNl === undefined ? 0 : secondNl + 1;
	if (secondNl !== undefined) {
		const prevStart = thirdNl === undefined ? 0 : thirdNl + 1;
		lines.push(region.subarray(at(prevStart), at(secondNl)));
	}
	lines.push(region.subarray(at(lastStart), at(lastNl)));
	const tail: LogTail = {
		lines,
		fromStart: thirdNl === undefined,
		trailing,
		trailingOffset: lastNl + 1,
	};
	return { kind: "tail", tail };
}

/** The number of complete lines (newlines) in the first `size` bytes of `fd`: one full read. */
export function countLogLines(fd: number, size: number): number {
	let count = 0;
	for (let position = 0; position < size; position += CHUNK) {
		const chunk = readAt(fd, Math.min(CHUNK, size - position), position);
		for (let i = 0; i < chunk.length; i++) if (chunk[i] === NEWLINE) count++;
	}
	return count;
}

/**
 * A file's complete lines (each without its newline) and the bytes after its last newline, as views
 * of `bytes`: never decoded as one string, which V8 cannot hold past 512 MiB. A line is decoded alone,
 * by `parseLine`, which reads one it cannot decode as unparseable.
 */
export function splitLines(bytes: Buffer): {
	lines: Buffer[];
	trailing: Buffer;
	trailingOffset: number;
} {
	const lastNl = bytes.lastIndexOf(NEWLINE);
	const lines: Buffer[] = [];
	let start = 0;
	while (start <= lastNl) {
		const nl = bytes.indexOf(NEWLINE, start);
		lines.push(bytes.subarray(start, nl));
		start = nl + 1;
	}
	return { lines, trailing: bytes.subarray(lastNl + 1), trailingOffset: lastNl + 1 };
}
