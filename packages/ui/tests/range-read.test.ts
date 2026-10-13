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
	cpSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} = await import("node:fs");
const { canonicalize } = await import("usertrust-verify");
const { createAuditWriter } = await import("../../core/src/audit/chain.js");
const { createUiServer } = await import("../src/server/server.js");
const { loadSeam, loadState, readAppended } = await import("../src/server/state.js");

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
		loadSeam.afterReaders = () => {
			n += 1;
			// The same bytes rewritten: a new mtime, so the path no longer matches what the descriptor saw.
			writeFileSync(log, readFileSync(log));
		};
		const unsettled = loadState(vault);
		expect(n).toBe(4);
		expect(unsettled.logId).toBeUndefined();
		loadSeam.afterReaders = undefined;
		const settled = loadState(vault);
		expect(settled.logId).toBeDefined();
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
