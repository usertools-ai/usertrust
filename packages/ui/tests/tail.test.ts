// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { EventEmitter } from "node:events";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferIdHash } from "usertrust-verify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { recordEffectiveBudget } from "../../core/src/budget/effective-record.js";
import { CLOSE_GRACE_MS, createUiServer, type UiServer } from "../src/server/server.js";
import { fileIdentity } from "../src/server/state.js";
import { __tailTestSeam, watchLedger } from "../src/server/tail.js";

async function readSse(
	port: number,
	predicate: (eventName: string) => boolean,
	act: () => Promise<void>,
	timeoutMs = 5000,
): Promise<{ eventName: string; data: string; id: string | undefined }> {
	const res = await fetch(`http://127.0.0.1:${port}/api/tail`);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	await act();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split("\n\n");
		buffer = blocks.pop() ?? "";
		for (const block of blocks) {
			const eventName = /event: (.+)/.exec(block)?.[1] ?? "message";
			const data = /data: (.+)/.exec(block)?.[1] ?? "";
			const id = /^id: (.+)$/m.exec(block)?.[1];
			if (predicate(eventName)) {
				await reader.cancel();
				return { eventName, data, id };
			}
		}
	}
	await reader.cancel();
	throw new Error("SSE event not received in time");
}

describe("live tail", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 1, transferId: "tx_seed" },
		});
		writer.release();
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("pushes appended events as rows", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const { eventName, data } = await readSse(
			ui.port,
			(name) => name === "rows",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { cost: 2, transferId: "tx_live" },
				});
				writer.release();
			},
		);
		expect(eventName).toBe("rows");
		const rows = JSON.parse(data) as Array<{ transferId?: string }>;
		expect(rows.some((r) => r.transferId === "tx_live")).toBe(true);
	});

	it("red-first (deletion read as a first run): deleting the audit directory under an open dashboard turns it red", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const { data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				rmSync(join(tempDir, ".usertrust", "audit"), { recursive: true, force: true });
			},
		);
		const chain = JSON.parse(data).chain as { valid: boolean; empty: boolean; errors: string[] };
		expect(chain).toMatchObject({ valid: false, empty: false });
		expect(chain.errors.join(" ")).toContain("deletion detected");
	});

	it("red-first (stays settled): an ambiguity appended after an OPTIMISTIC settlement re-classifies the EARLIER row", async () => {
		// The audit-first path writes `settled: true` before the POST and appends `settlement_ambiguous` only when the
		// POST throws: the earlier row's verdict changes after it was sent, so the server sends the change.
		const seed = createAuditWriter(tempDir);
		await seed.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 3, transferId: "tx_opt", settled: true },
		});
		seed.release();
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: Array<{ id: string; hash: string; transferId?: string; status?: string }>;
		};
		const optimistic = before.rows.find((r) => r.transferId === "tx_opt");
		expect(optimistic?.status).toBe("settled");
		const { data } = await readSse(
			ui.port,
			(name) => name === "status",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "settlement_ambiguous",
					actor: "local",
					data: { transferId: "tx_opt", error: "post failed" },
				});
				writer.release();
			},
		);
		expect(JSON.parse(data)).toEqual([
			{ id: optimistic?.id, hash: optimistic?.hash, status: "ambiguous" },
		]);
		const after = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: Array<{ transferId?: string; kind: string; status?: string }>;
		};
		expect(
			after.rows.filter((r) => r.transferId === "tx_opt").map((r) => [r.kind, r.status]),
		).toEqual([
			["llm_call", "ambiguous"],
			["settlement_ambiguous", "ambiguous"],
		]);
	});

	it("every frame carries the state's version as its SSE id, and a snapshot the version it was taken at", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const events = async () =>
			(await (await fetch(`http://127.0.0.1:${ui?.port}/api/events`)).json()) as {
				version: number;
			};
		const { version: before } = await events();
		expect(typeof before).toBe("number");
		const { id } = await readSse(
			ui.port,
			(name) => name === "rows",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { cost: 2, transferId: "tx_v" },
				});
				writer.release();
			},
		);
		expect(id).toBe(String(before + 1));
		expect((await events()).version).toBe(before + 1);
	});

	it("red-first (no version, no resync): reload() is a resync — a new version, and every client told", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const events = async () =>
			(await (await fetch(`http://127.0.0.1:${ui?.port}/api/events`)).json()) as {
				version: number;
			};
		const { version: before } = await events();
		const { eventName, id } = await readSse(
			ui.port,
			(name) => name === "resync",
			async () => {
				ui?.reload();
			},
		);
		expect(eventName).toBe("resync");
		expect(id).toBe(String(before + 1));
		expect((await events()).version).toBe(before + 1);
	});

	it("red-first (two requests): the snapshot carries the summary taken at the same version as its rows", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const snap = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: unknown[];
			summary?: { rowCount: number; chain: { events: number } };
			version: number;
		};
		expect(snap.summary).toBeDefined();
		expect(snap.summary?.rowCount).toBe(snap.rows.length);
		expect(snap.summary?.chain.events).toBe(snap.rows.length);
	});

	it("red-first (unrecoverable): a late settle's hash-only record joins its swept transfer live: RELEASED", async () => {
		const seed = createAuditWriter(tempDir);
		await seed.appendEvent({
			kind: "hold_released",
			actor: "local",
			data: { transferId: "tx_swept", reason: "pending TTL expired" },
		});
		seed.release();
		ui = await createUiServer(tempDir, { port: 0 });
		const { data } = await readSse(
			ui.port,
			(name) => name === "rows",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "settlement_unrecoverable",
					actor: "local",
					data: { transferIdHash: transferIdHash("tx_swept"), reason: "no hold" },
				});
				writer.release();
			},
		);
		expect(
			(JSON.parse(data) as Array<{ kind: string; status?: string }>).map((r) => [r.kind, r.status]),
		).toEqual([["settlement_unrecoverable", "released"]]);
	});

	it("red-first (stale): a governor starting while the UI runs updates the summary's budget (the record is outside audit/)", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/summary`)).json()) as {
			budget: number | null;
		};
		expect(before.budget).toBeNull();
		const { data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				recordEffectiveBudget(join(tempDir, ".usertrust"), 4_000);
			},
			8000,
		);
		const summary = JSON.parse(data) as { budget: number | null; budgetSource: string };
		expect(summary).toMatchObject({ budget: 4_000, budgetSource: "governor" });
	});

	it("red-first (stale reason): an unreadable record whose REASON changes updates the summary's provenance", async () => {
		const record = join(tempDir, ".usertrust", "effective-budget.json");
		writeFileSync(record, "{torn");
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/summary`)).json()) as {
			budgetProvenance: string;
		};
		expect(before.budgetProvenance).toContain("not valid JSON");
		const { data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				rmSync(record);
				mkdirSync(record);
			},
			8000,
		);
		const summary = JSON.parse(data) as { budget: number | null; budgetProvenance: string };
		expect(summary.budget).toBeNull();
		expect(summary.budgetProvenance).toContain("not a regular file");
	});

	it("red-first (same version): a budget refresh is a state change: its summary frame carries a NEWER version than a snapshot taken before it", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const snap = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			version: number;
		};
		const { id, data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				recordEffectiveBudget(join(tempDir, ".usertrust"), 4_000);
			},
			8000,
		);
		expect(JSON.parse(data)).toMatchObject({ budget: 4_000 });
		expect(Number(id)).toBeGreaterThan(snap.version);
	});

	it("signals resync when the log shrinks", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const { eventName } = await readSse(
			ui.port,
			(name) => name === "resync",
			async () => {
				truncateSync(logPath, 0);
			},
		);
		expect(eventName).toBe("resync");
	});

	it("signals resync when an appended event's hash does not verify", async () => {
		// Amendment A4: linkage alone is not enough — a forged line with the
		// correct previousHash but a bogus hash must trigger a full resync.
		ui = await createUiServer(tempDir, { port: 0 });
		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const lastLine = readFileSync(logPath, "utf-8").trim().split("\n").at(-1) as string;
		const last = JSON.parse(lastLine) as { hash: string };
		const forged = {
			id: "forged",
			timestamp: new Date().toISOString(),
			previousHash: last.hash,
			kind: "llm_call",
			actor: "local",
			data: { cost: 999, transferId: "tx_forged" },
			sequence: 2,
			hash: "0".repeat(64),
		};
		const { eventName } = await readSse(
			ui.port,
			(name) => name === "resync",
			async () => {
				appendFileSync(logPath, `${JSON.stringify(forged)}\n`);
			},
		);
		expect(eventName).toBe("resync");
	});
});

// Before a project's first governed call there is no audit directory, and fs.watch cannot watch a path that does not
// exist: the dashboard opened on a new project showed "no governed calls yet" and never showed the first one.
describe("live tail on a project with no vault yet", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-fresh-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("red-first (never delivered): the first event, written after the server started, reaches the client", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/summary`)).json()) as {
			chain: { events: number; empty: boolean };
		};
		expect(before.chain).toMatchObject({ events: 0, empty: true });
		const { data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { cost: 4, settled: true, transferId: "tx_first" },
				});
				writer.release();
			},
			8000,
		);
		expect(JSON.parse(data).chain).toMatchObject({ events: 1, valid: true, empty: false });
		const { rows } = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: Array<{ transferId?: string }>;
		};
		expect(rows.map((r) => r.transferId)).toEqual(["tx_first"]);
	});
});

describe("header spend", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-spend-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	// One rule at load and on a live append: the header counts llm_call costs. Trends shows every costed record in
	// view under its own label, so the two figures are never presented as one quantity.
	it("counts the same records at load and on a live append", async () => {
		const seed = createAuditWriter(tempDir);
		await seed.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 7, transferId: "tx_a" },
		});
		await seed.appendEvent({
			kind: "tool_use",
			actor: "local",
			data: { cost: 30, settled: true, transferId: "tx_b" },
		});
		seed.release();
		ui = await createUiServer(tempDir, { port: 0 });
		const loaded = (await (await fetch(`http://127.0.0.1:${ui.port}/api/summary`)).json()) as {
			spentUt: number;
		};
		expect(loaded.spentUt).toBe(7);
		const append = (kind: string, data: Record<string, unknown>) => async () => {
			const writer = createAuditWriter(tempDir);
			await writer.appendEvent({ kind, actor: "local", data });
			writer.release();
		};
		const port = ui.port;
		const afterTool = await readSse(
			port,
			(name) => name === "summary",
			append("tool_use", { cost: 40, settled: true, transferId: "tx_c" }),
		);
		expect(JSON.parse(afterTool.data).spentUt).toBe(7);
		const afterCall = await readSse(
			port,
			(name) => name === "summary",
			append("llm_call", { cost: 2, transferId: "tx_d" }),
		);
		expect(JSON.parse(afterCall.data).spentUt).toBe(9);
	});

	// Measured on the unfixed close(): about 3.7 s here, against about CLOSE_GRACE_MS (400 ms) once it cuts the remaining connections.
	// One live-tail wait leaves close() fast; two in a row hold it. Which connection is held is not established.
	// The row asserts what ended the close, never how long it took: under load the same close() measured 1.5 to 2.2 s
	// against a 1.5 s bound, and two live-tail waits alone passed the 5 s default. The unfixed close() armed no grace timer,
	// so a held connection kept it waiting for the keep-alive timeout. A fixed close() either has nothing held (the timer
	// is cleared before it fires) or its grace timer fires and cuts, and only then resolves. The timeout is derived: each
	// wait is bounded by its own deadline, and close() by the grace.
	it("close() ends by the grace timer's cut, not by a held connection's own timeout, after two live-tail waits", {
		timeout: 2 * 5000 + 2 * CLOSE_GRACE_MS + 5000,
	}, async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const port = ui.port;
		for (const id of ["tx_a", "tx_b"]) {
			await readSse(
				port,
				(name) => name === "summary",
				async () => {
					const writer = createAuditWriter(tempDir);
					await writer.appendEvent({
						kind: "llm_call",
						actor: "local",
						data: { cost: 1, transferId: id },
					});
					writer.release();
				},
			);
		}
		const order: string[] = [];
		const graceTimers: NodeJS.Timeout[] = [];
		const realSetTimeout = globalThis.setTimeout;
		const realCutAll = ui.server.closeAllConnections.bind(ui.server);
		vi.spyOn(ui.server, "closeAllConnections").mockImplementation(() => {
			order.push("cut");
			realCutAll();
		});
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			if (ms !== CLOSE_GRACE_MS) return realSetTimeout(fn, ms);
			const timer = realSetTimeout(() => {
				order.push("grace-timer-fired");
				fn();
			}, ms);
			graceTimers.push(timer);
			return timer;
		}) as unknown as typeof setTimeout);
		await ui.close();
		order.push("close-resolved");
		ui = undefined;
		expect(graceTimers).toHaveLength(1);
		expect([["close-resolved"], ["grace-timer-fired", "cut", "close-resolved"]]).toContainEqual(
			order,
		);
	});
});

describe("remote settings", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-remote-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("turning the kit mark on in the vault config reaches the client without a restart", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/summary`)).json()) as {
			remote: { kit: boolean };
		};
		expect(before.remote).toEqual({ kit: false });
		const { data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				writeFileSync(
					join(tempDir, ".usertrust", "usertrust.config.json"),
					JSON.stringify({ remote: { kit: true } }),
				);
			},
		);
		expect(JSON.parse(data).remote).toEqual({ kit: true });
	});
});

// A log of malformed lines only fails verification with ZERO parsed events: a guard that counted parsed events read its
// later deletion as a first run. The server remembers that it saw the directory, whatever it held.
describe("deletion of an audit directory that held no parsable event", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-malformed-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		writeFileSync(join(tempDir, ".usertrust", "audit", "events.jsonl"), "{ not json\n");
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("red-first (cleared to a first run): deleting it under an open dashboard stays red", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/summary`)).json()) as {
			chain: { events: number; valid: boolean };
		};
		expect(before.chain).toMatchObject({ events: 0, valid: false });
		const { data } = await readSse(
			ui.port,
			(name) => name === "summary",
			async () => {
				rmSync(join(tempDir, ".usertrust", "audit"), { recursive: true, force: true });
			},
		);
		const chain = JSON.parse(data).chain as { valid: boolean; empty: boolean; errors: string[] };
		expect(chain).toMatchObject({ valid: false, empty: false });
		expect(chain.errors.join(" ")).toContain("deletion detected");
	});
});

type ChainSummary = {
	chain: {
		events: number;
		valid: boolean;
		empty: boolean;
		breakIndex: number | null;
		errors: string[];
	};
};

/** The summary the server serves now. */
async function summaryOf(port: number): Promise<ChainSummary> {
	return (await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()) as ChainSummary;
}

/** Polls the served summary until `done` holds, and returns the last one read: a caller asserts on it, so a timeout is a failed assertion. */
async function summaryWhen(
	port: number,
	done: (s: ChainSummary) => boolean,
	timeoutMs = 6000,
): Promise<ChainSummary> {
	const deadline = Date.now() + timeoutMs;
	let last = await summaryOf(port);
	while (!done(last) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		last = await summaryOf(port);
	}
	return last;
}

const couldNotBeRead = (s: ChainSummary): boolean =>
	s.chain.errors.some((e) => e.includes("could not be read"));

async function appendOne(root: string, transferId: string): Promise<void> {
	const writer = createAuditWriter(root);
	await writer.appendEvent({
		kind: "llm_call",
		actor: "local",
		data: { cost: 2, settled: true, transferId },
	});
	writer.release();
}

// The chain verdict is derived by a full load. The incremental append path only extends it, so it cannot clear an alarm
// the load raised because it could not READ the audit directory, nor see what only the vault's own checks see.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"live tail when the audit directory could not be read at start",
	{ timeout: 20_000 },
	() => {
		let tempDir: string;
		let ui: UiServer | undefined;
		const vaultDir = () => join(tempDir, ".usertrust");
		const auditDir = () => join(vaultDir(), "audit");
		const logPath = () => join(auditDir(), "events.jsonl");

		beforeEach(async () => {
			tempDir = mkdtempSync(join(tmpdir(), "trust-tail-unreadable-"));
			mkdirSync(auditDir(), { recursive: true });
			const writer = createAuditWriter(tempDir);
			for (let i = 0; i < 3; i++) {
				await writer.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { cost: 1, settled: true, transferId: `tx_${i}` },
				});
			}
			writer.release();
		});

		afterEach(async () => {
			// Restore before anything else: rmSync cannot clear a directory it may not search.
			for (const dir of [vaultDir(), auditDir()]) if (existsSync(dir)) chmodSync(dir, 0o700);
			await ui?.close();
			ui = undefined;
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("red-first (stale alarm): a vault that becomes readable with a VALID chain stops reading as a failure", async () => {
			chmodSync(vaultDir(), 0o000);
			ui = await createUiServer(tempDir, { port: 0 });
			const before = await summaryOf(ui.port);
			expect(before.chain.valid).toBe(false);
			expect(couldNotBeRead(before)).toBe(true);
			chmodSync(vaultDir(), 0o700);
			await appendOne(tempDir, "tx_after");
			const after = await summaryWhen(ui.port, (s) => s.chain.events === 4 && s.chain.valid);
			expect(after.chain).toMatchObject({ events: 4, valid: true, empty: false, breakIndex: null });
			expect(couldNotBeRead(after)).toBe(false);
			expect(after.chain.errors).toEqual([]);
		});

		it("red-first (stale alarm): the same when the AUDIT directory itself, not the vault, could not be read", async () => {
			chmodSync(auditDir(), 0o000);
			ui = await createUiServer(tempDir, { port: 0 });
			const before = await summaryOf(ui.port);
			expect(before.chain.valid).toBe(false);
			expect(couldNotBeRead(before)).toBe(true);
			chmodSync(auditDir(), 0o700);
			await appendOne(tempDir, "tx_after");
			const after = await summaryWhen(ui.port, (s) => s.chain.events === 4 && s.chain.valid);
			expect(after.chain).toMatchObject({ events: 4, valid: true, breakIndex: null });
			expect(after.chain.errors).toEqual([]);
		});

		// Control: this one already passes on the old code (the incremental path throws on the forged line and resyncs). It
		// pins that routing the first append through a full load does not hide a real break.
		it("a chain that is BROKEN when the vault becomes readable still reads as broken, never verified", async () => {
			const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
			lines[1] = (lines[1] as string).replace('"cost":1', '"cost":9');
			expect(lines[1]).toContain('"cost":9');
			writeFileSync(logPath(), `${lines.join("\n")}\n`);
			chmodSync(vaultDir(), 0o000);
			ui = await createUiServer(tempDir, { port: 0 });
			expect(couldNotBeRead(await summaryOf(ui.port))).toBe(true);
			chmodSync(vaultDir(), 0o700);
			await appendOne(tempDir, "tx_after");
			const after = await summaryWhen(ui.port, (s) => !couldNotBeRead(s));
			expect(couldNotBeRead(after)).toBe(false);
			expect(after.chain.valid).toBe(false);
			expect(after.chain.breakIndex).toBe(1);
		});

		// Only the vault's own checks (its anchor) see a truncated tail: the events that remain still link from genesis.
		// No append here: an append moves the anchor to the new head, which is an honest repair of the record, not tampering.
		it("a TRUNCATED log that becomes readable reads as broken: the log's own linkage cannot see it", async () => {
			const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
			writeFileSync(logPath(), `${lines.slice(0, 2).join("\n")}\n`);
			chmodSync(vaultDir(), 0o000);
			ui = await createUiServer(tempDir, { port: 0 });
			expect(couldNotBeRead(await summaryOf(ui.port))).toBe(true);
			chmodSync(vaultDir(), 0o700);
			const after = await summaryWhen(ui.port, (s) => !couldNotBeRead(s));
			expect(couldNotBeRead(after)).toBe(false);
			expect(after.chain.events).toBe(2);
			expect(after.chain.valid).toBe(false);
			expect(after.chain.errors.join(" ")).toMatch(/truncation/);
		});

		it("after the recovery, the next append takes the incremental path again: a rows frame, no resync", async () => {
			chmodSync(vaultDir(), 0o000);
			ui = await createUiServer(tempDir, { port: 0 });
			chmodSync(vaultDir(), 0o700);
			await appendOne(tempDir, "tx_recover");
			await summaryWhen(ui.port, (s) => s.chain.events === 4 && s.chain.valid);
			const frame = await readSse(
				ui.port,
				(name) => name === "rows" || name === "resync",
				() => appendOne(tempDir, "tx_incremental"),
			);
			expect(frame.eventName).toBe("rows");
			expect(
				(JSON.parse(frame.data) as Array<{ transferId?: string }>).map((r) => r.transferId),
			).toEqual(["tx_incremental"]);
			expect(await summaryOf(ui.port)).toMatchObject({ chain: { events: 5, valid: true } });
		});

		it("a directory that is STILL unreadable stays a failure: every append is a full reload, never a verdict", async () => {
			chmodSync(vaultDir(), 0o000);
			ui = await createUiServer(tempDir, { port: 0 });
			// The log cannot be appended to while the vault is shut, so the watcher is nudged through reload().
			const frame = await readSse(
				ui.port,
				(name) => name === "resync",
				async () => {
					ui?.reload();
				},
			);
			expect(frame.eventName).toBe("resync");
			const still = await summaryOf(ui.port);
			expect(still.chain.valid).toBe(false);
			expect(couldNotBeRead(still)).toBe(true);
		});

		// Presence and readability are different facts. A directory that can be searched but not listed is still THERE, so
		// deleting it is a deletion; reading "cannot list it" as "never saw it" cleared the alarm to a first run.
		it("red-first (false clean): a directory that was present but unlistable at start, then DELETED, stays a failure", async () => {
			chmodSync(auditDir(), 0o111);
			ui = await createUiServer(tempDir, { port: 0 });
			const before = await summaryOf(ui.port);
			expect(before.chain.valid).toBe(false);
			expect(couldNotBeRead(before)).toBe(true);
			// Driven as the other deletion rows are: remove the directory and wait for the resync's summary frame.
			const { data } = await readSse(
				ui.port,
				(name) => name === "summary",
				async () => {
					chmodSync(auditDir(), 0o700);
					rmSync(auditDir(), { recursive: true, force: true });
				},
			);
			const chain = JSON.parse(data).chain as { valid: boolean; empty: boolean; errors: string[] };
			expect(chain).toMatchObject({ valid: false, empty: false });
			expect(chain.errors.join(" ")).toContain("deletion detected");
			const served = await summaryOf(ui.port);
			expect(served.chain).toMatchObject({ valid: false, empty: false });
			expect(served.chain.errors.join(" ")).toContain("deletion detected");
		});
	},
);

describe("live tail when the audit directory is absent at start", { timeout: 20_000 }, () => {
	let tempDir: string;
	let stage: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-absent-"));
		stage = mkdtempSync(join(tmpdir(), "trust-tail-stage-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
	});

	/** A vault built beside the project and moved into place in one step, so the server sees it appear whole. */
	async function stageVault(count: number): Promise<void> {
		mkdirSync(join(stage, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(stage);
		for (let i = 0; i < count; i++) {
			await writer.appendEvent({
				kind: "llm_call",
				actor: "local",
				data: { cost: 1, settled: true, transferId: `tx_${i}` },
			});
		}
		writer.release();
	}

	it("a VALID log created after the start reads as verified, with every event counted", async () => {
		await stageVault(2);
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true, empty: true });
		renameSync(join(stage, ".usertrust"), join(tempDir, ".usertrust"));
		await appendOne(tempDir, "tx_after");
		const after = await summaryWhen(ui.port, (s) => s.chain.events === 3);
		expect(after.chain).toMatchObject({ events: 3, valid: true, empty: false, breakIndex: null });
		expect(after.chain.errors).toEqual([]);
	});

	// A log the incremental path would call valid: what remains links from genesis. Only the vault's anchor knows an event
	// is missing. Before the first append took a full load, this showed as verified.
	it("red-first (false verified): a TRUNCATED log created after the start reads as broken, never verified", async () => {
		await stageVault(3);
		const log = join(stage, ".usertrust", "audit", "events.jsonl");
		const lines = readFileSync(log, "utf-8").trim().split("\n");
		writeFileSync(log, `${lines.slice(0, 2).join("\n")}\n`);
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain.valid).toBe(true);
		renameSync(join(stage, ".usertrust"), join(tempDir, ".usertrust"));
		// Not only the final state: at NO point may the summary report these events as verified. Polled for a fixed window
		// (past the watcher's 1 s poll), the way the release check probed this case on each tree.
		const seen: Array<{ events: number; valid: boolean }> = [];
		const until = Date.now() + 4000;
		while (Date.now() < until) {
			const s = await summaryOf(ui.port);
			seen.push({ events: s.chain.events, valid: s.chain.valid });
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(seen.some((s) => s.events >= 2)).toBe(true);
		expect(seen.filter((s) => s.events >= 2 && s.valid)).toEqual([]);
		const after = await summaryOf(ui.port);
		expect(after.chain.events).toBe(2);
		expect(after.chain.valid).toBe(false);
		expect(after.chain.errors.join(" ")).toMatch(/truncation/);
	});
});

describe("live tail when the audit directory was readable at start", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-readable-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		await appendOne(tempDir, "tx_seed");
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("the append is delivered incrementally: a rows frame, not a resync, and the verdict stays valid", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const frame = await readSse(
			ui.port,
			(name) => name === "rows" || name === "resync",
			() => appendOne(tempDir, "tx_live"),
		);
		expect(frame.eventName).toBe("rows");
		expect(await summaryOf(ui.port)).toMatchObject({ chain: { events: 2, valid: true } });
	});
});

// A deletion detected while the dashboard is open is latched for the life of the process. A directory recreated in its
// place with a fresh valid chain is not the one that was destroyed, so it may show as rows but never clears the verdict.
describe("a deletion detected while the dashboard is open stays detected when the audit directory is recreated", {
	timeout: 30_000,
}, () => {
	let tempDir: string;
	let stage: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-latch-"));
		stage = mkdtempSync(join(tmpdir(), "trust-tail-latch-stage-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
	});

	const auditDir = (): string => join(tempDir, ".usertrust", "audit");

	async function appendMany(root: string, count: number, prefix: string): Promise<void> {
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

	/** From the deletion on: delete, reload (reads it), recreate with a fresh valid chain, and watch the verdict. */
	async function deleteThenRecreate(port: number, reload: () => void): Promise<void> {
		rmSync(auditDir(), { recursive: true, force: true });
		reload();
		const deleted = await summaryOf(port);
		expect(deleted.chain.valid).toBe(false);
		expect(deleted.chain.errors.join(" ")).toContain("deletion detected");

		mkdirSync(auditDir(), { recursive: true });
		await appendMany(tempDir, 2, "tx_fresh");

		// At NO point after the deletion may the summary read valid. Polled for a fixed window (past the watcher's 1 s
		// poll), so the grow that finds the recreated directory has run, then once more after a reload.
		const seen: Array<{ events: number; valid: boolean; errors: string[] }> = [];
		const until = Date.now() + 4000;
		while (Date.now() < until) {
			const s = await summaryOf(port);
			seen.push({ events: s.chain.events, valid: s.chain.valid, errors: s.chain.errors });
			await new Promise((r) => setTimeout(r, 100));
		}
		// The recreated directory's events were loaded: the grow ran, and what it did not do is clear the verdict.
		expect(seen.some((s) => s.events === 2)).toBe(true);
		expect(seen.filter((s) => s.valid)).toEqual([]);
		expect(seen.filter((s) => !s.errors.some((e) => e.includes("deletion detected")))).toEqual([]);

		reload();
		const after = await summaryOf(port);
		expect(after.chain.events).toBe(2);
		expect(after.chain.valid).toBe(false);
		expect(after.chain.errors.join(" ")).toContain("deletion detected");
		// Only one such error, however many loads carried it.
		expect(after.chain.errors.filter((e) => e.includes("deletion detected"))).toHaveLength(1);
	}

	it("red-first (false clean): absent at start, a valid chain appears, is deleted and recreated: never valid again", async () => {
		mkdirSync(join(stage, ".usertrust", "audit"), { recursive: true });
		await appendMany(stage, 3, "tx_first");
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true, empty: true });
		renameSync(join(stage, ".usertrust"), join(tempDir, ".usertrust"));
		const appeared = await summaryWhen(ui.port, (s) => s.chain.events === 3);
		expect(appeared.chain).toMatchObject({ events: 3, valid: true });
		const server = ui;
		await deleteThenRecreate(ui.port, () => server.reload());
	});

	it("red-first (false clean): readable at start, deleted and recreated with a valid chain: stays a failure", async () => {
		mkdirSync(auditDir(), { recursive: true });
		await appendMany(tempDir, 3, "tx_first");
		ui = await createUiServer(tempDir, { port: 0 });
		expect(await summaryOf(ui.port)).toMatchObject({ chain: { events: 3, valid: true } });
		const server = ui;
		await deleteThenRecreate(ui.port, () => server.reload());
	});

	it("a first run with no audit directory is still not a failure", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		ui.reload();
		expect((await summaryOf(ui.port)).chain).toMatchObject({
			events: 0,
			valid: true,
			empty: true,
			errors: [],
		});
	});
});

// Whichever way the watcher was started, a deletion of the whole audit directory soon after the last change is observed.
// The absent-start (polling) mode used fs.watchFile, which calls back only when its own poll sees a stat change, and the
// poll can land while the directory is half removed: the log is already gone, the resync it triggers reads a directory
// that still exists and holds nothing, and the directory's own removal is no further change to the log's path. The
// dashboard then kept reading a verified, empty chain over a deleted audit directory. rmSync in the test's own process
// cannot show it (it blocks the event loop, so no poll ever lands inside it). The polling row stages the half-removed
// state itself, in two steps with the observation between them, instead of racing a poll against a large `rm -rf`: the
// race needed 60 000 files and a separate process, and a loaded host spent a minute or more only building and removing
// them, so the row measured the filesystem and not the poller.
describe("a deletion soon after the last change is observed", { timeout: 40_000 }, () => {
	let tempDir: string;
	let stage: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-soon-"));
		stage = mkdtempSync(join(tmpdir(), "trust-tail-soon-stage-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
	});

	const auditDir = (): string => join(tempDir, ".usertrust", "audit");
	const isDeletion = (s: ChainSummary): boolean =>
		!s.chain.valid && s.chain.errors.some((e) => e.includes("deletion detected"));

	async function appendMany(root: string, count: number, prefix: string): Promise<void> {
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

	const isDirectoryGone = (s: ChainSummary): boolean =>
		!s.chain.valid && s.chain.errors.some((e) => e.includes("Audit directory not found"));

	/**
	 * From the delivered append on: wait `delayMs`, delete the whole audit directory (no reload), and require the summary
	 * to read the deletion within OBSERVE_BOUND_MS of the removal's END and never go back to valid. Until the directory is
	 * gone, a half-removed one that holds nothing legitimately reads as empty: the deletion is not complete yet.
	 * `observedWhen` is what has to be read, and it is asserted: `summaryWhen` hands back its last summary when the
	 * bound passes, so without the assertion a caller whose predicate never held still passed on a deletion read earlier.
	 * It defaults to the deletion itself.
	 */
	async function deleteAndObserve(
		port: number,
		delayMs: number,
		remove: () => void | Promise<void>,
		observedWhen: (s: ChainSummary) => boolean = isDeletion,
	): Promise<void> {
		await new Promise((r) => setTimeout(r, delayMs));
		await remove();
		const observed = await summaryWhen(port, observedWhen, OBSERVE_BOUND_MS);
		expect(observedWhen(observed)).toBe(true);
		expect(observed.chain.valid).toBe(false);
		expect(observed.chain.errors.join(" ")).toContain("deletion detected");
		// Once read, it is never valid again across a further window past the poll interval.
		const until = Date.now() + 2500;
		while (Date.now() < until) {
			const s = await summaryOf(port);
			expect(s.chain.valid).toBe(false);
			expect(s.chain.errors.join(" ")).toContain("deletion detected");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	// 4000 ms: four 1 s poll intervals past the end of the removal, so a miss is a real miss and a slow runner is not.
	const OBSERVE_BOUND_MS = 4000;

	describe.each([0, 600, 1200])("%i ms after the last append", (delayMs) => {
		it("polling mode (absent at start): the deletion is read within the bound, with no reload", async () => {
			mkdirSync(join(stage, ".usertrust", "audit"), { recursive: true });
			await appendMany(stage, 2, "tx_first");
			ui = await createUiServer(tempDir, { port: 0 });
			expect((await summaryOf(ui.port)).chain).toMatchObject({
				events: 0,
				valid: true,
				empty: true,
			});
			renameSync(join(stage, ".usertrust"), join(tempDir, ".usertrust"));
			const appeared = await summaryWhen(ui.port, (s) => s.chain.events === 2);
			expect(appeared.chain).toMatchObject({ events: 2, valid: true });
			await appendOne(tempDir, "tx_last");
			const delivered = await summaryWhen(ui.port, (s) => s.chain.events === 3);
			expect(delivered.chain).toMatchObject({ events: 3, valid: true });
			// Half removed on purpose: the log and its anchor go first and the directory stays, so the resync the
			// poller asks for reads a directory that exists. Only once that is served is the directory removed, and the
			// poller must then notice the directory itself going: no further change to the log's path follows.
			const port = ui.port;
			await deleteAndObserve(
				port,
				delayMs,
				async () => {
					unlinkSync(join(auditDir(), "events.jsonl"));
					unlinkSync(join(auditDir(), "events.jsonl.meta"));
					// `summaryWhen` returns its last summary when the bound passes, so the first stage is asserted: a watcher
					// that never read the log's removal would otherwise leave this stage on a stale valid summary.
					const logGone = await summaryWhen(port, isDeletion, 15_000);
					expect(isDeletion(logGone)).toBe(true);
					expect(logGone.chain.errors.join(" ")).not.toContain("Audit directory not found");
					rmSync(auditDir(), { recursive: true, force: true });
				},
				isDirectoryGone,
			);
		});

		it("polling mode (absent at start), removed in this process: the same deletion is read too", async () => {
			mkdirSync(join(stage, ".usertrust", "audit"), { recursive: true });
			await appendMany(stage, 2, "tx_first");
			ui = await createUiServer(tempDir, { port: 0 });
			renameSync(join(stage, ".usertrust"), join(tempDir, ".usertrust"));
			await summaryWhen(ui.port, (s) => s.chain.events === 2);
			await appendOne(tempDir, "tx_last");
			const delivered = await summaryWhen(ui.port, (s) => s.chain.events === 3);
			expect(delivered.chain).toMatchObject({ events: 3, valid: true });
			await deleteAndObserve(ui.port, delayMs, () =>
				rmSync(auditDir(), { recursive: true, force: true }),
			);
		});

		it("fs.watch mode (present at start): the deletion is read within the bound, with no reload", async () => {
			mkdirSync(auditDir(), { recursive: true });
			await appendMany(tempDir, 2, "tx_first");
			ui = await createUiServer(tempDir, { port: 0 });
			expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 2, valid: true });
			await appendOne(tempDir, "tx_last");
			const delivered = await summaryWhen(ui.port, (s) => s.chain.events === 3);
			expect(delivered.chain).toMatchObject({ events: 3, valid: true });
			await deleteAndObserve(ui.port, delayMs, () =>
				rmSync(auditDir(), { recursive: true, force: true }),
			);
		});
	});
});

// In the polling mode the poller sees the audit directory appear before the server does. A directory that stays empty
// (or holds only an anchor) never grows, so nothing told the server it exists: its later deletion was classified as a
// first run and read valid and empty. The poller now asks for a load when it first sees the directory appear.
describe("an audit directory that appears while polling and holds no log bytes", {
	timeout: 40_000,
}, () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-appear-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	const auditDir = (): string => join(tempDir, ".usertrust", "audit");
	const isDeletion = (s: ChainSummary): boolean =>
		!s.chain.valid && s.chain.errors.some((e) => e.includes("deletion detected"));

	// Bound: the removal, then up to a few 1 s poll intervals; generous for a slow runner.
	const OBSERVE_BOUND_MS = 6000;

	async function appearThenDelete(populate: () => void): Promise<void> {
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true, empty: true });
		mkdirSync(auditDir(), { recursive: true });
		populate();
		// More than two 1 s poll intervals: the directory stays, and nothing ever grows.
		await new Promise((r) => setTimeout(r, 2500));
		expect((await summaryOf(ui.port)).chain).toMatchObject({ valid: true, empty: true });
		rmSync(auditDir(), { recursive: true, force: true });
		const observed = await summaryWhen(ui.port, isDeletion, OBSERVE_BOUND_MS);
		expect(observed.chain.valid).toBe(false);
		expect(observed.chain.errors.join(" ")).toContain("deletion detected");
		// Once read, it is never a clean first run again, across a polled window past the interval.
		const until = Date.now() + 2500;
		while (Date.now() < until) {
			const s = await summaryOf(ui.port);
			expect(s.chain.valid && s.chain.empty).toBe(false);
			expect(s.chain.valid).toBe(false);
			expect(s.chain.errors.join(" ")).toContain("deletion detected");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	it("red-first (deletion read as a first run): an EMPTY directory that appears, then is deleted, reads as a deletion", async () => {
		await appearThenDelete(() => {});
	});

	it("red-first (deletion read as a first run): a directory holding only an anchor, then deleted, reads as a deletion", async () => {
		await appearThenDelete(() => {
			writeFileSync(
				join(auditDir(), "events.jsonl.meta"),
				JSON.stringify({ lastHash: "0".repeat(64), sequence: 0 }),
			);
		});
	});

	it("red-first (deletion read as a first run): a directory holding only an empty log file, then deleted, reads as a deletion", async () => {
		await appearThenDelete(() => {
			writeFileSync(join(auditDir(), "events.jsonl"), "");
		});
	});

	it("guard: an absent start where nothing ever appears still reads as a first run, at every poll", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const until = Date.now() + 3500;
		while (Date.now() < until) {
			expect((await summaryOf(ui.port)).chain).toMatchObject({
				events: 0,
				valid: true,
				empty: true,
				errors: [],
			});
			await new Promise((r) => setTimeout(r, 250));
		}
	});

	it("guard: nothing appearing delivers no resync and no grow at the watcher", async () => {
		const delivered: string[] = [];
		const stop = watchLedger(join(tempDir, ".usertrust"), () => 0, {
			onGrow: () => delivered.push("grow"),
			onResync: () => delivered.push("resync"),
		});
		try {
			await new Promise((r) => setTimeout(r, 3500));
			expect(delivered).toEqual([]);
		} finally {
			stop();
		}
	});

	it("guard: the resync on appearance is delivered once, not every interval", async () => {
		const vault = join(tempDir, ".usertrust");
		const delivered: string[] = [];
		const stop = watchLedger(vault, () => 0, {
			onGrow: () => delivered.push("grow"),
			onResync: () => delivered.push("resync"),
		});
		try {
			// Positive control: nothing has been delivered while the directory is absent.
			await new Promise((r) => setTimeout(r, 1500));
			expect(delivered).toEqual([]);
			mkdirSync(join(vault, "audit"), { recursive: true });
			// Four or more 1 s intervals with the directory present.
			await new Promise((r) => setTimeout(r, 4500));
			expect(delivered).toEqual(["resync"]);
		} finally {
			stop();
		}
	});
});

// The incremental append path only extends a verdict. A load that saw no log bytes (the directory absent or unlistable, or
// present with no log yet) derived its verdict from nothing, so a log that arrives afterwards must be checked in FULL: a
// truncated log still links from genesis, and only the vault's own anchor check sees what is missing.
describe("a log that arrives after a load that saw no log bytes is checked in full", {
	timeout: 40_000,
}, () => {
	let tempDir: string;
	let stage: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-nobytes-"));
		stage = mkdtempSync(join(tmpdir(), "trust-tail-nobytes-stage-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(stage, { recursive: true, force: true });
	});

	const auditDir = (): string => join(tempDir, ".usertrust", "audit");

	/** A vault of `count` events built in its own directory under `root`, returning its log text and its anchor text. */
	async function buildVault(root: string, count: number, prefix: string) {
		mkdirSync(join(root, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(root);
		for (let i = 0; i < count; i++) {
			await writer.appendEvent({
				kind: "llm_call",
				actor: "local",
				data: { cost: 1, settled: true, transferId: `${prefix}_${i}` },
			});
		}
		writer.release();
		const dir = join(root, ".usertrust", "audit");
		return {
			log: readFileSync(join(dir, "events.jsonl"), "utf-8"),
			meta: readFileSync(join(dir, "events.jsonl.meta"), "utf-8"),
		};
	}

	/** Puts a file in place in one step (a rename from the staging directory), so a reader never sees it half written. */
	function place(name: string, text: string): void {
		const from = join(stage, `incoming-${name}`);
		writeFileSync(from, text);
		renameSync(from, join(auditDir(), name));
	}

	/** The anchor first, then a log that is one event short of it. */
	async function deliverTruncated(): Promise<void> {
		const built = await buildVault(join(stage, "a"), 3, "tx");
		const lines = built.log.trim().split("\n");
		place("events.jsonl.meta", built.meta);
		place("events.jsonl", `${lines.slice(0, 2).join("\n")}\n`);
	}

	/** The anchor of ANOTHER vault first, then a whole log of four events whose head that anchor does not record. */
	async function deliverMismatched(): Promise<void> {
		const other = await buildVault(join(stage, "other"), 3, "other");
		const mine = await buildVault(join(stage, "mine"), 4, "mine");
		place("events.jsonl.meta", other.meta);
		place("events.jsonl", mine.log);
	}

	/** Polls for a fixed window past the watcher's interval: no sample may show a log's events as verified. */
	async function expectNeverVerifiedThenInvalid(minEvents: number): Promise<void> {
		if (ui === undefined) throw new Error("no server");
		const seen: Array<{ events: number; valid: boolean }> = [];
		const until = Date.now() + 4500;
		while (Date.now() < until) {
			const s = await summaryOf(ui.port);
			seen.push({ events: s.chain.events, valid: s.chain.valid });
			await new Promise((r) => setTimeout(r, 100));
		}
		// Positive control: the events really were loaded, so the window saw the log and not only the empty state.
		expect(seen.some((s) => s.events >= minEvents)).toBe(true);
		expect(seen.filter((s) => s.events >= 1 && s.valid)).toEqual([]);
		const after = await summaryOf(ui.port);
		expect(after.chain.events).toBeGreaterThanOrEqual(minEvents);
		expect(after.chain.valid).toBe(false);
	}

	it("(a) polling mode: an empty directory appears and is loaded, then a TRUNCATED log arrives: never verified", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true, empty: true });
		mkdirSync(auditDir(), { recursive: true });
		// Past one interval: the appearance has been delivered and loaded, and that load saw no log bytes.
		await new Promise((r) => setTimeout(r, 2500));
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true });
		await deliverTruncated();
		await expectNeverVerifiedThenInvalid(2);
	});

	it("(b) polling mode: an empty directory appears and is loaded, then a log with a MISMATCHED anchor arrives: never verified", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true, empty: true });
		mkdirSync(auditDir(), { recursive: true });
		await new Promise((r) => setTimeout(r, 2500));
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true });
		await deliverMismatched();
		await expectNeverVerifiedThenInvalid(4);
	});

	it("(c) fs.watch mode: a start with an EMPTY audit directory, then a TRUNCATED log and its anchor: never verified", async () => {
		mkdirSync(auditDir(), { recursive: true });
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true });
		await deliverTruncated();
		await expectNeverVerifiedThenInvalid(2);
	});

	it("(c) fs.watch mode: a start with an EMPTY audit directory, then a log with a MISMATCHED anchor: never verified", async () => {
		mkdirSync(auditDir(), { recursive: true });
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true });
		await deliverMismatched();
		await expectNeverVerifiedThenInvalid(4);
	});

	it("(d) polling mode: a directory appears holding ONLY an anchor that records events: it reads red before any deletion", async () => {
		const built = await buildVault(join(stage, "a"), 3, "tx");
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await summaryOf(ui.port)).chain).toMatchObject({ events: 0, valid: true, empty: true });
		// The whole audit directory appears in one step, holding the anchor and no log.
		const incoming = join(stage, "incoming-audit");
		mkdirSync(incoming);
		writeFileSync(join(incoming, "events.jsonl.meta"), built.meta);
		mkdirSync(join(tempDir, ".usertrust"), { recursive: true });
		renameSync(incoming, auditDir());
		const red = await summaryWhen(ui.port, (s) => !s.chain.valid, 6000);
		expect(red.chain.valid).toBe(false);
		expect(red.chain.empty).toBe(false);
		expect(red.chain.errors.length).toBeGreaterThan(0);
		// It stays red across a polled window: never "No governed calls yet".
		const until = Date.now() + 2500;
		while (Date.now() < until) {
			const s = await summaryOf(ui.port);
			expect(s.chain.valid).toBe(false);
			expect(s.chain.empty).toBe(false);
			await new Promise((r) => setTimeout(r, 100));
		}
	});
});

// The polling mode runs its own interval. A leaked poller is the classic failure of that design: it must stop when the
// watcher is stopped (the server's close() stops it), and must never keep the process alive on its own.
describe("the polling watcher's own interval", { timeout: 20_000 }, () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "trust-tail-poller-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(vault, { recursive: true, force: true });
	});

	it("a stopped watcher polls no more, and reacts to nothing after it is stopped", async () => {
		let polls = 0;
		const delivered: string[] = [];
		const stop = watchLedger(
			vault,
			() => {
				polls++;
				return 0;
			},
			{ onGrow: () => delivered.push("grow"), onResync: () => delivered.push("resync") },
		);
		// Positive control: the audit directory is absent, so this is the polling mode, and it is polling.
		await new Promise((r) => setTimeout(r, 2500));
		expect(polls).toBeGreaterThan(0);
		stop();
		const atStop = polls;
		// A log appearing would be a grow if anything were still polling.
		mkdirSync(join(vault, "audit"), { recursive: true });
		writeFileSync(join(vault, "audit", "events.jsonl"), "{}\n");
		await new Promise((r) => setTimeout(r, 2500));
		expect(polls).toBe(atStop);
		expect(delivered).toEqual([]);
	});

	it("the polling interval never keeps the process alive on its own (it is unref'd)", () => {
		const spy = vi.spyOn(globalThis, "setInterval");
		const stop = watchLedger(vault, () => 0, { onGrow: () => {}, onResync: () => {} });
		try {
			// Positive control: the polling mode really made an interval.
			expect(spy).toHaveBeenCalledTimes(1);
			const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
			expect(timer.hasRef()).toBe(false);
		} finally {
			stop();
		}
	});
});

// In fs.watch mode (the audit directory present at start), nothing but a file-change event used to run a check, and the
// operating system can deliver one late or never: on macOS, an append's event was observed about 45 s late while another
// test suite was running, and the dashboard showed nothing new until a later write. A backstop checks the log every
// second. These rows replace fs.watch with a stub that never calls back, so whatever they observe came from the backstop.
// The watcher-level rows use vitest's fake timers at the production interval, so each tick is placed exactly and the
// bound is the real one; the server-level rows use real timers and a shortened interval, because they wait on HTTP.
class StubWatcher extends EventEmitter {
	closed = 0;
	close(): void {
		this.closed++;
	}
}

describe("fs.watch mode's backstop when file-change events arrive late or never", {
	timeout: 20_000,
}, () => {
	const original = { ...__tailTestSeam };
	let stubs: StubWatcher[];
	let vault: string;
	const auditDir = (): string => join(vault, "audit");
	const logPath = (): string => join(auditDir(), "events.jsonl");

	beforeEach(() => {
		stubs = [];
		// Like fs.watch, the stub throws on a directory that does not exist, so an absent start is still the polling mode.
		__tailTestSeam.watch = ((dir: string) => {
			if (!existsSync(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
			const w = new StubWatcher();
			stubs.push(w);
			return w;
		}) as unknown as typeof __tailTestSeam.watch;
		vault = mkdtempSync(join(tmpdir(), "trust-tail-backstop-"));
		mkdirSync(auditDir(), { recursive: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		Object.assign(__tailTestSeam, original);
		rmSync(vault, { recursive: true, force: true });
	});

	/**
	 * Starts the watcher over the vault with a known size the row controls, recording what it delivers. `auditDirId` is
	 * the audit directory's identity as the server recorded it (none by default).
	 */
	function start(known: () => number, auditDirId?: () => string | undefined) {
		const delivered: string[] = [];
		let sizeOfCalls = 0;
		const stop = watchLedger(
			vault,
			() => {
				sizeOfCalls++;
				return known();
			},
			{ onGrow: () => delivered.push("grow"), onResync: () => delivered.push("resync") },
			undefined,
			auditDirId,
		);
		return { delivered, stop, sizeOfCalls: () => sizeOfCalls };
	}

	const BOUND = 1000;
	const tick = (n = 1): void => {
		vi.advanceTimersByTime(BOUND * n);
	};

	describe("at the watcher", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			expect(__tailTestSeam.backstopMs).toBe(BOUND);
		});

		it("red-first (never seen): an append with no event reaches the server within one interval", () => {
			writeFileSync(logPath(), "{}\n");
			const w = start(() => 3);
			try {
				expect(stubs).toHaveLength(1);
				tick();
				expect(w.delivered).toEqual([]);
				appendFileSync(logPath(), "{}\n");
				tick();
				expect(w.delivered).toEqual(["grow"]);
			} finally {
				w.stop();
			}
		});

		it("red-first (never seen): the audit directory's removal with no event reaches the server within one interval", () => {
			writeFileSync(logPath(), "{}\n");
			const w = start(() => 3);
			try {
				tick();
				expect(w.delivered).toEqual([]);
				rmSync(auditDir(), { recursive: true, force: true });
				tick();
				expect(w.delivered).toEqual(["resync"]);
			} finally {
				w.stop();
			}
		});

		it("red-first (read every tick): a torn last line is read once, not once per tick", () => {
			// A complete line, then a writer that died mid-line: the known size stops at the newline.
			writeFileSync(logPath(), '{}\n{"partial');
			const w = start(() => 3);
			try {
				tick(10);
				expect(w.delivered).toEqual(["grow"]);
			} finally {
				w.stop();
			}
		});

		it("guard: an unchanged log over many intervals delivers nothing", () => {
			writeFileSync(logPath(), "{}\n");
			const w = start(() => 3);
			try {
				tick(10);
				expect(w.delivered).toEqual([]);
			} finally {
				w.stop();
			}
		});

		it("red-first (memo never re-armed): a change of mtime alone, at the same size, checks again", () => {
			writeFileSync(logPath(), '{}\n{"partial');
			const w = start(() => 3);
			try {
				tick(3);
				expect(w.delivered).toEqual(["grow"]);
				utimesSync(logPath(), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
				tick(3);
				expect(w.delivered).toEqual(["grow", "grow"]);
			} finally {
				w.stop();
			}
		});

		it("red-first (memo never re-armed): a change of the known size alone checks again", () => {
			writeFileSync(logPath(), '{}\n{"partial');
			let known = 3;
			const w = start(() => known);
			try {
				tick(3);
				expect(w.delivered).toEqual(["grow"]);
				known = 2;
				tick(3);
				expect(w.delivered).toEqual(["grow", "grow"]);
			} finally {
				w.stop();
			}
		});

		it("red-first (memo hides a replacement): two stats that differ only in an inode above 2^53 check again", () => {
			// Windows file ids are 64-bit: as JS numbers, 2^53 and 2^53 + 1 are one value.
			writeFileSync(logPath(), '{}\n{"partial');
			let ino = 2n ** 53n;
			__tailTestSeam.statLog = (p) => ({ ...statSync(p, { bigint: true }), ino });
			const w = start(() => 3);
			try {
				tick(3);
				expect(w.delivered).toEqual(["grow"]);
				ino = 2n ** 53n + 1n;
				expect(Number(ino)).toBe(Number(2n ** 53n));
				tick(3);
				expect(w.delivered).toEqual(["grow", "grow"]);
			} finally {
				w.stop();
			}
		});

		it("red-first (reload every tick): a stat error resyncs once, and the same error with the same known size never again", () => {
			writeFileSync(logPath(), "{}\n");
			const w = start(() => 3);
			try {
				tick();
				rmSync(logPath());
				tick(10);
				expect(w.delivered).toEqual(["resync"]);
			} finally {
				w.stop();
			}
		});

		const noLogBytes: Array<[string, () => void]> = [
			["no log", () => {}],
			[
				"only an anchor",
				() =>
					writeFileSync(
						`${logPath()}.meta`,
						JSON.stringify({ lastHash: "0".repeat(64), sequence: 0 }),
					),
			],
			["an empty log", () => writeFileSync(logPath(), "")],
		];
		/** The audit directory's identity now, as the server records it when it first sees the directory. */
		const dirIdentity = (): string => {
			const st = statSync(auditDir(), { bigint: true });
			return st.birthtimeNs === 0n
				? `${st.dev}:${st.ino}`
				: `${st.dev}:${st.ino}:${st.birthtimeNs}`;
		};

		// A directory that held no log bytes changes no size when it is deleted (an absent log reads as 0, and so does the
		// known size): the directory's own identity is what sees it, on the backstop with no event at all.
		it.each(noLogBytes)(
			"red-first (deletion read as a first run): a directory holding %s, present at start and then deleted, delivers one resync",
			(_name, populate) => {
				populate();
				const recorded = dirIdentity();
				const w = start(
					() => 0,
					() => recorded,
				);
				try {
					tick(2);
					expect(w.delivered).toEqual([]);
					rmSync(auditDir(), { recursive: true, force: true });
					tick(10);
					expect(w.delivered).toEqual(["resync"]);
				} finally {
					w.stop();
				}
			},
		);

		it.each(noLogBytes)(
			"red-first (false clean): a directory holding %s, replaced in one step by another, delivers one resync",
			(_name, populate) => {
				populate();
				const recorded = dirIdentity();
				const w = start(
					() => 0,
					() => recorded,
				);
				try {
					tick(2);
					const other = `${auditDir()}.next`;
					mkdirSync(other);
					rmSync(auditDir(), { recursive: true, force: true });
					renameSync(other, auditDir());
					populate();
					tick(10);
					expect(w.delivered).toEqual(["resync"]);
				} finally {
					w.stop();
				}
			},
		);

		it("guard: with no recorded directory identity, a deletion that changes no size delivers nothing", () => {
			const w = start(() => 0);
			try {
				tick(2);
				rmSync(auditDir(), { recursive: true, force: true });
				tick(10);
				expect(w.delivered).toEqual([]);
			} finally {
				w.stop();
			}
		});

		it("red-first (crash): a watcher error closes the watcher, throws nothing, and the backstop still sees an append", () => {
			writeFileSync(logPath(), "{}\n");
			const w = start(() => 3);
			try {
				const stub = stubs[0] as StubWatcher;
				expect(() =>
					stub.emit("error", Object.assign(new Error("EPERM"), { code: "EPERM" })),
				).not.toThrow();
				expect(stub.closed).toBe(1);
				appendFileSync(logPath(), "{}\n");
				tick();
				expect(w.delivered).toEqual(["grow"]);
				w.stop();
				// Dropped at the error: stopping does not close it a second time.
				expect(stub.closed).toBe(1);
			} finally {
				w.stop();
			}
		});

		describe("full loads at an unchanged size, and on a schedule", () => {
			/**
			 * The log's identity and timestamps now, as a load records them: through the stat seam, so a row that drives the
			 * timestamps there records the ones the watcher sees.
			 */
			const recorded = (): {
				id: string | undefined;
				times: { mtimeNs: bigint; ctimeNs: bigint };
			} => {
				const st = __tailTestSeam.statLog(logPath());
				return {
					id: fileIdentity(st),
					times: { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs },
				};
			};

			/**
			 * The watcher with a known identity, as the server runs it: a resync records the log's new timestamps, as the
			 * full load it asks for would. `failed` says whether the last full load failed.
			 */
			function startLoaded(opts: { failed?: () => boolean; onReverify?: () => void } = {}) {
				let held = recorded();
				const delivered: { what: string; at: number }[] = [];
				const stop = watchLedger(
					vault,
					() => 3,
					{
						onGrow: () => delivered.push({ what: "grow", at: Date.now() }),
						onResync: () => {
							delivered.push({ what: "resync", at: Date.now() });
							held = recorded();
						},
						...(opts.onReverify !== undefined ? { onReverify: opts.onReverify } : {}),
					},
					() => held.id,
					undefined,
					() => held.times,
					opts.failed,
				);
				return { delivered, stop, what: () => delivered.map((d) => d.what) };
			}

			beforeEach(() => {
				__tailTestSeam.now = () => Date.now();
				writeFileSync(logPath(), "{}\n");
			});

			/**
			 * A row that needs a timestamp to move must observe it moving, or drive it through the seam. On a kernel whose
			 * file timestamps advance on a coarse clock (a jiffy, a few milliseconds), a churn of `chmod` calls inside one
			 * tick leaves ctime unchanged: a row that counted on the kernel moving it saw no reload at all on a Linux CI
			 * runner. These rows hand the watcher each churn step's ctime through `statLog`, at the real size and identity.
			 * `distinct` false is that coarse clock: every step reports the ctime the load recorded.
			 */
			function churnThroughSeam(steps: number, distinct: boolean) {
				const real = __tailTestSeam.statLog;
				const base = real(logPath()).ctimeNs;
				let step = 0;
				__tailTestSeam.statLog = (p) => {
					const st = real(p);
					return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
						ctimeNs: distinct ? base + BigInt(step) * 1_000_000n : base,
					});
				};
				const w = startLoaded();
				try {
					for (let i = 0; i < steps; i++) {
						// One mode change: a new ctime at the same size, and the check that sees it.
						step += 1;
						tick();
					}
					return w.delivered.filter((d) => d.what === "resync").map((d) => d.at);
				} finally {
					w.stop();
				}
			}

			it("guard (a reload per ctime change): a mode-change churn at an unchanged size reloads at most once per window", () => {
				__tailTestSeam.sameSizeReloadMs = 5 * BOUND;
				const start = Date.now();
				const ats = churnThroughSeam(30, true);
				// Positive control: the churn is seen at all, the change holding on two consecutive checks (the second tick).
				expect(ats[0]).toBe(start + 2 * BOUND);
				// A second window allows one more, and no window allows two.
				expect(ats.length).toBeGreaterThanOrEqual(2);
				expect(ats.length).toBeLessThanOrEqual(Math.ceil(30 / 5));
				for (let i = 1; i < ats.length; i++) {
					expect((ats[i] ?? 0) - (ats[i - 1] ?? 0)).toBeGreaterThanOrEqual(5 * BOUND);
				}
			});

			it("a coarse timestamp clock (the same ctime at every churn step) reloads nothing: why the row above drives ctime through the seam", () => {
				__tailTestSeam.sameSizeReloadMs = 5 * BOUND;
				expect(churnThroughSeam(30, false)).toEqual([]);
			});

			it("on the real file system: a chmod loop whose every ctime change is OBSERVED reloads exactly once in one window", () => {
				__tailTestSeam.sameSizeReloadMs = 60 * BOUND;
				// A synchronous wait the fake timers do not touch: each wait is at least 25 ms, so 80 of them span at least 2 s.
				const pause = new Int32Array(new SharedArrayBuffer(4));
				const ctime = (): bigint => statSync(logPath(), { bigint: true }).ctimeNs;
				const w = startLoaded();
				try {
					tick(2);
					expect(w.what()).toEqual([]);
					let mode = statSync(logPath()).mode & 0o777;
					const toggle = (): void => {
						mode = mode === 0o600 ? 0o644 : 0o600;
						chmodSync(logPath(), mode);
					};
					for (let i = 0; i < 5; i++) {
						const before = ctime();
						toggle();
						let waits = 0;
						// ctime is stamped when the inode changes: a chmod inside the same clock tick as the change before it
						// leaves ctime as it was, and waiting alone never moves it. So the mode is changed again after each
						// pause, back and forth, until a change lands in a later tick.
						while (ctime() === before) {
							if (waits >= 80)
								throw new Error(
									"ctime did not change within 2 s of repeated chmods: the file system's timestamp clock is coarser than the bound",
								);
							Atomics.wait(pause, 0, 0, 25);
							waits += 1;
							toggle();
						}
						tick();
					}
					// The first change, held on two consecutive checks, reloads once; every later one waits on the window.
					expect(w.what()).toEqual(["resync"]);
				} finally {
					w.stop();
				}
			});

			it("guard (a reload inside an append): new timestamps at the old size on one check, then the size catching up, is a grow and never a reload", () => {
				// The seam is read when the watcher starts: the stat it gets moves the times only while `midAppend` is set.
				const real = __tailTestSeam.statLog;
				let midAppend = false;
				__tailTestSeam.statLog = (p) => {
					const st = real(p);
					if (!midAppend) return st;
					return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
						mtimeNs: st.mtimeNs + 1_000_000n,
						ctimeNs: st.ctimeNs + 1_000_000n,
					});
				};
				const w = startLoaded();
				try {
					tick(2);
					expect(w.what()).toEqual([]);
					// The first half of an append, as Linux can show it: the times moved, the size not yet.
					midAppend = true;
					tick();
					expect(w.what()).toEqual([]);
					midAppend = false;
					appendFileSync(logPath(), "{}\n");
					tick(3);
					expect(w.what()).toEqual(["grow"]);
				} finally {
					w.stop();
				}
			});

			it("a same-length rewrite in place (new times at the same size, on two checks) reloads once", () => {
				const w = startLoaded();
				try {
					tick(2);
					writeFileSync(logPath(), "[]\n");
					utimesSync(logPath(), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
					tick();
					expect(w.what()).toEqual([]);
					tick();
					expect(w.what()).toEqual(["resync"]);
					tick(5);
					expect(w.what()).toEqual(["resync"]);
				} finally {
					w.stop();
				}
			});

			it("after a full load that failed, nothing changed: the read is retried once per retry window, until a load succeeds", () => {
				__tailTestSeam.failedReadRetryMs = 5 * BOUND;
				let failed = true;
				const w = startLoaded({ failed: () => failed });
				try {
					// The failure is first seen at the first tick; the window runs from there.
					tick(5);
					expect(w.what()).toEqual([]);
					tick(1);
					expect(w.what()).toEqual(["resync"]);
					tick(5);
					expect(w.what()).toEqual(["resync", "resync"]);
					failed = false;
					tick(10);
					expect(w.what()).toEqual(["resync", "resync"]);
				} finally {
					w.stop();
				}
			});

			// The rows below count reloads over N ticks against the bound ceil(N x tick / retry): a retry on every tick
			// fails the first.
			const N = 60;
			const RETRY = 7 * BOUND;
			const bound = Math.ceil((N * BOUND) / RETRY);

			it("red-first (a reload per tick): a read that keeps failing, with nothing changed, reloads at most once per retry window", () => {
				__tailTestSeam.failedReadRetryMs = RETRY;
				const w = startLoaded({ failed: () => true });
				try {
					tick(N);
					const resyncs = w.delivered.filter((d) => d.what === "resync");
					// Positive control: the failed read is retried at all.
					expect(resyncs.length).toBeGreaterThanOrEqual(1);
					expect(resyncs.length).toBeLessThanOrEqual(bound);
					const ats = resyncs.map((d) => d.at);
					for (let i = 1; i < ats.length; i++) {
						expect((ats[i] ?? 0) - (ats[i - 1] ?? 0)).toBeGreaterThanOrEqual(RETRY);
					}
					expect(w.what().filter((x) => x !== "resync")).toEqual([]);
				} finally {
					w.stop();
				}
			});

			it("the same when the log itself cannot be stat'd: a stat error that stays the same reloads at most once per window", () => {
				__tailTestSeam.failedReadRetryMs = RETRY;
				__tailTestSeam.statLog = () => {
					throw Object.assign(new Error("EACCES"), { code: "EACCES" });
				};
				const delivered: string[] = [];
				const stop = watchLedger(
					vault,
					() => 0,
					{ onGrow: () => delivered.push("grow"), onResync: () => delivered.push("resync") },
					() => undefined,
					undefined,
					() => undefined,
					() => true,
				);
				try {
					tick(N);
					expect(delivered.length).toBeGreaterThanOrEqual(1);
					expect(delivered.length).toBeLessThanOrEqual(bound);
				} finally {
					stop();
				}
			});

			it("recovery: once the read succeeds again, the reloads stop; the retry that succeeded came within one window", () => {
				__tailTestSeam.failedReadRetryMs = RETRY;
				let failed = true;
				// The caller's load succeeds from `readableAt` on, as a read of a vault made readable again does.
				let readableAt = Number.POSITIVE_INFINITY;
				let recoveredAt: number | undefined;
				let held = recorded();
				const delivered: number[] = [];
				const stop = watchLedger(
					vault,
					() => 3,
					{
						onGrow: () => {},
						onResync: () => {
							delivered.push(Date.now());
							held = recorded();
							if (Date.now() >= readableAt) {
								failed = false;
								recoveredAt ??= Date.now();
							}
						},
					},
					() => held.id,
					undefined,
					() => held.times,
					() => failed,
				);
				try {
					tick(17);
					readableAt = Date.now();
					tick(RETRY / BOUND);
					expect(recoveredAt).toBeDefined();
					expect((recoveredAt ?? 0) - readableAt).toBeLessThanOrEqual(RETRY);
					const count = delivered.length;
					tick(N);
					expect(delivered.length).toBe(count);
				} finally {
					stop();
				}
			});

			it("a grow while the read keeps failing reloads at the next check, without waiting for the retry window", () => {
				__tailTestSeam.failedReadRetryMs = 1000 * BOUND;
				const w = startLoaded({ failed: () => true });
				try {
					tick(3);
					expect(w.what()).toEqual([]);
					appendFileSync(logPath(), "{}\n");
					tick();
					// The known size is the row's own (3), so the grow is delivered as a grow: the server makes it a full load.
					expect(w.what()).toEqual(["grow"]);
					tick(5);
					expect(w.what()).toEqual(["grow"]);
					// A same-size change the key shows (new timestamps) goes on at once too.
					utimesSync(logPath(), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
					tick();
					expect(w.what()).toEqual(["grow", "grow"]);
				} finally {
					w.stop();
				}
			});

			it("the periodic re-verify runs on its interval, and stops with the watcher", () => {
				__tailTestSeam.reverifyMs = 5 * BOUND;
				let reverified = 0;
				const w = startLoaded({
					onReverify: () => {
						reverified += 1;
					},
				});
				try {
					tick(4);
					expect(reverified).toBe(0);
					tick(1);
					expect(reverified).toBe(1);
					tick(10);
					expect(reverified).toBe(3);
					// It is a full load of its own, not a check: nothing is delivered through the check's callbacks.
					expect(w.what()).toEqual([]);
				} finally {
					w.stop();
				}
				expect(vi.getTimerCount()).toBe(0);
				tick(20);
				expect(reverified).toBe(3);
			});
		});

		it("red-first (leak): a stopped watcher checks no more, and reacts to nothing after it is stopped", () => {
			writeFileSync(logPath(), "{}\n");
			const w = start(() => 3);
			tick(3);
			// Positive control: the backstop really was ticking.
			expect(w.sizeOfCalls()).toBeGreaterThan(0);
			w.stop();
			expect(vi.getTimerCount()).toBe(0);
			const atStop = w.sizeOfCalls();
			appendFileSync(logPath(), "{}\n");
			tick(5);
			expect(w.sizeOfCalls()).toBe(atStop);
			expect(w.delivered).toEqual([]);
		});
	});

	it("the periodic re-verify interval is unref'd", () => {
		__tailTestSeam.reverifyMs = 3_600_002;
		const spy = vi.spyOn(globalThis, "setInterval");
		const stop = watchLedger(vault, () => 0, {
			onGrow: () => {},
			onResync: () => {},
			onReverify: () => {},
		});
		try {
			const call = spy.mock.calls.findIndex((c) => c[1] === 3_600_002);
			expect(call).not.toBe(-1);
			const timer = spy.mock.results[call]?.value as NodeJS.Timeout;
			expect(timer.hasRef()).toBe(false);
		} finally {
			stop();
		}
	});

	it("red-first (keeps the process alive): the backstop interval is unref'd", () => {
		const spy = vi.spyOn(globalThis, "setInterval");
		const w = start(() => 0);
		try {
			// Positive control: fs.watch mode really made an interval (the stub watcher was used, not the polling mode).
			expect(stubs).toHaveLength(1);
			expect(spy).toHaveBeenCalledTimes(1);
			const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
			expect(timer.hasRef()).toBe(false);
		} finally {
			w.stop();
		}
	});

	describe("through the server", () => {
		let root: string;
		let ui: UiServer | undefined;
		const rootAudit = (): string => join(root, ".usertrust", "audit");
		const isDeletion = (s: ChainSummary): boolean =>
			!s.chain.valid && s.chain.errors.some((e) => e.includes("deletion detected"));

		beforeEach(async () => {
			__tailTestSeam.backstopMs = 100;
			root = mkdtempSync(join(tmpdir(), "trust-tail-backstop-ui-"));
			mkdirSync(rootAudit(), { recursive: true });
			for (let i = 0; i < 3; i++) await appendOne(root, `tx_first_${i}`);
		});

		afterEach(async () => {
			await ui?.close();
			ui = undefined;
			rmSync(root, { recursive: true, force: true });
		});

		it("red-first (never seen): an append with no event reaches the client as rows", async () => {
			ui = await createUiServer(root, { port: 0 });
			expect(stubs).toHaveLength(1);
			// readSse waits on the stream itself, so a frame that never comes would hang it: the race fails the row instead.
			const frame = await Promise.race([
				readSse(
					ui.port,
					(name) => name === "rows" || name === "resync",
					() => appendOne(root, "tx_live"),
					3000,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("no frame within 3 s")), 3000),
				),
			]);
			expect(frame.eventName).toBe("rows");
			expect(await summaryOf(ui.port)).toMatchObject({ chain: { events: 4, valid: true } });
		});

		it("red-first (never seen): the audit directory's deletion with no event reads as a deletion", async () => {
			ui = await createUiServer(root, { port: 0 });
			rmSync(rootAudit(), { recursive: true, force: true });
			const observed = await summaryWhen(ui.port, isDeletion, 3000);
			expect(observed.chain.valid).toBe(false);
			expect(observed.chain.errors.join(" ")).toContain("deletion detected");
		});

		it("guard: deleted, then recreated with a valid chain, never reads valid again", async () => {
			ui = await createUiServer(root, { port: 0 });
			rmSync(rootAudit(), { recursive: true, force: true });
			// Several intervals with the directory gone, so the backstop has had its chance to see the deletion.
			await new Promise((r) => setTimeout(r, 600));
			mkdirSync(rootAudit(), { recursive: true });
			for (let i = 0; i < 2; i++) await appendOne(root, `tx_fresh_${i}`);
			const seen: ChainSummary["chain"][] = [];
			const until = Date.now() + 1500;
			while (Date.now() < until) {
				seen.push((await summaryOf(ui.port)).chain);
				await new Promise((r) => setTimeout(r, 50));
			}
			// The recreated chain is never shown as verified, and once the deletion is read, nothing after it is valid.
			expect(seen.filter((c) => c.valid && c.events === 2)).toEqual([]);
			const firstDeletion = seen.findIndex((c) => isDeletion({ chain: c }));
			if (firstDeletion !== -1)
				expect(seen.slice(firstDeletion).filter((c) => c.valid)).toEqual([]);
		});
	});
});
