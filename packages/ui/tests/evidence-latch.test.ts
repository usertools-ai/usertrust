// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Evidence the dashboard has read stays reported when it is taken away. Two latches feed the deletion verdict: the audit
// directory's identity (another directory swapped in between two checks, or one that held no log bytes deleted), and the
// events the dashboard held (a log that no longer holds them was truncated, emptied or replaced by another chain). Each
// is latched until a restart, whatever the vault holds afterwards.

import { createHash } from "node:crypto";
import type * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	/** Called once, right after the next listing of a directory whose path ends with this suffix, then cleared. */
	afterListing: undefined as { suffix: string; run: () => void } | undefined,
}));

// A pass-through `node:fs`: only `readdirSync` is wrapped, so a row can change the vault between a reader's listing of
// the audit directory and its reads of the files it listed.
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const wrapped = {
		...real,
		readdirSync: ((p: realFs.PathLike, ...rest: unknown[]) => {
			const out = (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
			const hook = io.afterListing;
			if (hook !== undefined && String(p).endsWith(hook.suffix)) {
				io.afterListing = undefined;
				hook.run();
			}
			return out;
		}) as typeof real.readdirSync,
	};
	return { ...wrapped, default: wrapped };
});

const {
	appendFileSync,
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} = await import("node:fs");
const { canonicalize } = await import("usertrust-verify");
const { createAuditWriter } = await import("../../core/src/audit/chain.js");
const { createUiServer } = await import("../src/server/server.js");
const { loadSeam, loadState } = await import("../src/server/state.js");

type Chain = { events: number; valid: boolean; empty: boolean; errors: string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chainOf(port: number): Promise<Chain> {
	return ((await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()) as { chain: Chain })
		.chain;
}

async function chainWhen(port: number, done: (c: Chain) => boolean, ms = 6000): Promise<Chain> {
	const deadline = Date.now() + ms;
	let last = await chainOf(port);
	while (!done(last) && Date.now() < deadline) {
		await sleep(100);
		last = await chainOf(port);
	}
	return last;
}

async function appendEvents(root: string, count: number, prefix: string): Promise<void> {
	const writer = createAuditWriter(root);
	for (let i = 0; i < count; i++) {
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 1, settled: true, transferId: `${prefix}_${i}` },
		});
	}
	writer.release();
}

/** The SSE event names delivered while `act` runs, until `until` holds or the time runs out. */
async function framesDuring(
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

const DIRECTORY_ERROR =
	"The audit directory was replaced or deleted while this dashboard was open (deletion detected). If you restored or replaced this vault on purpose, restart the dashboard.";
const EVENTS_ERROR =
	"The audit log lost or changed events it held while this dashboard was open (deletion detected). If you restored or replaced this vault on purpose, restart the dashboard.";
const isDeletion = (c: Chain): boolean =>
	!c.valid && c.errors.some((e) => e.includes("deletion detected"));

/** Reads the summary for `ms` and returns every chain seen: a row asserts that none of them reads valid. */
async function chainsFor(port: number, ms: number): Promise<Chain[]> {
	const seen: Chain[] = [];
	const until = Date.now() + ms;
	while (Date.now() < until) {
		seen.push(await chainOf(port));
		await sleep(100);
	}
	return seen;
}

describe("the audit directory replaced or deleted under an open dashboard", {
	timeout: 30_000,
}, () => {
	let root: string;
	let stage: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;
	const auditDir = (): string => join(root, ".usertrust", "audit");

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-latch-dir-"));
		stage = mkdtempSync(join(tmpdir(), "trust-latch-dir-stage-"));
	});
	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(root, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
	});

	/**
	 * Replaces the audit directory in one step, inside one turn of the event loop so no check can land between the two
	 * halves: the old one removed, and a fresh valid vault, built elsewhere, renamed into its place.
	 */
	async function replaceInOneStep(): Promise<void> {
		await appendEvents(stage, 2, "tx_fresh");
		rmSync(auditDir(), { recursive: true, force: true });
		renameSync(join(stage, ".usertrust", "audit"), auditDir());
	}

	/** After the replacement: the deletion is read, and stays through a later valid write and a reload. */
	async function expectLatched(port: number, reload: () => void): Promise<void> {
		const observed = await chainWhen(port, isDeletion);
		expect(observed.errors).toContain(DIRECTORY_ERROR);
		await appendEvents(root, 1, "tx_after");
		const seen = await chainsFor(port, 2500);
		expect(seen.filter((c) => c.valid)).toEqual([]);
		expect(seen.filter((c) => !c.errors.includes(DIRECTORY_ERROR))).toEqual([]);
		reload();
		const after = await chainOf(port);
		expect(after.events).toBe(3);
		expect(after.valid).toBe(false);
		expect(after.errors.filter((e) => e.includes("deletion detected"))).toEqual([DIRECTORY_ERROR]);
	}

	it("red-first (false clean): from a PRESENT start, a directory replaced in one step reads as a deletion, and stays one", async () => {
		await appendEvents(root, 3, "tx_first");
		ui = await createUiServer(root, { port: 0 });
		expect(await chainOf(ui.port)).toMatchObject({ events: 3, valid: true });
		await replaceInOneStep();
		const server = ui;
		await expectLatched(ui.port, () => server.reload());
	});

	it("red-first (false clean): from an ABSENT start, once the directory appears and loads, a replacement in one step reads as a deletion", async () => {
		const first = mkdtempSync(join(tmpdir(), "trust-latch-dir-first-"));
		try {
			await appendEvents(first, 3, "tx_first");
			ui = await createUiServer(root, { port: 0 });
			expect(await chainOf(ui.port)).toMatchObject({ events: 0, valid: true, empty: true });
			renameSync(join(first, ".usertrust"), join(root, ".usertrust"));
			const appeared = await chainWhen(ui.port, (c) => c.events === 3);
			expect(appeared).toMatchObject({ events: 3, valid: true });
			// Two poll intervals with the directory in place, so the replacement is seen by a check, not as an appearance.
			await sleep(2200);
			await replaceInOneStep();
			const server = ui;
			await expectLatched(ui.port, () => server.reload());
		} finally {
			rmSync(first, { recursive: true, force: true });
		}
	});

	it("red-first (deletion read as a first run): fs.watch mode, a directory present at start with no log bytes, deleted, reads as a deletion", async () => {
		mkdirSync(auditDir(), { recursive: true });
		ui = await createUiServer(root, { port: 0 });
		expect(await chainOf(ui.port)).toMatchObject({ events: 0, valid: true, empty: true });
		rmSync(auditDir(), { recursive: true, force: true });
		const observed = await chainWhen(ui.port, isDeletion);
		expect(observed.errors).toContain(DIRECTORY_ERROR);
		expect(observed.empty).toBe(false);
	});

	it("guard: a first run reads as no governed calls yet, and so does a vault that never held an event", async () => {
		ui = await createUiServer(root, { port: 0 });
		ui.reload();
		expect(await chainOf(ui.port)).toMatchObject({
			events: 0,
			valid: true,
			empty: true,
			errors: [],
		});
		mkdirSync(auditDir(), { recursive: true });
		await sleep(1500);
		ui.reload();
		expect(await chainOf(ui.port)).toMatchObject({ events: 0, valid: true, empty: true });
		expect((await chainOf(ui.port)).errors.filter((e) => e.includes("deletion detected"))).toEqual(
			[],
		);
	});
});

/** One event line, chained after `previousHash`, as the writer persists it; `sequence` left out when undefined. */
function eventLine(
	previousHash: string,
	transferId: string,
	sequence?: number,
): {
	line: string;
	hash: string;
} {
	const rest: Record<string, unknown> = {
		actor: "local",
		data: { cost: 1, settled: true, transferId },
		id: `${transferId}-id`,
		kind: "llm_call",
		previousHash,
		timestamp: new Date().toISOString(),
	};
	if (sequence !== undefined) rest.sequence = sequence;
	const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
	return { line: `${canonicalize({ ...rest, hash })}\n`, hash };
}

describe("a log that loses or changes events the dashboard held", { timeout: 30_000 }, () => {
	let root: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;
	const auditDir = (): string => join(root, ".usertrust", "audit");
	const log = (): string => join(auditDir(), "events.jsonl");

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-latch-head-"));
	});
	afterEach(async () => {
		loadSeam.afterDescriptor = undefined;
		loadSeam.afterReaders = undefined;
		loadSeam.afterPass = undefined;
		io.afterListing = undefined;
		await ui?.close();
		ui = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("red-first (no governed calls yet): the log and its anchor removed, the directory left, reads as a deletion", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		expect(await chainOf(ui.port)).toMatchObject({ events: 3, valid: true });
		rmSync(`${log()}.meta`);
		rmSync(log());
		const observed = await chainWhen(ui.port, isDeletion);
		expect(observed).toMatchObject({ events: 0, valid: false, empty: false });
		expect(observed.errors).toContain(EVENTS_ERROR);
		// The directory stayed, so only the events cause is named.
		expect(observed.errors).not.toContain(DIRECTORY_ERROR);
		await appendEvents(root, 2, "tx_again");
		const seen = await chainsFor(ui.port, 2000);
		expect(seen.filter((c) => c.valid)).toEqual([]);
	});

	it("red-first (false clean): a BROKEN chain replaced by a fresh valid one reads as a deletion, never verified", async () => {
		await appendEvents(root, 3, "tx");
		// Event 1's cost changed in place: the chain is broken from the start.
		const text = readFileSync(log(), "utf-8");
		writeFileSync(log(), text.replace('"cost":1', '"cost":7'));
		ui = await createUiServer(root, { port: 0 });
		expect(await chainOf(ui.port)).toMatchObject({ events: 3, valid: false });
		// A fresh valid chain of another three events, with its anchor, put in the log's place by rename.
		const stage = mkdtempSync(join(tmpdir(), "trust-latch-head-stage-"));
		try {
			await appendEvents(stage, 3, "tx_other");
			const staged = join(stage, ".usertrust", "audit", "events.jsonl");
			cpSync(`${staged}.meta`, `${log()}.meta`);
			renameSync(staged, log());
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
		const observed = await chainWhen(ui.port, isDeletion);
		expect(observed.events).toBe(3);
		expect(observed.valid).toBe(false);
		expect(observed.errors).toContain(EVENTS_ERROR);
		// A fresh load of the same vault, with no memory, reads it valid: the latch is what keeps it red.
		expect(loadState(join(root, ".usertrust")).summary.chain.valid).toBe(true);
	});

	it("guard: a ROTATION in file order (events without sequence, the newest moved into a segment) is not a deletion", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const genesis = "0".repeat(64);
		const e1 = eventLine(genesis, "tx_1");
		const e2 = eventLine(e1.hash, "tx_2");
		const e3 = eventLine(e2.hash, "tx_3");
		writeFileSync(log(), e1.line + e2.line + e3.line);
		ui = await createUiServer(root, { port: 0 });
		expect((await chainOf(ui.port)).events).toBe(3);
		// Rotated: the three events, the newest included, moved into a segment, and the log continues with a fourth. The
		// readers put `events.jsonl` first in file order, so the fourth is read before the first three: every held event
		// is still there, at another position.
		writeFileSync(join(auditDir(), "events.0001.jsonl"), e1.line + e2.line + e3.line);
		writeFileSync(log(), eventLine(e3.hash, "tx_4").line);
		const rotated = await chainWhen(ui.port, (c) => c.events === 4);
		expect(rotated.events).toBe(4);
		const seen = await chainsFor(ui.port, 1500);
		expect(seen.filter((c) => c.errors.some((e) => e.includes("deletion detected")))).toEqual([]);
	});

	it("guard: a load racing a rotation written in two steps (a segment, then events.jsonl) latches nothing", async () => {
		await appendEvents(root, 3, "tx");
		const vault = join(root, ".usertrust");
		const before = loadState(vault);
		expect(before.head).toMatchObject({ count: 3 });
		const held = before.head;
		// The rotation's two steps, as a writer would make them: the log's events copied into a segment, then the log
		// rewritten with only the next event.
		const text = readFileSync(log(), "utf-8");
		const last = JSON.parse(text.trim().split("\n").at(-1) as string) as {
			hash: string;
			sequence: number;
		};
		const next = eventLine(last.hash, "tx_next", last.sequence + 1).line;
		let raced = 0;
		loadSeam.afterDescriptor = () => {
			if (raced > 0) return;
			raced += 1;
			// The first pass's readers list the directory before the segment exists, and read the log after it was
			// rewritten: that read holds one event of the three, a containment failure that never happened.
			io.afterListing = {
				suffix: "audit",
				run: () => {
					writeFileSync(join(vault, "audit", "events.0001.jsonl"), text);
					writeFileSync(log(), next);
				},
			};
		};
		const state = loadState(vault, undefined, true, [], before.auditDirId, held);
		expect(raced).toBe(1);
		expect(existsSync(join(vault, "audit", "events.0001.jsonl"))).toBe(true);
		expect(state.deletionDetected).toBe(false);
		expect(state.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		expect(state.summary.chain.events).toBe(4);
	});

	it("red-first (latched deletion): a segment listed by the reader and removed before it read it is an inconsistent pass, read again, never an empty read of it", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const genesis = "0".repeat(64);
		const e1 = eventLine(genesis, "tx_1");
		const e2 = eventLine(e1.hash, "tx_2");
		const e3 = eventLine(e2.hash, "tx_3");
		const segment = join(auditDir(), "events.0001.jsonl");
		writeFileSync(segment, e1.line + e2.line + e3.line);
		writeFileSync(log(), eventLine(e3.hash, "tx_4").line);
		const vault = join(root, ".usertrust");
		const before = loadState(vault);
		expect(before.head).toMatchObject({ count: 4 });
		const aside = join(root, "aside.jsonl");
		const passes: { consistent: boolean; readSucceeded: boolean; contained: boolean }[] = [];
		loadSeam.afterDescriptor = () => {
			if (passes.length > 0) return;
			// The first pass's reader lists the segment, then finds it gone (ENOENT, which it reads as absence).
			io.afterListing = { suffix: "audit", run: () => renameSync(segment, aside) };
		};
		loadSeam.afterPass = (pass) => {
			passes.push(pass);
			// Put back, the same file, before the next pass begins: that pass reads the vault whole.
			if (passes.length === 1) renameSync(aside, segment);
		};
		const state = loadState(vault, undefined, true, [], before.auditDirId, before.head);
		// The first pass read three events fewer than the head, and is not judged on them: the segment it listed went
		// before it was read, so the pass did not read one unchanged set of files.
		expect(passes).toEqual([
			{ consistent: false, readSucceeded: true, contained: false },
			{ consistent: true, readSucceeded: true, contained: true },
		]);
		expect(state.deletionCauses).toEqual([]);
		expect(state.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		expect(state.summary.chain.events).toBe(4);
		expect(state.head).toEqual(before.head);
	});

	it("guard: a normal append stays incremental (rows, no resync), and a reload after it holds every event", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		for (const prefix of ["tx_a", "tx_b"]) {
			const names = await framesDuring(
				port,
				() => appendEvents(root, 1, prefix),
				(n) => n.includes("rows"),
			);
			expect(names).toContain("rows");
			expect(names).not.toContain("resync");
		}
		ui.reload();
		const after = await chainOf(port);
		expect(after).toMatchObject({ events: 5, valid: true });
		expect(after.errors).toEqual([]);
	});

	it("guard: an append that grows the log is not mistaken for lost events when the dashboard reloads", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		// Appended by hand with no anchor update, then a reload: the count only grew and the head is still there.
		const text = readFileSync(log(), "utf-8");
		const last = JSON.parse(text.trim().split("\n").at(-1) as string) as {
			hash: string;
			sequence: number;
		};
		appendFileSync(log(), eventLine(last.hash, "tx_more", last.sequence + 1).line);
		await chainWhen(ui.port, (c) => c.events === 4);
		ui.reload();
		const after = await chainOf(ui.port);
		expect(after.events).toBe(4);
		expect(after.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		expect(statSync(log()).size).toBeGreaterThan(text.length);
	});
});

describe("an audit directory or log that could not be read, then could again", {
	timeout: 30_000,
}, () => {
	let root: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;
	/** Paths whose mode a row changed, restored before the vault is removed (a mode-000 directory cannot be emptied). */
	let restore: { path: string; mode: number }[] = [];
	const auditDir = (): string => join(root, ".usertrust", "audit");
	const log = (): string => join(auditDir(), "events.jsonl");
	const asRoot = process.getuid?.() === 0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-latch-unread-"));
	});
	afterEach(async () => {
		for (const { path, mode } of restore.reverse()) {
			try {
				chmodSync(path, mode);
			} catch {
				// Already removed: nothing to restore.
			}
		}
		restore = [];
		loadSeam.afterDescriptor = undefined;
		loadSeam.afterReaders = undefined;
		loadSeam.afterPass = undefined;
		await ui?.close();
		ui = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	function chmodFor(path: string, mode: number): void {
		restore.push({ path, mode: statSync(path).mode & 0o777 });
		chmodSync(path, mode);
	}

	const unreadable = (c: Chain): boolean =>
		!c.valid && c.events === 0 && !c.errors.some((e) => e.includes("deletion detected"));
	const healed = (c: Chain): boolean => c.valid && c.events === 3 && c.errors.length === 0;

	/**
	 * The vault made unreadable by `lock`, then readable again by `unlock`: it heals, equal to a fresh load. `reload`
	 * forces a load after each change, for a change the watcher does not notice on its own.
	 */
	async function expectHeals(lock: () => void, unlock: () => void, reload = false): Promise<void> {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		expect(await chainOf(ui.port)).toMatchObject({ events: 3, valid: true });
		lock();
		if (reload) ui.reload();
		const during = await chainWhen(ui.port, unreadable);
		expect(during.valid).toBe(false);
		expect(during.events).toBe(0);
		// Two backstop intervals unreadable, so a confirming read has every chance to latch.
		await sleep(2200);
		unlock();
		if (reload) ui.reload();
		const after = await chainWhen(ui.port, healed);
		const fresh = loadState(join(root, ".usertrust")).summary.chain;
		expect(fresh).toMatchObject({ events: 3, valid: true, errors: [] });
		expect(after).toMatchObject({ events: fresh.events, valid: fresh.valid, errors: fresh.errors });
		ui.reload();
		expect(await chainOf(ui.port)).toMatchObject({ events: 3, valid: true, errors: [] });
	}

	it.skipIf(asRoot)(
		"red-first (latched deletion): an audit directory made unlistable and then listable again heals, no deletion",
		async () => {
			await expectHeals(
				() => chmodFor(auditDir(), 0o000),
				() => chmodSync(auditDir(), 0o700),
			);
		},
	);

	it.skipIf(asRoot)(
		"red-first (latched deletion): a log made unreadable and then readable again heals, no deletion",
		async () => {
			// A mode change alone moves neither the log's size nor its mtime, so the watcher does not reload on it: each
			// phase is read by a forced reload (what a later append, or any other resync, would do).
			await expectHeals(
				() => chmodFor(log(), 0o000),
				() => chmodSync(log(), 0o600),
				true,
			);
		},
	);

	it.skipIf(asRoot)(
		"guard: the head kept through an unreadable spell still holds: the log and its anchor removed afterwards read as a deletion of events",
		async () => {
			await expectHeals(
				() => chmodFor(auditDir(), 0o000),
				() => chmodSync(auditDir(), 0o700),
			);
			const port = (ui as NonNullable<typeof ui>).port;
			rmSync(`${log()}.meta`);
			rmSync(log());
			const observed = await chainWhen(port, isDeletion);
			expect(observed.errors).toContain(EVENTS_ERROR);
			expect(observed.errors).not.toContain(DIRECTORY_ERROR);
		},
	);

	it.skipIf(asRoot)(
		"guard: an unlistable audit directory (its stat still succeeds) is never read as a replaced or deleted directory",
		async () => {
			await appendEvents(root, 3, "tx");
			ui = await createUiServer(root, { port: 0 });
			chmodFor(auditDir(), 0o000);
			const seen = await chainsFor(ui.port, 2500);
			expect(seen.filter((c) => c.errors.includes(DIRECTORY_ERROR))).toEqual([]);
			expect(seen.at(-1)?.valid).toBe(false);
		},
	);
	it.skipIf(asRoot)(
		"guard: a load whose reads fail DIFFERENTLY on its passes (the directory unlistable, then the log unreadable) latches nothing and keeps the head",
		async () => {
			await appendEvents(root, 3, "tx");
			const vault = join(root, ".usertrust");
			const before = loadState(vault);
			expect(before.head).toMatchObject({ count: 3 });
			const held = before.head;
			// Each pass's readers fail, each in its own way: the first finds the audit directory unlistable (EACCES); the
			// second finds it listable again and `events.jsonl` unreadable (EACCES). Each change lands after its pass's
			// opening snapshot, so neither pass reads one unchanged vault and the load goes on to a third, which reads the
			// final state (the directory present and listable, the log unreadable) unchanged throughout.
			const readers: string[] = [];
			let passes = 0;
			loadSeam.afterDescriptor = () => {
				passes += 1;
				if (passes === 1) chmodFor(auditDir(), 0o000);
				if (passes === 2) {
					chmodSync(auditDir(), 0o700);
					chmodFor(log(), 0o000);
				}
			};
			// What each pass's readers met, as the error code of opening each: the directory for listing, the log for reading.
			const openCode = (open: () => void): string => {
				try {
					open();
					return "ok";
				} catch (err) {
					return (err as NodeJS.ErrnoException).code ?? "unknown";
				}
			};
			loadSeam.afterReaders = () => {
				readers.push(
					`dir=${openCode(() => readdirSync(auditDir()))} log=${openCode(() => closeSync(openSync(log(), "r")))}`,
				);
			};
			const state = loadState(vault, undefined, true, [], before.auditDirId, held);
			loadSeam.afterDescriptor = undefined;
			loadSeam.afterReaders = undefined;
			expect(readers.slice(0, 2)).toEqual(["dir=EACCES log=EACCES", "dir=ok log=EACCES"]);
			expect(passes).toBeGreaterThanOrEqual(3);
			// No deletion of either kind: the directory never went away (its identity held) and no read of the events
			// succeeded, so nothing was compared with the head.
			expect(state.deletionCauses).toEqual([]);
			expect(state.deletionDetected).toBe(false);
			expect(state.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			expect(state.summary.chain.valid).toBe(false);
			// The caller keeps the head it had: the load returns none, never the empty reading's.
			expect(state.head === undefined || state.head === held).toBe(true);
			// Readable again, the vault is judged against the kept head and holds it.
			chmodSync(log(), 0o600);
			const healed = loadState(
				vault,
				undefined,
				true,
				state.deletionCauses,
				before.auditDirId,
				held,
			);
			expect(healed.deletionCauses).toEqual([]);
			expect(healed.summary.chain).toMatchObject({ events: 3, valid: true, errors: [] });
			expect(healed.head).toEqual(held);
		},
	);

	it.skipIf(asRoot)(
		"red-first (head replaced by an empty reading): the anchor alone unreadable is a read that failed, latches nothing, keeps the head, and heals",
		async () => {
			await appendEvents(root, 3, "tx");
			const vault = join(root, ".usertrust");
			const before = loadState(vault);
			expect(before.head).toMatchObject({ count: 3 });
			const held = before.head;
			chmodFor(`${log()}.meta`, 0o000);
			const passes: { readSucceeded: boolean }[] = [];
			loadSeam.afterPass = (pass) => passes.push(pass);
			const state = loadState(vault, undefined, true, [], before.auditDirId, held);
			loadSeam.afterPass = undefined;
			// The log and the directory read; the anchor did not, so the pass's read failed.
			expect(passes.map((p) => p.readSucceeded)).toEqual([false]);
			expect(state.head).toBeUndefined();
			expect(state.deletionCauses).toEqual([]);
			expect(state.summary.chain.valid).toBe(false);
			expect(state.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			chmodSync(`${log()}.meta`, 0o600);
			const healed = loadState(
				vault,
				undefined,
				true,
				state.deletionCauses,
				before.auditDirId,
				held,
			);
			expect(healed.deletionCauses).toEqual([]);
			expect(healed.summary.chain).toMatchObject({ events: 3, valid: true, errors: [] });
			expect(healed.head).toEqual(held);
		},
	);

	it.skipIf(asRoot)(
		"red-first (latched deletion): a permission change after the pass began and before its reads makes that pass's read FAIL, never a read of no events",
		async () => {
			await appendEvents(root, 3, "tx");
			const vault = join(root, ".usertrust");
			const before = loadState(vault);
			const held = before.head;
			const passes: { readSucceeded: boolean }[] = [];
			// The log opens for the pass's opening snapshot, then loses its read permission before the readers run. Nothing
			// probes the log after that: only the reader's own failed read can say the pass read nothing.
			loadSeam.afterDescriptor = () => {
				if (passes.length === 0) chmodFor(log(), 0o000);
			};
			loadSeam.afterPass = (pass) => passes.push(pass);
			const state = loadState(vault, undefined, true, [], before.auditDirId, held);
			loadSeam.afterDescriptor = undefined;
			loadSeam.afterPass = undefined;
			expect(passes.length).toBeGreaterThanOrEqual(1);
			expect(passes.every((p) => !p.readSucceeded)).toBe(true);
			expect(state.head).toBeUndefined();
			expect(state.deletionCauses).toEqual([]);
			expect(state.summary.chain.valid).toBe(false);
			expect(state.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			chmodSync(log(), 0o600);
			const healed = loadState(
				vault,
				undefined,
				true,
				state.deletionCauses,
				before.auditDirId,
				held,
			);
			expect(healed.deletionCauses).toEqual([]);
			expect(healed.summary.chain).toMatchObject({ events: 3, valid: true, errors: [] });
			expect(healed.head).toEqual(held);
		},
	);

	it.skipIf(asRoot)(
		"red-first (last good state shown): an audit directory that stays unreadable reads INVALID on every check, never valid, empty or latched",
		async () => {
			await appendEvents(root, 3, "tx");
			ui = await createUiServer(root, { port: 0 });
			expect(await chainOf(ui.port)).toMatchObject({ events: 3, valid: true });
			chmodFor(auditDir(), 0o000);
			await chainWhen(ui.port, unreadable);
			// Over three backstop ticks and more, with a forced reload among them.
			const seen = await chainsFor(ui.port, 1800);
			ui.reload();
			seen.push(...(await chainsFor(ui.port, 1800)));
			expect(seen.length).toBeGreaterThan(10);
			for (const c of seen) {
				expect(c).toMatchObject({ events: 0, valid: false, empty: false });
				expect(
					c.errors.some((e) => /could not be (read|enumerated)/.test(e)),
					c.errors.join(" | "),
				).toBe(true);
				expect(c.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			}
			chmodSync(auditDir(), 0o700);
			expect(
				await chainWhen(ui.port, (c) => c.valid && c.events === 3 && c.errors.length === 0),
			).toMatchObject({ events: 3, valid: true, errors: [] });
		},
	);
});
