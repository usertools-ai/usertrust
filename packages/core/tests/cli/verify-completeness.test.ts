// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust verify` and `usertrust health` report COMPLETENESS beside integrity. A chain with an
 * event missing still verifies link by link; every event that failed to reach the chain is
 * dead-lettered, and a vault with one that is not on the chain is INCOMPLETE: verify exits 1
 * (`success: false`, `complete: false`, `valid` still true), and health's chain line is critical.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { type ChainEventView, readChainDeadLetters } from "../../src/audit/dead-letters.js";
import { run as healthRun } from "../../src/cli/health.js";
import { run as verifyRun } from "../../src/cli/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-verify-complete-"));
	mkdirSync(join(tempDir, VAULT_DIR, "audit"), { recursive: true });
	out = [];
	// A verdict that succeeds never sets the exit code: start each row from 0, whatever ran before it.
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		out.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
	rmSync(tempDir, { recursive: true, force: true });
});

const vaultDir = () => join(tempDir, VAULT_DIR);
const dlqPath = () => join(vaultDir(), "dlq", "dead-letters.jsonl");
const json = () =>
	JSON.parse(out.join("\n")) as { success: boolean; data: Record<string, unknown> };
/** The printed text without colour: under CI, picocolors colours every verdict line. */
const ESC = String.fromCharCode(27);
const plain = () => out.join("\n").replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/**
 * A dead letter as the writer seals it: SHA-256 over the canonical record, then `checksum` and
 * `checksumAlg` after its own keys. (The rows built by the real writer below check the same rule
 * from the other side.)
 */
function sealed(entry: Record<string, unknown>): string {
	const checksum = createHash("sha256").update(canonicalize(entry)).digest("hex");
	return JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });
}
const deadLetterLines = () =>
	readFileSync(dlqPath(), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
const noEvent = (): ChainEventView | undefined => undefined;

/**
 * tx_1 on the chain; then tx_2's event reaches the chain but its `.meta` update fails (a directory
 * in its place), so the append rejects, the receipt would be AUDIT_DEGRADED, and the writer
 * dead-letters the event WITH its hash. Returns both events' hashes.
 */
async function vaultWithMetaOnlyFailure(): Promise<{ h1: string; h2: string }> {
	const a = createAuditWriter(tempDir);
	try {
		const e1 = await a.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_1" },
		});
		const meta = join(vaultDir(), "audit", "events.jsonl.meta");
		rmSync(meta);
		mkdirSync(meta);
		await expect(
			a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_2" } }),
		).rejects.toThrow();
		const log = readFileSync(join(vaultDir(), "audit", "events.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(log).toHaveLength(2);
		const h2 = (JSON.parse(log[1] ?? "{}") as { hash: string }).hash;
		rmSync(meta, { recursive: true });
		return { h1: e1.hash, h2 };
	} finally {
		a.release();
	}
}

/**
 * Append `input` through `writer` so that its bytes reach the chain but its `.meta` update fails (a
 * directory in the anchor's place): the append rejects, and the writer dead-letters the event WITH
 * its hash. Returns the event's hash, read back from the log.
 */
async function appendWithMetaFailure(
	writer: ReturnType<typeof createAuditWriter>,
	input: Parameters<ReturnType<typeof createAuditWriter>["appendEvent"]>[0],
): Promise<string> {
	const meta = join(vaultDir(), "audit", "events.jsonl.meta");
	rmSync(meta, { force: true });
	mkdirSync(meta);
	try {
		await expect(writer.appendEvent(input)).rejects.toThrow();
	} finally {
		rmSync(meta, { recursive: true });
	}
	const log = readFileSync(join(vaultDir(), "audit", "events.jsonl"), "utf-8")
		.trim()
		.split("\n");
	return (JSON.parse(log.at(-1) ?? "{}") as { hash: string }).hash;
}

/** One event on the chain from writer A, and one lost from writer B (a second writer, the old shape). */
async function vaultWithOneLostEvent(): Promise<void> {
	const a = createAuditWriter(tempDir);
	const b = createAuditWriter(tempDir);
	try {
		await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_kept" } });
		await expect(
			b.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_lost" } }),
		).rejects.toThrow();
	} finally {
		a.release();
		b.release();
	}
}

describe("verify: a dead-lettered event makes the vault INCOMPLETE", () => {
	it("text: the chain line, then INCOMPLETE naming the count, the kind and the transfer; exit 1", async () => {
		await vaultWithOneLostEvent();
		await verifyRun(tempDir);
		const text = plain();
		expect(text).toContain("Chain verified: 1 events, all hashes valid.");
		expect(text).toContain("INCOMPLETE: 1 audit event never reached the chain (llm_call ×1)");
		expect(text).toContain("Transfers with no audit event: tx_lost");
		expect(process.exitCode).toBe(1);
	});

	it("--json: valid stays true; complete false, success false, the missing transfer named; exit 1", async () => {
		await vaultWithOneLostEvent();
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.valid).toBe(true);
		expect(r.data.complete).toBe(false);
		expect(r.data.chainLength).toBe(1);
		expect(r.data.deadLetters).toMatchObject({
			missing: 1,
			missingByKind: { llm_call: 1 },
			missingTransferIds: ["tx_lost"],
			onChain: 0,
		});
		expect(process.exitCode).toBe(1);
	});

	it("anchor mode reports it too: complete false, exit 1 even with no anchor requirement", async () => {
		await vaultWithOneLostEvent();
		const anchors = join(tempDir, "anchors.jsonl");
		writeFileSync(anchors, "");
		await verifyRun(tempDir, { json: true }, ["--anchor", anchors]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.valid).toBe(true);
		expect(r.data.complete).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("CONTROL: a vault with no dead letters is complete; exit stays 0", async () => {
		const a = createAuditWriter(tempDir);
		await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_kept" } });
		a.release();
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.success).toBe(true);
		expect(r.data.complete).toBe(true);
		expect(r.data.deadLetters).toMatchObject({ missing: 0 });
		expect(process.exitCode).toBe(0);
	});

	it("a dead letter whose event IS on the chain (its .meta update failed) is not missing", async () => {
		const { h2 } = await vaultWithMetaOnlyFailure();
		expect(deadLetterLines().map((l) => l.eventHash)).toEqual([h2]);
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.data.complete).toBe(true);
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(process.exitCode).toBe(0);
	});

	it("a dead letter records the event AS PERSISTED: an input that serialises differently twice still matches its own event", async () => {
		// A getter that answers differently on every read. The chain holds the answer the append hashed;
		// a dead letter that serialised the input again held another, matched no event on the chain, and
		// verify reported a durable event missing for good.
		let reads = 0;
		const data = {
			transferId: "tx_getter",
			get note() {
				reads++;
				return `read ${reads}`;
			},
		};
		expect(data.note).not.toBe(data.note); // the fixture: two reads, two answers
		const a = createAuditWriter(tempDir);
		let h: string;
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_0" } });
			h = await appendWithMetaFailure(a, { kind: "llm_call", actor: "local", data });
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_after" } });
		} finally {
			a.release();
		}
		const onChain = readFileSync(join(vaultDir(), "audit", "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { hash: string; data: { note?: string } })
			.find((e) => e.hash === h);
		const [letter] = deadLetterLines() as Array<{
			eventHash?: string;
			payload: { data: { note?: string } };
		}>;
		expect(letter?.eventHash).toBe(h);
		expect(letter?.payload.data.note).toBe(onChain?.data.note);
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.data.valid).toBe(true);
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(r.data.complete).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("a dead letter whose checksum does not hold is unreadable, and counts as MISSING: a corrupted `source`", async () => {
		await vaultWithOneLostEvent();
		// A JSON-valid corruption: the lost event's dead letter now names another source. Read on trust,
		// it would be "not a chain event" and the vault would read complete over a lost event.
		const [letter] = deadLetterLines();
		writeFileSync(dlqPath(), `${JSON.stringify({ ...letter, source: "some.other.writer" })}\n`);
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.deadLetters).toMatchObject({
			missing: 1,
			missingByKind: { "<unreadable>": 1 },
			onChain: 0,
		});
		expect(process.exitCode).toBe(1);
	});

	it("CONTROL: the same dead letter, unaltered, is read: its kind and transfer, not <unreadable>", async () => {
		await vaultWithOneLostEvent();
		await verifyRun(tempDir, { json: true });
		expect(json().data.deadLetters).toMatchObject({
			missing: 1,
			missingByKind: { llm_call: 1 },
			missingTransferIds: ["tx_lost"],
		});
	});

	it("an unreadable dead-letter queue is not 'nothing missing': complete false, exit 1", async () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		writeFileSync(dlqPath(), "");
		chmodSync(dlqPath(), 0o000);
		try {
			// Root reads anything: the check is meaningless there.
			if (process.getuid?.() === 0) return;
			await verifyRun(tempDir, { json: true });
			const r = json();
			expect(r.data.complete).toBe(false);
			expect(r.data.deadLetters).toMatchObject({ unreadable: "EACCES" });
			expect(process.exitCode).toBe(1);
		} finally {
			chmodSync(dlqPath(), 0o600);
		}
	});
});

describe("verify --receipts: the caller's own receipts against the chain", () => {
	async function twoEvents() {
		const a = createAuditWriter(tempDir);
		const e1 = await a.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_1" },
		});
		const e2 = await a.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_2" },
		});
		a.release();
		return [e1.hash, e2.hash] as const;
	}

	it("a receipt is audited only if its auditHash is an event on the chain naming its transfer", async () => {
		const [h1, h2] = await twoEvents();
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_1", auditHash: h1 }, // audited
				{ transferId: "tx_3", auditHash: "AUDIT_DEGRADED" },
				{ transferId: "tx_4", auditHash: "f".repeat(64) },
				{ transferId: "tx_5", auditHash: h2 }, // tx_2's event, not tx_5's
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.valid).toBe(true);
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toEqual({
			checked: 4,
			unreadable: 0,
			unaudited: [
				{
					transferId: "tx_3",
					reason: "its audit write degraded, and its llm_call event is not on the chain",
				},
				{ transferId: "tx_4", reason: "its auditHash is not on the chain" },
				{ transferId: "tx_5", reason: "its auditHash is tx_2's event" },
			],
		});
		expect(process.exitCode).toBe(1);
	});

	it("CONTROL: every receipt audited (a JSON array works too) — complete, exit 0, and the text says so", async () => {
		const [h1, h2] = await twoEvents();
		const file = join(tempDir, "receipts.json");
		writeFileSync(
			file,
			JSON.stringify([
				{ transferId: "tx_1", auditHash: h1, cost: 1 },
				{ transferId: "tx_2", auditHash: h2, cost: 1 },
			]),
		);
		await verifyRun(tempDir, { json: false }, ["--receipts", file]);
		expect(plain()).toContain("Receipts: 2 checked, each with its audit event on the chain.");
		expect(process.exitCode).toBe(0);
	});

	it("an entry that is not a readable receipt fails the check, never counts as audited", async () => {
		await twoEvents();
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `not json\n${JSON.stringify({ transferId: "tx_1" })}\n`);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toMatchObject({ checked: 0, unreadable: 2 });
		expect(process.exitCode).toBe(1);
	});

	it("a large receipts array is read whole, never as unreadable (no spread into one call)", async () => {
		await twoEvents();
		const file = join(tempDir, "receipts.json");
		const n = 200_000;
		writeFileSync(
			file,
			JSON.stringify(
				Array.from({ length: n }, (_, i) => ({
					transferId: `rx_${i}`,
					auditHash: "AUDIT_DEGRADED",
				})),
			),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const receipts = json().data.receipts as {
			checked: number;
			unreadable: number;
			unaudited: unknown[];
		};
		expect(receipts.unreadable).toBe(0);
		expect(receipts.checked).toBe(n);
		expect(receipts.unaudited).toHaveLength(n);
	}, 60_000);

	it("a chain line that is JSON but not an event (null) gives a verdict, never a crash, with --receipts too", async () => {
		const [h1] = await twoEvents();
		const log = join(vaultDir(), "audit", "events.jsonl");
		writeFileSync(log, `${readFileSync(log, "utf-8")}null\n`);
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		writeFileSync(
			dlqPath(),
			`${sealed({ source: "audit.chain.appendEvent", payload: { kind: "llm_call", actor: "local", data: { transferId: "tx_1" } }, error: "meta", timestamp: "t", eventHash: h1 })}\n`,
		);
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `${JSON.stringify({ transferId: "tx_1", auditHash: h1 })}\n`);
		// A crash is a REJECTION here, caught so that it fails this assertion rather than erroring the test.
		const crash = await verifyRun(tempDir, { json: true }, ["--receipts", file]).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(crash).toBeUndefined();
		const r = json();
		expect(r.data.valid).toBe(false);
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(r.data.receipts).toMatchObject({ checked: 1, unaudited: [] });
		expect(process.exitCode).toBe(1);
	});

	it("a degraded receipt whose event DID reach the chain (its .meta failed) is audited: no false INCOMPLETE", async () => {
		const { h1 } = await vaultWithMetaOnlyFailure();
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_1", auditHash: h1 },
				{ transferId: "tx_2", auditHash: "AUDIT_DEGRADED" },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.complete).toBe(true);
		expect(r.data.receipts).toEqual({ checked: 2, unreadable: 0, unaudited: [] });
		expect(process.exitCode).toBe(0);
	});

	it("a degraded receipt is matched by ITS transfer: another transfer's dead letter on the chain does not audit it", async () => {
		await vaultWithMetaOnlyFailure();
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `${JSON.stringify({ transferId: "tx_3", auditHash: "AUDIT_DEGRADED" })}\n`);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toMatchObject({ checked: 1, unaudited: [{ transferId: "tx_3" }] });
		expect(process.exitCode).toBe(1);
	});

	it("a forged dead letter has no effect on receipts: a whole checksum naming another transfer's event audits nothing", async () => {
		const { h1 } = await vaultWithMetaOnlyFailure();
		// tx_9's event never reached the chain. A dead letter for it, its checksum whole, claims it did:
		// at tx_1's event.
		writeFileSync(
			dlqPath(),
			`${sealed({ source: "audit.chain.appendEvent", payload: { kind: "llm_call", actor: "local", data: { transferId: "tx_9" } }, error: "forged", timestamp: "t", eventHash: h1 })}\n`,
		);
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `${JSON.stringify({ transferId: "tx_9", auditHash: "AUDIT_DEGRADED" })}\n`);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.deadLetters).toMatchObject({
			missing: 1,
			missingTransferIds: ["tx_9"],
			onChain: 0,
		});
		expect(r.data.receipts).toMatchObject({ checked: 1, unaudited: [{ transferId: "tx_9" }] });
		expect(process.exitCode).toBe(1);
	});

	it("a corrupted dead letter changes no receipt's verdict (the receipt's event is on the chain); the queue still reports it", async () => {
		await vaultWithMetaOnlyFailure();
		const [letter] = deadLetterLines();
		const { checksum: _checksum, checksumAlg: _alg, ...unsealed } = letter ?? {};
		writeFileSync(dlqPath(), `${JSON.stringify(unsealed)}\n`);
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `${JSON.stringify({ transferId: "tx_2", auditHash: "AUDIT_DEGRADED" })}\n`);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.deadLetters).toMatchObject({
			missing: 1,
			missingByKind: { "<unreadable>": 1 },
			onChain: 0,
		});
		expect(r.data.receipts).toEqual({ checked: 1, unreadable: 0, unaudited: [] });
		expect(process.exitCode).toBe(1);
	});

	it("a receipt is audited only by an event that names ITS transfer: an event naming none audits nothing", async () => {
		const a = createAuditWriter(tempDir);
		const allocation = await a.appendEvent({
			kind: "budget_allocated",
			actor: "local",
			data: { amount: 100 },
		});
		a.release();
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `${JSON.stringify({ transferId: "tx_7", auditHash: allocation.hash })}\n`);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toEqual({
			checked: 1,
			unreadable: 0,
			unaudited: [
				{ transferId: "tx_7", reason: "its auditHash is an event that names no transfer" },
			],
		});
		expect(process.exitCode).toBe(1);
	});

	it("a headless governor's degraded receipt (auditDegraded, a placeholder hash) is audited through its own event too", async () => {
		await vaultWithMetaOnlyFailure();
		const placeholder = (id: string) => createHash("sha256").update(id).digest("hex");
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_2", auditHash: placeholder("tx_2"), auditDegraded: true },
				// CONTROL: the same shape for a transfer with no dead letter on the chain.
				{ transferId: "tx_3", auditHash: placeholder("tx_3"), auditDegraded: true },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		expect(json().data.receipts).toEqual({
			checked: 2,
			unreadable: 0,
			unaudited: [
				{
					transferId: "tx_3",
					reason: "its audit write degraded, and its llm_call event is not on the chain",
				},
			],
		});
	});

	it("a dead letter nested past the serializer's depth gives a verdict, never a crash: unreadable, counted missing", async () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		const depth = 10_000;
		const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
		// The failure this row needs: the record parses, and serializing it again throws.
		expect(() => JSON.stringify(JSON.parse(deep))).toThrow(RangeError);
		writeFileSync(
			dlqPath(),
			`{"source":"audit.chain.appendEvent","payload":{"kind":"llm_call","actor":"local","data":{"x":${deep}}},"checksum":"${"0".repeat(64)}","checksumAlg":"sha256"}\n`,
		);
		// A crash is a REJECTION here, caught so that it fails this assertion rather than erroring the test.
		const crash = await verifyRun(tempDir, { json: true }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(crash).toBeUndefined();
		const r = json();
		expect(r.data.complete).toBe(false);
		expect(r.data.deadLetters).toMatchObject({ missing: 1, missingByKind: { "<unreadable>": 1 } });
	});

	it("a degraded receipt is audited only through ITS OWN event: another event of its transfer on the chain does not stand in for the spend record", async () => {
		const a = createAuditWriter(tempDir);
		let detection: string;
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_1" } });
			// tx_9's spend record (its llm_call) never reached the chain and has no dead letter; only
			// its injection detection did, with a dead letter whose checksum holds.
			detection = await appendWithMetaFailure(a, {
				kind: "injection_detected",
				actor: "local",
				data: { transferId: "tx_9", score: 0.9 },
			});
		} finally {
			a.release();
		}
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_9", auditHash: "AUDIT_DEGRADED" },
				{ transferId: "tx_9", auditHash: detection },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		// Nothing is missing from the dead-letter queue's point of view: only the receipts see the gap.
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toEqual({
			checked: 2,
			unreadable: 0,
			unaudited: [
				{
					transferId: "tx_9",
					reason: "its audit write degraded, and its llm_call event is not on the chain",
				},
				{
					transferId: "tx_9",
					reason:
						"its auditHash is its injection_detected event, not the llm_call that records its spend",
				},
			],
		});
		expect(process.exitCode).toBe(1);
	});

	it("an action's degraded receipt is audited through its action's event, never through an llm_call", async () => {
		const a = createAuditWriter(tempDir);
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_1" } });
			await appendWithMetaFailure(a, {
				kind: "tool_use",
				actor: "local",
				data: { actionName: "search", cost: 1, settled: true, transferId: "tx_act" },
			});
		} finally {
			a.release();
		}
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_act", auditHash: "AUDIT_DEGRADED", actionKind: "tool_use" },
				// CONTROL: the same transfer read as an LLM call's receipt has no llm_call on the chain.
				{ transferId: "tx_act", auditHash: "AUDIT_DEGRADED" },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		expect(json().data.receipts).toEqual({
			checked: 2,
			unreadable: 0,
			unaudited: [
				{
					transferId: "tx_act",
					reason: "its audit write degraded, and its llm_call event is not on the chain",
				},
			],
		});
	});

	it("a dead letter of a value whose JSON and canonical forms differ (a Buffer) still holds its checksum, and its event is on the chain", async () => {
		const a = createAuditWriter(tempDir);
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_1" } });
			await appendWithMetaFailure(a, {
				kind: "llm_call",
				actor: "local",
				data: { transferId: "tx_buf", blob: Buffer.from("abc") },
			});
		} finally {
			a.release();
		}
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ transferId: "tx_buf", auditHash: "AUDIT_DEGRADED" })}\n`,
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(r.data.receipts).toEqual({ checked: 1, unreadable: 0, unaudited: [] });
		expect(r.data.complete).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("a LOST event's dead letter holds the caller's own input (nothing was built), and is read whole: a Buffer of 11 bytes keeps its checksum", async () => {
		// The append fails before its event is built (another writer holds the vault), so the dead letter
		// carries the caller's input as given. A Buffer canonicalizes as an object of index keys, where
		// "10" sorts before "2": its JSON.stringify form differs in content AND, once parsed back, in key
		// order. Persisted as anything but its canonical bytes, or read against anything but its canonical
		// form, the record fails its checksum and reads as an unreadable line.
		const a = createAuditWriter(tempDir);
		const b = createAuditWriter(tempDir);
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_kept" } });
			await expect(
				b.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { transferId: "tx_lost_buf", blob: Buffer.from("eleven byte") },
				}),
			).rejects.toThrow();
		} finally {
			a.release();
			b.release();
		}
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.data.deadLetters).toMatchObject({
			missing: 1,
			missingByKind: { llm_call: 1 },
			missingTransferIds: ["tx_lost_buf"],
		});
		expect(process.exitCode).toBe(1);
	});

	it("a receipt degraded by a FOLLOW-UP event (its llm_call landed; a settlement shortfall's .meta failed) is audited", async () => {
		const a = createAuditWriter(tempDir);
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_s" } });
			await appendWithMetaFailure(a, {
				kind: "settlement_shortfall",
				actor: "local",
				data: { transferId: "tx_s", shortfall: 3 },
			});
		} finally {
			a.release();
		}
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, `${JSON.stringify({ transferId: "tx_s", auditHash: "AUDIT_DEGRADED" })}\n`);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		// The only dead letter is the shortfall's, and its event is on the chain: nothing is missing.
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(r.data.receipts).toEqual({ checked: 1, unreadable: 0, unaudited: [] });
		expect(r.data.complete).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("an event's kind counts only as a string: an array kind certifies nothing, and a kind without toString gives a verdict, not a crash", async () => {
		const a = createAuditWriter(tempDir);
		let odd: string;
		try {
			await a.appendEvent({
				kind: ["llm_call"] as unknown as string,
				actor: "local",
				data: { transferId: "tx_k" },
			});
			odd = (
				await a.appendEvent({
					kind: { toString: null } as unknown as string,
					actor: "local",
					data: { transferId: "tx_o" },
				})
			).hash;
		} finally {
			a.release();
		}
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_k", auditHash: "AUDIT_DEGRADED" },
				{ transferId: "tx_o", auditHash: odd },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		// A crash is a REJECTION here, caught so that it fails this assertion rather than erroring the test.
		const crash = await verifyRun(tempDir, { json: true }, ["--receipts", file]).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(crash).toBeUndefined();
		expect(json().data.receipts).toEqual({
			checked: 2,
			unreadable: 0,
			unaudited: [
				{
					transferId: "tx_k",
					reason: "its audit write degraded, and its llm_call event is not on the chain",
				},
				{
					transferId: "tx_o",
					reason: "its auditHash is its malformed event, not the llm_call that records its spend",
				},
			],
		});
	});

	it("a receipt's actionKind must name a governed action: a follow-up event's kind makes it unreadable, never audited", async () => {
		const a = createAuditWriter(tempDir);
		let shortfall: string;
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_1" } });
			shortfall = (
				await a.appendEvent({
					kind: "settlement_shortfall",
					actor: "local",
					data: { transferId: "tx_z", shortfall: 1 },
				})
			).hash;
		} finally {
			a.release();
		}
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				// tx_z's spend record (its llm_call) is not on the chain; its shortfall follow-up is.
				{ transferId: "tx_z", auditHash: shortfall, actionKind: "settlement_shortfall" },
				{ transferId: "tx_z", auditHash: "AUDIT_DEGRADED", actionKind: "injection_detected" },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.data.receipts).toEqual({ checked: 0, unreadable: 2, unaudited: [] });
		expect(r.data.complete).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("--receipts with no file is a usage error", async () => {
		await verifyRun(tempDir, { json: true }, ["--receipts"]);
		expect(json().success).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("readChainDeadLetters", () => {
	it("counts a lost event by kind and transfer; a line it cannot read counts as missing; other sources do not", () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		const onChainEvent = { kind: "llm_call", actor: "local", data: { transferId: "tx_b" } };
		writeFileSync(
			dlqPath(),
			[
				sealed({
					source: "audit.chain.appendEvent",
					payload: { kind: "llm_call", actor: "local", data: { transferId: "tx_a" } },
				}),
				sealed({
					source: "audit.chain.appendEvent",
					payload: { kind: "policy_denied", actor: "local", data: {} },
				}),
				"{ not json",
				sealed({ source: "some.other.writer", payload: {} }),
				sealed({
					source: "audit.chain.appendEvent",
					payload: onChainEvent,
					eventHash: "on-chain",
				}),
				"",
			].join("\n"),
		);
		expect(
			readChainDeadLetters(vaultDir(), (h) => (h === "on-chain" ? onChainEvent : undefined)),
		).toEqual({
			path: dlqPath(),
			missing: 3,
			missingByKind: { llm_call: 1, policy_denied: 1, "<unreadable>": 1 },
			missingTransferIds: ["tx_a"],
			onChain: 1,
			otherSources: 1,
		});
	});

	it("a dead letter is on the chain only if the event at its eventHash IS it: same kind, actor and data", () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		const event = { kind: "llm_call", actor: "local", data: { transferId: "tx_1", cost: 2 } };
		const letter = (payload: Record<string, unknown>) =>
			sealed({ source: "audit.chain.appendEvent", payload, eventHash: "h" });
		writeFileSync(
			dlqPath(),
			[
				letter(event), // the event itself: on the chain
				letter({ ...event, kind: "policy_denied" }),
				letter({ ...event, actor: "someone-else" }),
				letter({ ...event, data: { transferId: "tx_1", cost: 3 } }),
				letter({ ...event, data: { transferId: "tx_2", cost: 2 } }),
			].join("\n"),
		);
		expect(readChainDeadLetters(vaultDir(), (h) => (h === "h" ? event : undefined))).toMatchObject({
			missing: 4,
			missingByKind: { llm_call: 3, policy_denied: 1 },
			onChain: 1,
		});
	});

	it("a checksum is required, of the writer's algorithm: absent, or another algorithm, is unreadable", () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		const entry = {
			source: "audit.chain.appendEvent",
			payload: { kind: "llm_call", actor: "local", data: { transferId: "tx_1" } },
		};
		const whole = JSON.parse(sealed(entry)) as Record<string, unknown>;
		writeFileSync(
			dlqPath(),
			[
				JSON.stringify(entry), // no checksum
				JSON.stringify({ ...whole, checksumAlg: "md5" }),
				JSON.stringify({ ...whole, checksum: "0".repeat(64) }),
				sealed(entry), // CONTROL: whole
			].join("\n"),
		);
		expect(readChainDeadLetters(vaultDir(), noEvent)).toMatchObject({
			missing: 4,
			missingByKind: { "<unreadable>": 3, llm_call: 1 },
			missingTransferIds: ["tx_1"],
		});
	});

	it("a dead letter the writer sealed over JSON.stringify (a NaN in the event: canonicalize refuses it) is read, not unreadable", async () => {
		const a = createAuditWriter(tempDir);
		try {
			await expect(
				a.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { transferId: "tx_nan", cost: Number.NaN },
				}),
			).rejects.toThrow(/NaN/);
		} finally {
			a.release();
		}
		expect(deadLetterLines()[0]?.payload).toMatchObject({ data: { cost: null } });
		expect(readChainDeadLetters(vaultDir(), noEvent)).toMatchObject({
			missing: 1,
			missingByKind: { llm_call: 1 },
			missingTransferIds: ["tx_nan"],
		});
	});

	it("a kind that names an Object property (constructor, __proto__) is counted like any other", () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		writeFileSync(
			dlqPath(),
			["constructor", "__proto__", "toString", "constructor"]
				.map((kind) => sealed({ source: "audit.chain.appendEvent", payload: { kind, data: {} } }))
				.join("\n"),
		);
		const d = readChainDeadLetters(vaultDir(), noEvent);
		expect("missing" in d && d.missing).toBe(4);
		const byKind = "missingByKind" in d ? d.missingByKind : {};
		expect(Object.entries(byKind).sort()).toEqual([
			["__proto__", 1],
			["constructor", 2],
			["toString", 1],
		]);
	});

	it("no file: nothing was dead-lettered", () => {
		expect(readChainDeadLetters(vaultDir(), noEvent)).toMatchObject({ missing: 0 });
	});

	it("is a reader: its source names no filesystem write call", () => {
		const src = readFileSync(new URL("../../src/audit/dead-letters.ts", import.meta.url), "utf-8");
		for (const call of [
			"writeFile",
			"appendFile",
			"writeSync",
			"mkdir",
			"rename",
			"unlink",
			"rmSync",
			"rm(",
			"truncate",
			"openSync",
			"copyFile",
			"symlink",
			"chmod",
		]) {
			expect(src.includes(call), call).toBe(false);
		}
	});

	it("never writes to the vault", () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		const line = `${JSON.stringify({ source: "audit.chain.appendEvent", payload: { kind: "llm_call", data: {} } })}\n`;
		writeFileSync(dlqPath(), line);
		readChainDeadLetters(vaultDir(), noEvent);
		expect(readFileSync(dlqPath(), "utf-8")).toBe(line);
	});
});

describe("health: missing events are a chain-integrity failure", () => {
	it("the chain line names the missing events and is critical; --json carries missingEvents", async () => {
		await vaultWithOneLostEvent();
		const cwd = process.cwd();
		process.chdir(tempDir);
		try {
			await healthRun();
			const text = plain();
			expect(text).toMatch(
				/Chain integrity:\s+verified, 1 event MISSING \(dead-lettered\) \[critical\]/,
			);
			expect(text).toMatch(/\(critical\)/);
			out.length = 0;
			await healthRun(undefined, { json: true });
			const r = json();
			const signals = r.data.signals as Record<string, unknown>;
			expect(signals.chainIntegrity).toBe(false);
			expect(signals.missingEvents).toBe(1);
		} finally {
			process.chdir(cwd);
		}
	});

	it("CONTROL: no dead letters — verified [ok], missingEvents 0", async () => {
		const a = createAuditWriter(tempDir);
		await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_kept" } });
		a.release();
		const cwd = process.cwd();
		process.chdir(tempDir);
		try {
			await healthRun(undefined, { json: true });
			const signals = json().data.signals as Record<string, unknown>;
			expect(signals.chainIntegrity).toBe(true);
			expect(signals.missingEvents).toBe(0);
		} finally {
			process.chdir(cwd);
		}
	});
});
