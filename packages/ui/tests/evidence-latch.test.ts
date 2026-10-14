// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Evidence the dashboard has read stays reported when it is taken away. Two latches feed the deletion verdict: the audit
// directory's identity (another directory swapped in between two checks, or one that held no log bytes deleted), and the
// event the dashboard last verified (a vault that no longer holds it, or holds nothing where it held something, was
// truncated, emptied or replaced by another chain). Each is latched until a restart, whatever the vault holds afterwards.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
const { __tailTestSeam: tailSeam } = await import("../src/server/tail.js");

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

/** The hash of the last line of a log: the event a load of it verifies last. */
function lastHashOf(path: string): string {
	return (
		JSON.parse(readFileSync(path, "utf-8").trim().split("\n").at(-1) as string) as { hash: string }
	).hash;
}

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
		expect(before.head).toEqual({ verifiedHash: lastHashOf(log()), hadEvidence: true });
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
		const e4 = eventLine(e3.hash, "tx_4");
		writeFileSync(log(), e4.line);
		const vault = join(root, ".usertrust");
		const before = loadState(vault);
		// The head is the chain's tip by linkage, the log's event, though in file order the segment is read after it.
		expect(before.head).toEqual({ verifiedHash: e4.hash, hadEvidence: true });
		// What a load verified before the rotation: its tip is in the segment, so a read that misses the segment misses it.
		const held = { verifiedHash: e3.hash, hadEvidence: true };
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
		const state = loadState(vault, undefined, true, [], before.auditDirId, held);
		// The first pass read three events fewer than the head, and is not judged on them: the segment it listed went
		// before it was read, so the pass did not read one unchanged set of files.
		expect(passes).toEqual([
			{ consistent: false, readSucceeded: true, contained: false },
			{ consistent: true, readSucceeded: true, contained: true },
		]);
		expect(state.deletionCauses).toEqual([]);
		expect(state.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		expect(state.summary.chain.events).toBe(4);
		// In file order the log's event is read before the segment's, so the chain does not verify: the verified hash
		// stays the one the caller had, and only evidence could be added.
		expect(state.verified).toBe(false);
		expect(state.head).toEqual(held);
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
			expect(before.head).toEqual({ verifiedHash: lastHashOf(log()), hadEvidence: true });
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
			expect(before.head).toEqual({ verifiedHash: lastHashOf(log()), hadEvidence: true });
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

describe("the last verified event: what a full load must still hold, and when full loads run", {
	timeout: 30_000,
}, () => {
	const original = { ...tailSeam };
	let root: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;
	/** The audit directory's change listener the server registered; the only thing that asks for a check here. */
	let listener: (() => void) | undefined;
	let restore: { path: string; mode: number }[] = [];
	const vault = (): string => join(root, ".usertrust");
	const auditDir = (): string => join(vault(), "audit");
	const log = (): string => join(auditDir(), "events.jsonl");
	const meta = (): string => `${log()}.meta`;
	const asRoot = process.getuid?.() === 0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-latch-verified-"));
		listener = undefined;
		// No backstop and no re-verify unless a row asks for one: a check runs only when the row calls `check()`.
		tailSeam.backstopMs = 3_600_000;
		tailSeam.reverifyMs = 3_600_000;
		tailSeam.watch = ((_dir: string, cb: () => void) => {
			listener = cb;
			const w = new EventEmitter() as EventEmitter & { close(): void };
			w.close = () => {};
			return w;
		}) as unknown as typeof tailSeam.watch;
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
		io.afterListing = undefined;
		vi.restoreAllMocks();
		await ui?.close();
		ui = undefined;
		Object.assign(tailSeam, original);
		rmSync(root, { recursive: true, force: true });
	});

	function chmodFor(path: string, mode: number): void {
		restore.push({ path, mode: statSync(path).mode & 0o777 });
		chmodSync(path, mode);
	}

	/** One check of the log, as a file-change event asks for it (after the watcher's debounce). */
	const check = (): void => (listener as () => void)();

	async function summaryOf(port: number): Promise<{ chain: Chain; verifiedAt: string | null }> {
		return (await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()) as {
			chain: Chain;
			verifiedAt: string | null;
		};
	}

	/** The next event chained after the log's last line, with its sequence. */
	function nextEvent(transferId: string): { line: string; hash: string } {
		const last = JSON.parse(readFileSync(log(), "utf-8").trim().split("\n").at(-1) as string) as {
			hash: string;
			sequence: number;
		};
		return eventLine(last.hash, transferId, last.sequence + 1);
	}

	it.skipIf(asRoot)(
		"red-first (false clean): another chain renamed in while the anchor could not be read, then appended to, is latched at the next full load, never valid",
		async () => {
			await appendEvents(root, 3, "tx");
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			expect(await chainOf(port)).toMatchObject({ events: 3, valid: true });
			// Another valid chain of three, with its own anchor, put in place while the anchor is unreadable.
			const stage = mkdtempSync(join(tmpdir(), "trust-latch-verified-stage-"));
			try {
				await appendEvents(stage, 3, "tx_other");
				const staged = join(stage, ".usertrust", "audit", "events.jsonl");
				cpSync(`${staged}.meta`, meta());
				chmodFor(meta(), 0o000);
				renameSync(staged, log());
			} finally {
				rmSync(stage, { recursive: true, force: true });
			}
			ui.reload();
			const failed = await chainOf(port);
			expect(failed.valid).toBe(false);
			expect(failed.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			// Readable again, and appended to by the real writer before any full load.
			chmodSync(meta(), 0o600);
			await appendEvents(root, 1, "tx_more");
			// The append is a full reload (the last full load failed), never an extension onto the unverified chain.
			const names = await framesDuring(
				port,
				check,
				(n) => n.includes("resync") || n.includes("rows"),
			);
			expect(names).toContain("resync");
			expect(names).not.toContain("rows");
			const after = await chainOf(port);
			expect(after.events).toBe(4);
			expect(after.valid).toBe(false);
			expect(after.errors).toContain(EVENTS_ERROR);
			// The event the load looks for is still the first chain's: a reload stays latched.
			const server = ui;
			server.reload();
			expect((await chainOf(port)).errors).toContain(EVENTS_ERROR);
			expect(loadState(vault()).summary.chain.valid).toBe(true);
		},
	);

	it.skipIf(asRoot)(
		"a failed read, then an append (a full reload, which moves no verified event), then the log replaced by one holding only that append: latched",
		async () => {
			await appendEvents(root, 3, "tx");
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			chmodFor(meta(), 0o000);
			ui.reload();
			expect((await chainOf(port)).valid).toBe(false);
			const appended = nextEvent("tx_appended");
			appendFileSync(log(), appended.line);
			const names = await framesDuring(
				port,
				check,
				(n) => n.includes("resync") || n.includes("rows"),
			);
			expect(names).toContain("resync");
			expect(names).not.toContain("rows");
			// The three events the last successful load verified are gone; only the event appended during the failure is left.
			const next = join(auditDir(), "next.tmp");
			writeFileSync(next, appended.line);
			renameSync(next, log());
			chmodSync(meta(), 0o600);
			ui.reload();
			const after = await chainOf(port);
			expect(after.valid).toBe(false);
			expect(after.errors).toContain(EVENTS_ERROR);
		},
	);

	it("red-first (false clean): another chain appended beside the verified one (the reload reads invalid), then the verified tip removed so only the other chain is left, is latched, never valid", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const genesis = "0".repeat(64);
		const a1 = eventLine(genesis, "tx_a1", 1);
		const a2 = eventLine(a1.hash, "tx_a2", 2);
		const a3 = eventLine(a2.hash, "tx_a3", 3);
		writeFileSync(log(), a1.line + a2.line + a3.line);
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect(await chainOf(port)).toMatchObject({ events: 3, valid: true });
		// Another chain, forked from the second event: its first event does not link to the verified tip. Every event
		// carries a sequence, so the read's last event in sequence order is the other chain's tail.
		const b1 = eventLine(a2.hash, "tx_b1", 3);
		const b2 = eventLine(b1.hash, "tx_b2", 4);
		appendFileSync(log(), b1.line + b2.line);
		check();
		const forked = await chainWhen(port, (c) => c.events === 5);
		expect(forked.events).toBe(5);
		expect(forked.valid).toBe(false);
		expect(forked.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		// The verified tip removed: only the other chain is left, and on its own it verifies.
		writeFileSync(log(), a1.line + a2.line + b1.line + b2.line);
		expect(loadState(vault()).summary.chain.valid).toBe(true);
		check();
		const after = await chainWhen(port, isDeletion);
		expect(after).toMatchObject({ events: 4, valid: false });
		expect(after.errors).toContain(EVENTS_ERROR);
		ui.reload();
		expect((await chainOf(port)).errors).toContain(EVENTS_ERROR);
	});

	it("red-first (false clean): after a full load that reads a broken chain (the read itself succeeded), an append is a full reload, and the verified event does not move", async () => {
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect(await chainOf(port)).toMatchObject({ events: 3, valid: true });
		// Event 1's cost changed in place (same length): the chain is broken, and the read of it succeeds.
		const text = readFileSync(log(), "utf-8");
		writeFileSync(log(), text.replace('"cost":1', '"cost":7'));
		ui.reload();
		const broken = await chainOf(port);
		expect(broken.valid).toBe(false);
		expect(broken.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		const appended = nextEvent("tx_appended");
		appendFileSync(log(), appended.line);
		const names = await framesDuring(
			port,
			check,
			(n) => n.includes("resync") || n.includes("rows"),
		);
		expect(names).toContain("resync");
		expect(names).not.toContain("rows");
		// The log replaced by one holding only the appended event: the event the last VERIFIED load read last is gone.
		const next = join(auditDir(), "next.tmp");
		writeFileSync(next, appended.line);
		renameSync(next, log());
		ui.reload();
		const after = await chainOf(port);
		expect(after.valid).toBe(false);
		expect(after.errors).toContain(EVENTS_ERROR);
	});

	it("red-first (deletion read as valid and empty): malformed bytes only in a ROTATED segment, then that segment removed, is latched", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const segment = join(auditDir(), "events.0001.jsonl");
		writeFileSync(segment, "not an event\n{also not\n");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect(await chainOf(port)).toMatchObject({ events: 0, valid: false });
		rmSync(segment);
		ui.reload();
		const after = await chainOf(port);
		expect(after).toMatchObject({ events: 0, valid: false, empty: false });
		expect(after.errors).toContain(EVENTS_ERROR);
	});

	it("red-first (deletion read as valid and empty): an EMPTY audit directory at start, then malformed log bytes (read, not verified), then the log removed, is latched", async () => {
		mkdirSync(auditDir(), { recursive: true });
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect(await chainOf(port)).toMatchObject({ events: 0, valid: true, empty: true });
		writeFileSync(log(), "not an event\n{also not\n");
		ui.reload();
		expect(await chainOf(port)).toMatchObject({ events: 0, valid: false, empty: false });
		rmSync(log());
		ui.reload();
		const after = await chainOf(port);
		expect(after).toMatchObject({ events: 0, valid: false, empty: false });
		expect(after.errors).toContain(EVENTS_ERROR);
	});

	it("red-first (false red): a log of malformed lines only, rotated whole into a segment, is not a deletion", async () => {
		mkdirSync(auditDir(), { recursive: true });
		writeFileSync(log(), "not an event\n{also not\n");
		const first = loadState(vault());
		expect(first.head).toEqual({ verifiedHash: undefined, hadEvidence: true });
		renameSync(log(), join(auditDir(), "events.0001.jsonl"));
		const after = loadState(vault(), undefined, true, [], first.auditDirId, first.head);
		expect(after.deletionCauses).toEqual([]);
		expect(after.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
	});

	it("red-first (false red): in a file-order vault rotated so an older segment is read last, the remembered event is the chain's tip, and an append still holds it", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const genesis = "0".repeat(64);
		const e1 = eventLine(genesis, "tx_1");
		const e2 = eventLine(e1.hash, "tx_2");
		const e3 = eventLine(e2.hash, "tx_3");
		const e4 = eventLine(e3.hash, "tx_4");
		writeFileSync(join(auditDir(), "events.0001.jsonl"), e1.line + e2.line + e3.line);
		writeFileSync(log(), e4.line);
		// `events.jsonl` is read first in file order, so the segment's tail is the last event read; the tip is the log's.
		expect(loadState(vault()).head?.verifiedHash).toBe(e4.hash);
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		appendFileSync(log(), eventLine(e4.hash, "tx_5").line);
		check();
		const grown = await chainWhen(port, (c) => c.events === 5);
		expect(grown.events).toBe(5);
		ui.reload();
		const after = await chainOf(port);
		expect(after.events).toBe(5);
		expect(after.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
	});

	// The tip is the ONE event no other event's `previousHash` names. A fork has two or more, a crafted cycle none: from
	// neither is a tip picked, so the remembered event is never set or moved by such a read, and it never reads verified.
	describe("a read with no single tip fails closed", () => {
		/** An event whose `hash` and `previousHash` are chosen, not computed: what a crafted cycle needs. */
		function crafted(hash: string, previousHash: string, sequence: number): string {
			return `${canonicalize({ actor: "local", data: { cost: 1, settled: true, transferId: `tx_${sequence}` }, hash, id: `c${sequence}`, kind: "llm_call", previousHash, sequence, timestamp: new Date().toISOString() })}\n`;
		}
		const genesis = "0".repeat(64);
		const chainOfThree = () => {
			const a1 = eventLine(genesis, "tx_a1", 1);
			const a2 = eventLine(a1.hash, "tx_a2", 2);
			const a3 = eventLine(a2.hash, "tx_a3", 3);
			return { a1, a2, a3 };
		};

		it("red-first (tip guessed): a FORK, two events with no successor, sets no remembered event and never reads verified", () => {
			mkdirSync(auditDir(), { recursive: true });
			const { a1, a2, a3 } = chainOfThree();
			// Forked from the second event, with the later sequences: the last in sequence order is b2, the first tip read a3.
			const b1 = eventLine(a2.hash, "tx_b1", 4);
			const b2 = eventLine(b1.hash, "tx_b2", 5);
			writeFileSync(log(), a1.line + a2.line + a3.line + b1.line + b2.line);
			// A first load (no head yet) records its head from any whole read: the evidence, but no event.
			const first = loadState(vault());
			expect(first.head).toEqual({ verifiedHash: undefined, hadEvidence: true });
			expect(first.verified).toBe(false);
			expect(first.summary.chain.valid).toBe(false);
			// With a head held from a verified read of the first three, the fork moves nothing: the caller keeps its head.
			writeFileSync(log(), a1.line + a2.line + a3.line);
			const before = loadState(vault());
			expect(before.verified).toBe(true);
			expect(before.head).toEqual({ verifiedHash: a3.hash, hadEvidence: true });
			appendFileSync(log(), b1.line + b2.line);
			const after = loadState(vault(), undefined, true, [], before.auditDirId, before.head);
			expect(after.head).toEqual(before.head);
			expect(after.verified).toBe(false);
			expect(after.summary.chain.valid).toBe(false);
		});

		it("red-first (tip guessed): a crafted CYCLE of previousHash has no tip: no remembered event, never verified", () => {
			mkdirSync(auditDir(), { recursive: true });
			const x = "a".repeat(64);
			const y = "b".repeat(64);
			writeFileSync(log(), crafted(x, y, 1) + crafted(y, x, 2));
			const first = loadState(vault());
			expect(first.summary.chain.events).toBe(2);
			expect(first.head).toEqual({ verifiedHash: undefined, hadEvidence: true });
			expect(first.verified).toBe(false);
			expect(first.summary.chain.valid).toBe(false);
			// Against a held head the cycle moves nothing either.
			const held = { verifiedHash: "c".repeat(64), hadEvidence: true };
			const after = loadState(vault(), undefined, true, [], first.auditDirId, held);
			expect(after.head).toBeUndefined();
			expect(after.verified).toBe(false);
		});

		it("an EMPTY log claims no event: a first load remembers none, and a held one is not moved by it", () => {
			mkdirSync(auditDir(), { recursive: true });
			writeFileSync(log(), "");
			const first = loadState(vault());
			expect(first.summary.chain.events).toBe(0);
			expect(first.head?.verifiedHash).toBeUndefined();
			// A held event the empty log no longer holds: latched, the head kept, and the vault reads invalid. (`verified` is
			// the read's own verdict before deletion causes, true for an empty log; it moves no head on a latched read.)
			const { a3 } = chainOfThree();
			const held = { verifiedHash: a3.hash, hadEvidence: true };
			const after = loadState(vault(), undefined, true, [], first.auditDirId, held);
			expect(after.head).toBeUndefined();
			expect(after.deletionCauses).toEqual(["events"]);
			expect(after.summary.chain.valid).toBe(false);
			expect(after.summary.chain.errors).toContain(EVENTS_ERROR);
		});
	});

	// The first-load exception: with nothing remembered yet, a whole read that did not latch records its head even when
	// its chain does not verify (the tip only when it is unambiguous). Strictly the first load, and an ambiguous tip there
	// never latches.
	describe("the first load, and only the first, remembers from a chain that does not verify", () => {
		const genesis = "0".repeat(64);
		/** Two independent chains, each from genesis with sequences 1..n: read together they fork (two tips). */
		const chains = () => {
			const a1 = eventLine(genesis, "tx_a1", 1);
			const a2 = eventLine(a1.hash, "tx_a2", 2);
			const a3 = eventLine(a2.hash, "tx_a3", 3);
			const b1 = eventLine(genesis, "tx_b1", 1);
			const b2 = eventLine(b1.hash, "tx_b2", 2);
			return { a: a1.line + a2.line + a3.line, b: b1.line + b2.line, a3 };
		};

		it("red-first (head moved by a broken load): a remembered verified chain, then an independent chain appended (reads broken), does not move the head; the verified chain removed is latched", async () => {
			mkdirSync(auditDir(), { recursive: true });
			const { a, b, a3 } = chains();
			writeFileSync(log(), a);
			const held = loadState(vault());
			expect(held.head).toEqual({ verifiedHash: a3.hash, hadEvidence: true });
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			expect(await chainOf(port)).toMatchObject({ events: 3, valid: true });
			appendFileSync(log(), b);
			// Against the remembered head, the broken read does not move the verified hash.
			const broken = loadState(vault(), undefined, true, [], held.auditDirId, held.head);
			expect(broken.head).toEqual(held.head);
			check();
			const appended = await chainWhen(port, (c) => c.events === 5);
			expect(appended.valid).toBe(false);
			expect(appended.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			// Only the independent chain left: on its own it verifies, and it lacks the remembered tip.
			writeFileSync(log(), b);
			expect(loadState(vault()).summary.chain.valid).toBe(true);
			check();
			const after = await chainWhen(port, isDeletion);
			expect(after).toMatchObject({ events: 2, valid: false });
			expect(after.errors).toContain(EVENTS_ERROR);
		});

		it("red-first (false red): a vault forked at startup reads broken, latches no deletion, and remembers no event", async () => {
			mkdirSync(auditDir(), { recursive: true });
			const { a, b } = chains();
			writeFileSync(log(), a + b);
			const first = loadState(vault());
			expect(first.head).toEqual({ verifiedHash: undefined, hadEvidence: true });
			expect(first.deletionCauses).toEqual([]);
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			for (let i = 0; i < 2; i++) {
				const chain = await chainOf(port);
				expect(chain).toMatchObject({ events: 5, valid: false });
				expect(chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
				ui.reload();
			}
		});

		it("red-first (deletion read as a first run): a vault forked at startup, then its log and anchor deleted, is latched by its evidence", async () => {
			await appendEvents(root, 3, "tx");
			const { b } = chains();
			appendFileSync(log(), b);
			expect(loadState(vault()).head).toEqual({ verifiedHash: undefined, hadEvidence: true });
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			const forked = await chainOf(port);
			expect(forked).toMatchObject({ events: 5, valid: false });
			expect(forked.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
			rmSync(log());
			rmSync(meta(), { force: true });
			ui.reload();
			const after = await chainOf(port);
			expect(after).toMatchObject({ events: 0, valid: false, empty: false });
			expect(after.errors).toContain(EVENTS_ERROR);
		});
	});

	it("events appended after a successful full load, then the log truncated back to its first three, are latched", async () => {
		await appendEvents(root, 3, "tx");
		const text = readFileSync(log(), "utf-8");
		const anchor = readFileSync(meta(), "utf-8");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		await appendEvents(root, 2, "tx_more");
		const names = await framesDuring(
			port,
			check,
			(n) => n.includes("rows") || n.includes("resync"),
		);
		expect(names).toContain("rows");
		expect(names).not.toContain("resync");
		expect(await chainOf(port)).toMatchObject({ events: 5, valid: true });
		// Events 4 and 5 removed, and the anchor put back as it was: on its own, the vault verifies.
		writeFileSync(log(), text);
		writeFileSync(meta(), anchor);
		expect(loadState(vault()).summary.chain.valid).toBe(true);
		check();
		const after = await chainWhen(port, isDeletion);
		expect(after).toMatchObject({ events: 3, valid: false });
		expect(after.errors).toContain(EVENTS_ERROR);
	});

	it("red-first (false red): a load that sees a rotation between its two steps (every event twice), then the finished rotation, latches nothing", async () => {
		await appendEvents(root, 3, "tx");
		const before = loadState(vault());
		const text = readFileSync(log(), "utf-8");
		const next = nextEvent("tx_next").line;
		// Step one: the log's events copied into a segment. The log still holds them, so a load reads each event twice.
		writeFileSync(join(auditDir(), "events.0001.jsonl"), text);
		const between = loadState(vault(), undefined, true, [], before.auditDirId, before.head);
		expect(between.deletionCauses).toEqual([]);
		// Step two: the log rewritten with only the next event.
		writeFileSync(log(), next);
		const after = loadState(
			vault(),
			undefined,
			true,
			between.deletionCauses,
			before.auditDirId,
			between.head ?? before.head,
		);
		expect(after.deletionCauses).toEqual([]);
		expect(after.summary.chain.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		expect(after.summary.chain.events).toBe(4);
	});

	it("red-first (deletion read as valid and empty): a log of malformed lines only, then the log and its anchor removed, is latched", async () => {
		mkdirSync(auditDir(), { recursive: true });
		writeFileSync(log(), "not an event\n{also not\n");
		writeFileSync(meta(), JSON.stringify({ lastHash: "0".repeat(64), sequence: 0 }));
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		expect(await chainOf(port)).toMatchObject({ events: 0, valid: false });
		rmSync(meta());
		rmSync(log());
		ui.reload();
		const after = await chainOf(port);
		expect(after).toMatchObject({ events: 0, valid: false, empty: false });
		expect(after.errors).toContain(EVENTS_ERROR);
	});

	it("guard: the log renamed away and back during one pass's read is not latched: the confirming pass reads it whole", async () => {
		await appendEvents(root, 3, "tx");
		const before = loadState(vault());
		const aside = join(root, "aside.jsonl");
		const passes: { consistent: boolean; readSucceeded: boolean; contained: boolean }[] = [];
		loadSeam.afterDescriptor = () => {
			if (passes.length > 0) return;
			// The reader checks the log exists and lists the directory; the log is gone when it reads it (ENOENT).
			io.afterListing = { suffix: "audit", run: () => renameSync(log(), aside) };
		};
		loadSeam.afterReaders = () => {
			// Back, the same file, before the pass's closing stat: the pass reads as one unchanged vault.
			if (passes.length === 0) renameSync(aside, log());
		};
		loadSeam.afterPass = (pass) => passes.push(pass);
		const state = loadState(vault(), undefined, true, [], before.auditDirId, before.head);
		expect(passes).toEqual([
			{ consistent: true, readSucceeded: true, contained: false },
			{ consistent: true, readSucceeded: true, contained: true },
		]);
		expect(state.deletionCauses).toEqual([]);
		expect(state.summary.chain).toMatchObject({ events: 3, valid: true, errors: [] });
	});

	it("a same-length rewrite of an earlier event plus an append, inside one check, is extended by the append path and read INVALID at the periodic re-verify", async () => {
		tailSeam.reverifyMs = 2000;
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const port = ui.port;
		const first = await summaryOf(port);
		// Event 1's cost changed in place (same length), and a correctly chained event appended, in one write.
		const text = readFileSync(log(), "utf-8");
		const appended = nextEvent("tx_appended");
		const rewritten = text.replace('"cost":1', '"cost":7');
		expect(rewritten.length).toBe(text.length);
		writeFileSync(log(), rewritten + appended.line);
		const names = await framesDuring(
			port,
			check,
			(n) => n.includes("rows") || n.includes("resync"),
		);
		// The append path checks only what was appended: the rewrite is not seen.
		expect(names).toContain("rows");
		expect(names).not.toContain("resync");
		expect((await summaryOf(port)).chain).toMatchObject({ events: 4, valid: true });
		// The periodic full re-verify reads the whole log: the break at event 1 makes it invalid. The verified event
		// (the appended one) is still there, so nothing is latched: the outcome is an INVALID chain, not a deletion.
		const after = await chainWhen(port, (c) => !c.valid, 5000);
		expect(after.valid).toBe(false);
		expect(after.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);
		expect((await summaryOf(port)).verifiedAt).not.toBe(first.verifiedAt);
	});

	it.skipIf(asRoot)(
		"verifiedAt: set by a full load that read the vault, unchanged by an append and by a failed read",
		async () => {
			await appendEvents(root, 3, "tx");
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			const first = (await summaryOf(port)).verifiedAt;
			expect(first).not.toBeNull();
			expect(Number.isNaN(Date.parse(first as string))).toBe(false);
			await sleep(20);
			await appendEvents(root, 1, "tx_more");
			const names = await framesDuring(port, check, (n) => n.includes("rows"));
			expect(names).toContain("rows");
			expect((await summaryOf(port)).verifiedAt).toBe(first);
			chmodFor(meta(), 0o000);
			ui.reload();
			const failed = await summaryOf(port);
			expect(failed.chain.valid).toBe(false);
			expect(failed.verifiedAt).toBe(first);
			chmodSync(meta(), 0o600);
			await sleep(20);
			ui.reload();
			const healed = await summaryOf(port);
			expect(healed.chain.valid).toBe(true);
			expect(Date.parse(healed.verifiedAt as string)).toBeGreaterThan(Date.parse(first as string));
		},
	);

	it("the periodic re-verify is unref'd, runs the full load, is skipped while a load runs, and is cleared on close()", async () => {
		const setSpy = vi.spyOn(globalThis, "setInterval");
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		tailSeam.reverifyMs = 3_600_001;
		await appendEvents(root, 3, "tx");
		ui = await createUiServer(root, { port: 0 });
		const at = setSpy.mock.calls.findIndex((c) => c[1] === 3_600_001);
		expect(at).not.toBe(-1);
		const reverify = setSpy.mock.calls[at]?.[0] as () => void;
		const timer = setSpy.mock.results[at]?.value as NodeJS.Timeout;
		expect(timer.hasRef()).toBe(false);
		// It runs the full load: one load's passes, and a resync frame.
		let passes = 0;
		loadSeam.afterPass = () => {
			passes += 1;
		};
		const names = await framesDuring(port(), reverify, (n) => n.includes("resync"));
		expect(names).toContain("resync");
		expect(passes).toBe(1);
		// Fired while a load runs (from inside it), it is skipped: no second, nested load.
		passes = 0;
		loadSeam.afterPass = () => {
			passes += 1;
			if (passes === 1) reverify();
		};
		(ui as NonNullable<typeof ui>).reload();
		expect(passes).toBe(1);
		await (ui as NonNullable<typeof ui>).close();
		ui = undefined;
		expect(clearSpy.mock.calls.some((c) => c[0] === timer)).toBe(true);

		function port(): number {
			return (ui as NonNullable<typeof ui>).port;
		}
	});
});

// A read that keeps failing is retried, never taken for a verdict, but not on every check: a full load of a large vault
// takes about half a second and is broadcast to every client. Only the backstop asks for checks here, on a short tick, and
// the retry window is shortened through the same seam.
describe("a read that keeps failing is retried at most once per retry window", {
	timeout: 30_000,
}, () => {
	const original = { ...tailSeam };
	const TICK = 100;
	const RETRY = 700;
	const SPELL = 3500;
	let root: string;
	let ui: Awaited<ReturnType<typeof createUiServer>> | undefined;
	let restore: { path: string; mode: number }[] = [];
	const meta = (): string => join(root, ".usertrust", "audit", "events.jsonl.meta");
	const asRoot = process.getuid?.() === 0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-latch-retry-"));
		tailSeam.backstopMs = TICK;
		tailSeam.reverifyMs = 3_600_000;
		tailSeam.failedReadRetryMs = RETRY;
		// A watcher that never calls back: every check is the backstop's.
		tailSeam.watch = (() => {
			const w = new EventEmitter() as EventEmitter & { close(): void };
			w.close = () => {};
			return w;
		}) as unknown as typeof tailSeam.watch;
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
		loadSeam.afterPass = undefined;
		await ui?.close();
		ui = undefined;
		Object.assign(tailSeam, original);
		rmSync(root, { recursive: true, force: true });
	});

	it.skipIf(asRoot)(
		"red-first (a reload per tick): an anchor that stays unreadable is read in full, and broadcast, at most once per window; once readable it reads valid within one",
		async () => {
			await appendEvents(root, 3, "tx");
			ui = await createUiServer(root, { port: 0 });
			const port = ui.port;
			expect(await chainOf(port)).toMatchObject({ events: 3, valid: true });
			restore.push({ path: meta(), mode: statSync(meta()).mode & 0o777 });
			chmodSync(meta(), 0o000);
			// The anchor's permission changes nothing a check sees: a reload starts the failed spell.
			const server = ui;
			const loads: boolean[] = [];
			const frames = await framesDuring(
				port,
				() => {
					server.reload();
					loadSeam.afterPass = (pass) => loads.push(pass.readSucceeded);
				},
				() => false,
				SPELL,
			);
			loadSeam.afterPass = undefined;
			// N ticks of the spell, and the bound on full loads over them.
			const bound = Math.ceil(SPELL / RETRY);
			const resyncs = frames.filter((f) => f === "resync").length - 1;
			// Positive control: the failed read is retried at all, and every retry failed.
			expect(loads.length).toBeGreaterThanOrEqual(1);
			expect(loads.every((ok) => !ok)).toBe(true);
			expect(loads.length).toBeLessThanOrEqual(bound);
			expect(resyncs).toBeGreaterThanOrEqual(1);
			expect(resyncs).toBeLessThanOrEqual(bound);
			const during = await chainOf(port);
			expect(during.valid).toBe(false);
			expect(during.errors.filter((e) => e.includes("deletion detected"))).toEqual([]);

			chmodSync(meta(), 0o600);
			const readableAt = Date.now();
			const after = await chainWhen(
				port,
				(c) => c.valid && c.events === 3 && c.errors.length === 0,
				RETRY + 2000,
			);
			expect(after).toMatchObject({ events: 3, valid: true, errors: [] });
			// Within one window, plus a tick and the summary poll's own interval.
			expect(Date.now() - readableAt).toBeLessThanOrEqual(RETRY + TICK + 400);
		},
	);
});
