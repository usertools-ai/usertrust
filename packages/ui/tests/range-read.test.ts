// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// The grow path reads only the bytes after the offset, through a descriptor whose identity is the one the last load
// recorded. These rows count the bytes read from `events.jsonl` through a pass-through `node:fs`, so a whole-log read
// per change shows up as a number, and they replace, shrink and tear the log under a running dashboard.

import { createHash } from "node:crypto";
import type * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	/** Bytes read from any file named `events.jsonl`, by any reader. */
	logBytes: 0,
	/** Descriptors opened on a file named `events.jsonl`. */
	logFds: new Set<number>(),
	/** When set, every BigInt stat reports inode 0, as some filesystems do for every file. */
	zeroInode: false,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const isLog = (p: unknown): boolean => String(p).endsWith("events.jsonl");
	const zero = <T>(st: T): T =>
		io.zeroInode && st !== undefined && typeof (st as { ino: unknown }).ino === "bigint"
			? ({ ...st, ino: 0n } as T)
			: st;
	const wrapped = {
		...real,
		openSync: ((p: realFs.PathLike, ...rest: unknown[]) => {
			const fd = (real.openSync as (...a: unknown[]) => number)(p, ...rest);
			if (isLog(p)) io.logFds.add(fd);
			else io.logFds.delete(fd);
			return fd;
		}) as typeof real.openSync,
		closeSync: ((fd: number) => {
			io.logFds.delete(fd);
			real.closeSync(fd);
		}) as typeof real.closeSync,
		readSync: ((fd: number, ...rest: unknown[]) => {
			const n = (real.readSync as (...a: unknown[]) => number)(fd, ...rest);
			if (io.logFds.has(fd)) io.logBytes += n;
			return n;
		}) as typeof real.readSync,
		readFileSync: ((p: realFs.PathOrFileDescriptor, ...rest: unknown[]) => {
			const out = (real.readFileSync as (...a: unknown[]) => string | Buffer)(p, ...rest);
			if (isLog(p)) io.logBytes += Buffer.byteLength(out);
			return out;
		}) as typeof real.readFileSync,
		fstatSync: ((...a: unknown[]) =>
			zero((real.fstatSync as (...b: unknown[]) => unknown)(...a))) as typeof real.fstatSync,
		statSync: ((...a: unknown[]) =>
			zero((real.statSync as (...b: unknown[]) => unknown)(...a))) as typeof real.statSync,
	};
	return { ...wrapped, default: wrapped };
});

const {
	appendFileSync,
	closeSync,
	cpSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
	writeSync,
} = await import("node:fs");
const { canonicalize } = await import("usertrust-verify");
const { createAuditWriter } = await import("../../core/src/audit/chain.js");
const { createUiServer } = await import("../src/server/server.js");
const { appendSeam, fileIdentity, loadSeam, loadState, readAppended } = await import(
	"../src/server/state.js"
);
const { __tailTestSeam, watchLedger } = await import("../src/server/tail.js");
const { EventEmitter } = await import("node:events");

type Summary = {
	chain: { events: number; valid: boolean; breakIndex: number | null; errors: string[] };
};

async function readFrames(
	port: number,
	act: () => Promise<void> | void,
	until: (names: string[]) => boolean,
	timeoutMs = 6000,
): Promise<string[]> {
	const res = await fetch(`http://127.0.0.1:${port}/api/tail`);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	await act();
	const decoder = new TextDecoder();
	const names: string[] = [];
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !until(names)) {
		const next = await Promise.race([
			reader.read(),
			new Promise<undefined>((r) =>
				setTimeout(() => r(undefined), Math.max(1, deadline - Date.now())),
			),
		]);
		if (next === undefined || next.done) break;
		buffer += decoder.decode(next.value, { stream: true });
		const blocks = buffer.split("\n\n");
		buffer = blocks.pop() ?? "";
		for (const block of blocks) {
			const name = /event: (.+)/.exec(block)?.[1];
			if (name !== undefined) names.push(name);
		}
	}
	await reader.cancel();
	return names;
}

async function summaryOf(port: number): Promise<Summary> {
	return (await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()) as Summary;
}

/** The chain fields a fresh load of the same vault reads: what the live dashboard must equal. */
function freshChain(root: string): Summary["chain"] {
	const { events, valid, breakIndex, errors } = loadState(join(root, ".usertrust")).summary.chain;
	return { events, valid, breakIndex, errors };
}

function liveChain(s: Summary): Summary["chain"] {
	const { events, valid, breakIndex, errors } = s.chain;
	return { events, valid, breakIndex, errors };
}

async function appendEvents(root: string, count: number, prefix: string): Promise<void> {
	const writer = createAuditWriter(root);
	for (let i = 0; i < count; i++) {
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 5, settled: true, transferId: `${prefix}_${i}` },
		});
	}
	writer.release();
}

/** The event that chains after the last complete line of `text`, as the writer would persist it: its line, newline included. */
function chainedAfter(text: string, transferId: string): string {
	const prev = JSON.parse(
		text
			.split("\n")
			.filter((l) => l.endsWith("}"))
			.at(-1) as string,
	) as { hash: string; sequence: number };
	const rest = {
		actor: "local",
		data: { cost: 5, settled: true, transferId },
		id: `${transferId}-id`,
		kind: "llm_call",
		previousHash: prev.hash,
		sequence: prev.sequence + 1,
		timestamp: new Date().toISOString(),
	};
	const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
	return `${canonicalize({ ...rest, hash })}\n`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("readAppended", () => {
	let dir: string;
	let log: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-range-"));
		log = join(dir, "events.jsonl");
		io.zeroInode = false;
	});
	afterEach(() => {
		io.zeroInode = false;
		rmSync(dir, { recursive: true, force: true });
	});

	const idOf = (p: string): string => {
		const st = statSync(p, { bigint: true });
		return st.birthtimeNs === 0n ? `${st.dev}:${st.ino}` : `${st.dev}:${st.ino}:${st.birthtimeNs}`;
	};

	it("reads only the range after the offset: a 2 MiB log with a 40-byte torn tail costs 40 bytes per read", () => {
		const line = `${"x".repeat(1023)}\n`;
		writeFileSync(log, line.repeat(2048));
		const offset = statSync(log).size;
		appendFileSync(log, "y".repeat(40));
		const id = idOf(log);
		for (let i = 0; i < 5; i++) {
			io.logBytes = 0;
			const read = readAppended(log, offset, id);
			expect(read.kind).toBe("bytes");
			expect(io.logBytes).toBe(40);
		}
	});

	it("returns the same bytes as the whole file from the offset, at three offsets", () => {
		writeFileSync(log, '{"a":1}\n{"b":2}\n{"c":3');
		const id = idOf(log);
		const whole = readFileSync(log);
		for (const offset of [0, 8, 11]) {
			const read = readAppended(log, offset, id);
			expect(read.kind).toBe("bytes");
			expect(read.kind === "bytes" && Buffer.compare(read.buf, whole.subarray(offset))).toBe(0);
		}
	});

	it("a log shorter than the offset is shrunk", () => {
		writeFileSync(log, '{"a":1}\n{"b":2}\n');
		const id = idOf(log);
		truncateSync(log, 4);
		expect(readAppended(log, 16, id).kind).toBe("shrunk");
	});

	it("another file renamed over the log is replaced, even when its bytes past the offset are the same", () => {
		const text = '{"a":1}\n{"b":2}\n';
		writeFileSync(log, text);
		const id = idOf(log);
		const other = join(dir, "other.jsonl");
		writeFileSync(other, `${text}{"c":3}\n`);
		renameSync(other, log);
		expect(readAppended(log, text.length, id).kind).toBe("replaced");
	});

	it("an inode number of 0, or no recorded identity, is unknown", () => {
		writeFileSync(log, '{"a":1}\n');
		const id = idOf(log);
		expect(readAppended(log, 0, undefined).kind).toBe("unknown");
		io.zeroInode = true;
		expect(readAppended(log, 0, id).kind).toBe("unknown");
	});
});

describe("loadState's identity", () => {
	let root: string;
	let vault: string;
	let log: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "trust-range-load-"));
		vault = join(root, ".usertrust");
		log = join(vault, "audit", "events.jsonl");
		await appendEvents(root, 3, "tx");
	});
	afterEach(() => {
		loadSeam.afterDescriptor = undefined;
		loadSeam.afterReaders = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	/** A copy of the vault's log with one more chained event, written beside it for a rename. */
	function replacement(): string {
		const text = readFileSync(log, "utf-8");
		const next = join(vault, "audit", "next.tmp");
		writeFileSync(next, text + chainedAfter(text, "tx_next"));
		return next;
	}

	const lastHashOf = (p: string): string =>
		(JSON.parse(readFileSync(p, "utf-8").trim().split("\n").at(-1) as string) as { hash: string })
			.hash;

	it("a rename between the descriptor read and the by-path reads never pairs one file's identity with another's chain", async () => {
		const next = replacement();
		let renamed = false;
		loadSeam.afterDescriptor = () => {
			if (renamed) return;
			renamed = true;
			renameSync(next, log);
		};
		const state = loadState(vault);
		expect(renamed).toBe(true);
		// Redone on the file now at the path: its identity, its chain and its size, together.
		const st = statSync(log, { bigint: true });
		expect(state.logId).toBe(
			st.birthtimeNs === 0n ? `${st.dev}:${st.ino}` : `${st.dev}:${st.ino}:${st.birthtimeNs}`,
		);
		expect(state.lastHash).toBe(lastHashOf(log));
		expect(state.byteOffset).toBe(Number(st.size));
		expect(state.summary.chain.events).toBe(4);
	});

	it("a log that keeps changing under every pass leaves the identity unknown, and the next consistent load sets it", () => {
		let n = 0;
		const baseMs = statSync(log).mtimeMs;
		loadSeam.afterReaders = () => {
			n += 1;
			// The same bytes rewritten, then given an mtime a whole second later per pass, so the path no longer matches
			// what the descriptor saw. A rewrite alone is not enough: within one tick of a coarse file-system clock it
			// leaves size, inode and mtime all unchanged, and the pass reads as consistent.
			writeFileSync(log, readFileSync(log));
			utimesSync(log, new Date(), new Date(baseMs + n * 1000));
		};
		const unsettled = loadState(vault);
		expect(n).toBe(4);
		expect(unsettled.logId).toBeUndefined();
		loadSeam.afterReaders = undefined;
		const settled = loadState(vault);
		expect(settled.logId).toBeDefined();
	});

	it("red-first (false clean): a deletion seen by a pass that is redone stays detected when the retry finds a fresh valid chain", async () => {
		// A fresh valid chain, built elsewhere, to put in the deleted directory's place.
		const other = mkdtempSync(join(tmpdir(), "trust-range-fresh-"));
		try {
			await appendEvents(other, 2, "fresh");
			const audit = join(vault, "audit");
			let pass = 0;
			// The directory is checked after `afterReaders`, so the first pass must still find it absent there: it is
			// removed on the first pass's `afterDescriptor` (its log vanishes, so that pass is inconsistent and redone)
			// and recreated on the retry's `afterDescriptor`, before that pass reads anything.
			loadSeam.afterDescriptor = () => {
				pass += 1;
				if (pass === 1) rmSync(audit, { recursive: true, force: true });
				if (pass === 2) cpSync(join(other, ".usertrust", "audit"), audit, { recursive: true });
			};
			const state = loadState(vault, undefined, true, []);
			// The second pass sees the directory's listing change under it (the rotated segments are bracketed too), so a
			// third pass reads the recreated directory unchanged.
			expect(pass).toBe(3);
			// The retry read the recreated chain, and the deletion the first pass saw is still the verdict.
			expect(state.summary.chain.events).toBe(2);
			expect(state.deletionDetected).toBe(true);
			expect(state.summary.chain.valid).toBe(false);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("records a fragment after the last newline, with the offset at the size the descriptor saw", () => {
		appendFileSync(log, '{"id":"torn');
		const state = loadState(vault);
		expect(state.pendingFragment).toBe(true);
		expect(state.byteOffset).toBe(statSync(log).size);
		appendFileSync(log, "\n");
		expect(loadState(vault).pendingFragment).toBe(false);
	});
});

describe("the grow path under a running dashboard", { timeout: 30_000 }, () => {
	let root: string;
	let vault: string;
	let log: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "trust-range-ui-"));
		vault = join(root, ".usertrust");
		log = join(vault, "audit", "events.jsonl");
		io.zeroInode = false;
		await appendEvents(root, 3, "tx");
	});
	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		io.zeroInode = false;
		rmSync(root, { recursive: true, force: true });
	});

	/** The vault's next event, chained after its last complete line. */
	const nextLine = (): string => chainedAfter(readFileSync(log, "utf-8"), "tx_next");

	/**
	 * The vault's next event as the real writer writes it, in a copy: its line, and the head anchor (`.meta`) that goes
	 * with it, so a vault given both reads valid.
	 */
	async function writerNext(): Promise<{ line: string; meta: Buffer }> {
		const stage = mkdtempSync(join(tmpdir(), "trust-range-stage-"));
		cpSync(vault, join(stage, ".usertrust"), { recursive: true });
		await appendEvents(stage, 1, "tx_next");
		const staged = join(stage, ".usertrust", "audit", "events.jsonl");
		const line = `${readFileSync(staged, "utf-8").trim().split("\n").at(-1) as string}\n`;
		const meta = readFileSync(`${staged}.meta`);
		rmSync(stage, { recursive: true, force: true });
		return { line, meta };
	}

	/** Fires `count` watcher checks without touching the log: another file in the audit directory changes. */
	async function pokeWatcher(count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			writeFileSync(join(vault, "audit", "poke.txt"), String(i));
			await sleep(450);
		}
	}

	it("red-first (whole-log read per change): an unfinished last line costs its own bytes per check, not the log's", async () => {
		const writer = createAuditWriter(root);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 1, transferId: "tx_big", pad: "p".repeat(2 * 1024 * 1024) },
		});
		writer.release();
		ui = await createUiServer(root, { port: 0 });
		const size = statSync(log).size;
		appendFileSync(log, '{"id":"torn-by-a-writer-still-writing-it"');
		await sleep(450);
		io.logBytes = 0;
		await pokeWatcher(5);
		// Each check reads the fragment (about 40 bytes), never the 2 MiB log.
		expect(io.logBytes).toBeLessThan(size);
		expect(io.logBytes).toBeLessThanOrEqual(5 * 64);
	});

	it("red-first (false clean): a log REPLACED by a copy with an altered first event and a chained 4th reads invalid, as a fresh load does", async () => {
		ui = await createUiServer(root, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 3, valid: true });
		const text = readFileSync(log, "utf-8");
		const lines = (text + chainedAfter(text, "tx_next")).split("\n");
		// Same length: only a value changes, so nothing about the size gives the replacement away.
		lines[0] = (lines[0] as string).replace('"cost":5', '"cost":9');
		const tampered = join(vault, "audit", "tampered.tmp");
		writeFileSync(tampered, lines.join("\n"));
		const port = ui.port;
		const names = await readFrames(
			port,
			() => renameSync(tampered, log),
			(n) => n.includes("summary"),
		);
		expect(names).toContain("resync");
		expect(names).not.toContain("rows");
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 4, valid: false });
		expect(live).toEqual(freshChain(root));
	});

	it("red-first (false clean): a complete chained line after a dead writer's fragment is a full reload, never an extension", async () => {
		appendFileSync(log, '{"id":"died-mid-line"');
		ui = await createUiServer(root, { port: 0 });
		const line = nextLine();
		const port = ui.port;
		const names = await readFrames(
			port,
			() => appendFileSync(log, line),
			(n) => n.includes("summary"),
		);
		expect(names).toContain("resync");
		expect(names).not.toContain("rows");
		expect(liveChain(await summaryOf(port))).toEqual(freshChain(root));
	});

	it("guard: a line the load caught half-written is re-read in full once it completes: valid, as a fresh load", async () => {
		const { line, meta } = await writerNext();
		const half = Math.floor(line.length / 2);
		appendFileSync(log, line.slice(0, half));
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		const names = await readFrames(
			port,
			() => {
				writeFileSync(`${log}.meta`, meta);
				appendFileSync(log, line.slice(half));
			},
			(n) => n.includes("summary"),
		);
		expect(names).toContain("resync");
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 4, valid: true });
		expect(live).toEqual(freshChain(root));
	});

	it("guard: a fragment and a chained line arriving in ONE append after a clean load is a full reload, as a fresh load", async () => {
		ui = await createUiServer(root, { port: 0 });
		const line = nextLine();
		const port = ui.port;
		const names = await readFrames(
			port,
			() => appendFileSync(log, `{"id":"died-mid-line"${line}`),
			(n) => n.includes("summary"),
		);
		expect(names).toContain("resync");
		expect(names).not.toContain("rows");
		expect(liveChain(await summaryOf(port))).toEqual(freshChain(root));
	});

	it("guard: an idle dead fragment costs nothing: no frame and no read of the log over several checks", async () => {
		appendFileSync(log, '{"id":"died-mid-line"');
		ui = await createUiServer(root, { port: 0 });
		io.logBytes = 0;
		const names = await readFrames(
			ui.port,
			() => pokeWatcher(5),
			() => false,
			500,
		);
		expect(names).toEqual([]);
		expect(io.logBytes).toBe(0);
	});

	it("an identity that cannot be compared (inode 0) makes every append a full reload, never an extension", async () => {
		io.zeroInode = true;
		ui = await createUiServer(root, { port: 0 });
		const { line, meta } = await writerNext();
		const port = ui.port;
		const names = await readFrames(
			port,
			() => {
				writeFileSync(`${log}.meta`, meta);
				appendFileSync(log, line);
			},
			(n) => n.includes("summary"),
		);
		expect(names).toContain("resync");
		expect(names).not.toContain("rows");
		expect(liveChain(await summaryOf(port))).toMatchObject({ events: 4, valid: true });
	});

	it("a rename during the start-up load is redone on the file now at the path: an append after it agrees with a fresh load", async () => {
		const text = readFileSync(log, "utf-8");
		const lines = (text + chainedAfter(text, "tx_next")).split("\n");
		lines[0] = (lines[0] as string).replace('"cost":5', '"cost":9');
		const tampered = join(vault, "audit", "tampered.tmp");
		writeFileSync(tampered, lines.join("\n"));
		let renamed = false;
		loadSeam.afterReaders = () => {
			if (renamed) return;
			renamed = true;
			renameSync(tampered, log);
		};
		try {
			ui = await createUiServer(root, { port: 0 });
		} finally {
			loadSeam.afterReaders = undefined;
		}
		expect(renamed).toBe(true);
		const port = ui.port;
		expect(liveChain(await summaryOf(port))).toEqual(freshChain(root));
		const line = nextLine();
		await readFrames(
			port,
			() => appendFileSync(log, line),
			(n) => n.includes("summary"),
		);
		// The extension keeps the load's anchor messages (they name the count at load), so the verdict fields are compared.
		const { events, valid, breakIndex } = liveChain(await summaryOf(port));
		const fresh = freshChain(root);
		expect({ events, valid, breakIndex }).toEqual({
			events: fresh.events,
			valid: fresh.valid,
			breakIndex: fresh.breakIndex,
		});
		expect({ events, valid, breakIndex }).toMatchObject({ events: 5, valid: false, breakIndex: 0 });
	});
});

// A log replaced by another file of the SAME size, with nothing written after it, changes no size: the watcher must
// compare the log's identity, or the replacement never reaches the identity check and the old verdict stays.
describe("a same-size replacement under a running dashboard", { timeout: 30_000 }, () => {
	let root: string;
	let vault: string;
	let log: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-range-same-"));
		vault = join(root, ".usertrust");
		log = join(vault, "audit", "events.jsonl");
		io.zeroInode = false;
	});
	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	/** A copy of the log with event 1's cost changed from 5 to 9: the same length, and no extra event. */
	function sameSizeTampered(): string {
		const text = readFileSync(log, "utf-8");
		const lines = text.split("\n");
		lines[0] = (lines[0] as string).replace('"cost":5', '"cost":9');
		const out = lines.join("\n");
		expect(out).not.toBe(text);
		expect(Buffer.byteLength(out)).toBe(Buffer.byteLength(text));
		const tampered = join(vault, "audit", "tampered.tmp");
		writeFileSync(tampered, out);
		return tampered;
	}

	async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await pred()) return true;
			await sleep(100);
		}
		return pred();
	}

	it("red-first (false clean, fs.watch): a same-size tampered copy renamed over the log reads invalid, as a fresh load does", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect((await summaryOf(port)).chain).toMatchObject({ events: 3, valid: true });
		const tampered = sameSizeTampered();
		renameSync(tampered, log);
		const invalid = await waitFor(async () => !(await summaryOf(port)).chain.valid, 5000);
		expect(invalid).toBe(true);
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 3, valid: false });
		expect(live).toEqual(freshChain(root));
	});

	it("red-first (false clean, polling): the same replacement reads invalid when the directory was absent at start", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		await appendEvents(root, 3, "tx");
		const loaded = await waitFor(async () => (await summaryOf(port)).chain.events === 3, 5000);
		expect(loaded).toBe(true);
		expect((await summaryOf(port)).chain).toMatchObject({ events: 3, valid: true });
		// Two poll intervals with the log in place, so the next change is seen by a check, not by the appearance.
		await sleep(2200);
		const tampered = sameSizeTampered();
		renameSync(tampered, log);
		const invalid = await waitFor(async () => !(await summaryOf(port)).chain.valid, 5000);
		expect(invalid).toBe(true);
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 3, valid: false });
		expect(live).toEqual(freshChain(root));
	});

	it("guard: an unchanged log over several checks delivers no resync", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		io.logBytes = 0;
		const names = await readFrames(
			ui.port,
			async () => {
				for (let i = 0; i < 5; i++) {
					writeFileSync(join(vault, "audit", "poke.txt"), String(i));
					await sleep(450);
				}
			},
			() => false,
			500,
		);
		expect(names).toEqual([]);
		expect(io.logBytes).toBe(0);
	});

	it("guard: a normal append is rows, not resync (the identity is unchanged)", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		const names = await readFrames(
			port,
			() => appendEvents(root, 1, "tx_more"),
			(n) => n.includes("rows"),
		);
		expect(names).toContain("rows");
		expect(names).not.toContain("resync");
		expect(liveChain(await summaryOf(port))).toMatchObject({ events: 4, valid: true });
	});
});

// On a file system without stable inode numbers (every file reports inode 0) the log has no identity, so a same-size
// replacement changes nothing the watcher compared: it is noticed by the log's mtime and ctime instead, once they differ
// from the ones the last load or grow recorded on two consecutive checks.
describe("a same-size replacement without stable inode numbers", { timeout: 30_000 }, () => {
	let root: string;
	let vault: string;
	let log: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-range-noino-"));
		vault = join(root, ".usertrust");
		log = join(vault, "audit", "events.jsonl");
		io.zeroInode = true;
	});
	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		io.zeroInode = false;
		rmSync(root, { recursive: true, force: true });
	});

	async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await pred()) return true;
			await sleep(100);
		}
		return pred();
	}

	it("red-first (false clean): a same-size tampered copy renamed over the log reads invalid within the bound, as a fresh load does", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect((await summaryOf(port)).chain).toMatchObject({ events: 3, valid: true });
		const text = readFileSync(log, "utf-8");
		const tampered = text.replace('"cost":5', '"cost":9');
		expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(text));
		writeFileSync(join(vault, "audit", "tampered.tmp"), tampered);
		// An explicit, distinct mtime: written within one tick of a coarse file-system clock, the copy would carry the
		// mtime (and ctime) the load recorded, and inode 0 leaves the watcher nothing else to see the replacement by.
		const loaded = statSync(log).mtimeMs;
		utimesSync(join(vault, "audit", "tampered.tmp"), new Date(), new Date(loaded + 5000));
		renameSync(join(vault, "audit", "tampered.tmp"), log);
		const invalid = await waitFor(async () => !(await summaryOf(port)).chain.valid, 5000);
		expect(invalid).toBe(true);
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 3, valid: false });
		expect(live).toEqual(freshChain(root));
	});

	it("guard: an unchanged log over several checks delivers no resync", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const names = await readFrames(
			ui.port,
			async () => {
				for (let i = 0; i < 5; i++) {
					writeFileSync(join(vault, "audit", "poke.txt"), String(i));
					await sleep(450);
				}
			},
			() => false,
			500,
		);
		expect(names).toEqual([]);
	});

	describe("at the watcher", () => {
		const original = { ...__tailTestSeam };
		class StubWatcher extends EventEmitter {
			close(): void {}
		}

		beforeEach(() => {
			vi.useFakeTimers();
			__tailTestSeam.watch = (() => new StubWatcher()) as unknown as typeof __tailTestSeam.watch;
			__tailTestSeam.backstopMs = 1000;
		});
		afterEach(() => {
			vi.useRealTimers();
			Object.assign(__tailTestSeam, original);
		});

		/** The watcher over a three-byte log, given what a load under inode 0 records: no identity, and the timestamps. */
		function start() {
			mkdirSync(join(vault, "audit"), { recursive: true });
			writeFileSync(log, "{}\n");
			const st = statSync(log, { bigint: true });
			expect(fileIdentity(st)).toBeUndefined();
			const times = { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
			const delivered: string[] = [];
			const stop = watchLedger(
				vault,
				() => 3,
				{ onGrow: () => delivered.push("grow"), onResync: () => delivered.push("resync") },
				() => fileIdentity(statSync(log, { bigint: true })),
				undefined,
				() => times,
			);
			return { delivered, stop };
		}

		it("red-first (false clean): new timestamps at the same size on two consecutive checks resync once", () => {
			const w = start();
			try {
				vi.advanceTimersByTime(2000);
				expect(w.delivered).toEqual([]);
				utimesSync(log, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
				vi.advanceTimersByTime(1000);
				expect(w.delivered).toEqual([]);
				vi.advanceTimersByTime(1000);
				expect(w.delivered).toEqual(["resync"]);
			} finally {
				w.stop();
			}
		});

		it("guard: an append seen with new timestamps but the old size is a grow once the size catches up, never a resync", () => {
			const w = start();
			try {
				vi.advanceTimersByTime(2000);
				// The first half of an append, as some systems show it: timestamps moved, size not yet.
				utimesSync(log, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
				vi.advanceTimersByTime(1000);
				expect(w.delivered).toEqual([]);
				appendFileSync(log, "{}\n");
				vi.advanceTimersByTime(3000);
				expect(w.delivered).toEqual(["grow"]);
			} finally {
				w.stop();
			}
		});

		it("guard: an unchanged log over several checks delivers nothing", () => {
			const w = start();
			try {
				vi.advanceTimersByTime(10_000);
				expect(w.delivered).toEqual([]);
			} finally {
				w.stop();
			}
		});
	});
});

// An earlier event rewritten IN PLACE one byte longer keeps the log's inode and grows it by one byte, every later byte
// shifted by one. The grow path reads only the bytes after the offset (the shifted final newline), which hold no new
// line, so before each extension it re-reads the last line it verified: moved or changed, the grow is a full reload.
// The bound is 10 s, far inside the five-minute re-read, which these rows never reach.
describe("an earlier event rewritten in place under a running dashboard", {
	timeout: 30_000,
}, () => {
	let root: string;
	let vault: string;
	let log: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "trust-range-inplace-"));
		vault = join(root, ".usertrust");
		log = join(vault, "audit", "events.jsonl");
		io.zeroInode = false;
		await appendEvents(root, 3, "tx");
	});
	afterEach(async () => {
		appendSeam.afterStat = undefined;
		await ui?.close();
		ui = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await pred()) return true;
			await sleep(100);
		}
		return pred();
	}

	/** Rewrites the log through its own inode (no rename, no truncate to 0): in event 1, `from` becomes `to`. */
	function rewriteFirstInPlace(from: string, to: string): void {
		const text = readFileSync(log, "utf-8");
		const lines = text.split("\n");
		expect(lines[0]).toContain(from);
		lines[0] = (lines[0] as string).replace(from, to);
		const out = Buffer.from(lines.join("\n"));
		const id = fileIdentity(statSync(log, { bigint: true }));
		const fd = openSync(log, "r+");
		try {
			writeSync(fd, out, 0, out.length, 0);
			ftruncateSync(fd, out.length);
		} finally {
			closeSync(fd);
		}
		expect(fileIdentity(statSync(log, { bigint: true }))).toBe(id);
	}

	/** The byte length of the range the grow re-checks: the log's last line with the newline before it. */
	function lastLineRangeBytes(text: string): number {
		const body = text.slice(0, -1);
		return Buffer.byteLength(text) - Buffer.byteLength(body.slice(0, body.lastIndexOf("\n")));
	}

	it("red-first (false clean): event 1 rewritten in place one byte LONGER reads invalid on the next check, as a fresh load does", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect((await summaryOf(port)).chain).toMatchObject({ events: 3, valid: true });
		const before = statSync(log).size;
		rewriteFirstInPlace('"cost":5', '"cost":59');
		expect(statSync(log).size).toBe(before + 1);
		const invalid = await waitFor(async () => !(await summaryOf(port)).chain.valid, 10_000);
		expect(invalid).toBe(true);
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 3, valid: false });
		expect(live).toEqual(freshChain(root));
	});

	it("guard: event 1 rewritten in place one byte SHORTER is a shrink, a full reload: invalid at once", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect((await summaryOf(port)).chain).toMatchObject({ events: 3, valid: true });
		const before = statSync(log).size;
		rewriteFirstInPlace('"settled":true', '"settled":"t"');
		expect(statSync(log).size).toBe(before - 1);
		const invalid = await waitFor(async () => !(await summaryOf(port)).chain.valid, 10_000);
		expect(invalid).toBe(true);
		expect(liveChain(await summaryOf(port))).toEqual(freshChain(root));
	});

	it("guard: an honest append stays incremental, and its grow reads the new bytes plus the one re-checked line", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		const text = readFileSync(log, "utf-8");
		const line = chainedAfter(text, "tx_next");
		const recheck = lastLineRangeBytes(text);
		io.logBytes = 0;
		const names = await readFrames(
			port,
			() => appendFileSync(log, line),
			(n) => n.includes("rows"),
		);
		expect(names).toContain("rows");
		expect(names).not.toContain("resync");
		// Exactly the appended line and the re-checked range, never the log.
		expect(io.logBytes).toBe(Buffer.byteLength(line) + recheck);
		expect(io.logBytes).toBeLessThan(Buffer.byteLength(text));
		expect(liveChain(await summaryOf(port))).toMatchObject({ events: 4, valid: true });
		// The next append re-checks the line the first one added.
		const next = chainedAfter(text + line, "tx_after");
		io.logBytes = 0;
		const more = await readFrames(
			port,
			() => appendFileSync(log, next),
			(n) => n.includes("rows"),
		);
		expect(more).not.toContain("resync");
		expect(io.logBytes).toBe(Buffer.byteLength(next) + Buffer.byteLength(line) + 1);
		// Not compared with a fresh load: these lines are appended by hand, without the writer's anchor.
		expect(liveChain(await summaryOf(port))).toMatchObject({ events: 5, valid: true });
	});

	it("guard: an append landing between the grow's stat and its re-check is a later grow: both rows, valid, no reload", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		const text = readFileSync(log, "utf-8");
		const first = chainedAfter(text, "tx_one");
		const second = chainedAfter(text + first, "tx_two");
		let landed = 0;
		appendSeam.afterStat = () => {
			if (landed > 0) return;
			landed += 1;
			appendFileSync(log, second);
		};
		const names = await readFrames(
			port,
			() => appendFileSync(log, first),
			(n) => n.filter((x) => x === "rows").length >= 2,
			8000,
		);
		expect(landed).toBe(1);
		expect(names.filter((x) => x === "rows")).toHaveLength(2);
		expect(names).not.toContain("resync");
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 5, valid: true, errors: [] });
	});
});

// An anchor written beside no log changes nothing about the log: while the known size is 0 the watcher compares the
// anchor's presence, identity and ctime with what the last full load saw, and a change is a full reload.
describe("an anchor written beside an empty log", { timeout: 30_000 }, () => {
	let root: string;
	let vault: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;
	let passes = 0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-range-anchor-"));
		vault = join(root, ".usertrust");
		mkdirSync(join(vault, "audit"), { recursive: true });
		io.zeroInode = false;
		passes = 0;
		loadSeam.afterPass = () => {
			passes += 1;
		};
	});
	afterEach(async () => {
		loadSeam.afterPass = undefined;
		await ui?.close();
		ui = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await pred()) return true;
			await sleep(100);
		}
		return pred();
	}

	it("red-first (false clean): an anchor recording 5 events written into an empty audit directory reads red on the next check", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect((await summaryOf(port)).chain).toMatchObject({ events: 0, valid: true });
		// As the writer writes it: a temporary file, renamed into place.
		const meta = join(vault, "audit", "events.jsonl.meta");
		writeFileSync(`${meta}.tmp`, JSON.stringify({ lastHash: "a".repeat(64), sequence: 5 }));
		renameSync(`${meta}.tmp`, meta);
		const red = await waitFor(async () => !(await summaryOf(port)).chain.valid, 10_000);
		expect(red).toBe(true);
		const live = liveChain(await summaryOf(port));
		expect(live.errors.join("\n")).toContain("anchor records 5 event(s)");
		expect(live).toEqual(freshChain(root));
	});

	it("guard: a normal first append into the empty directory reads valid, with one full reload for it", async () => {
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		const startup = passes;
		const names = await readFrames(
			port,
			async () => {
				await appendEvents(root, 1, "tx_first");
				// Room for the anchor's own events, and two backstop ticks after it.
				await sleep(2500);
			},
			() => false,
			3000,
		);
		// Counted before `freshChain`, which loads the vault itself.
		const served = passes - startup;
		const live = liveChain(await summaryOf(port));
		expect(live).toMatchObject({ events: 1, valid: true });
		expect(live).toEqual(freshChain(root));
		// The first append is a full reload (a load that saw no log bytes is never extended): one load pass and one resync,
		// not one more for the anchor the writer renames into place after the log.
		expect(names.filter((x) => x === "resync")).toHaveLength(1);
		expect(served).toBe(1);
	});
});
