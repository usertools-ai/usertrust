/**
 * replay.test.mts — contract tests for the dry-run replay engine (Task 4).
 *
 * The two tests this whole design rests on (spec r3 / Task 4):
 *  - CHAIN MEMBERSHIP: every mint's chain event carries the cost-center tag,
 *    and every DONE's auditHash is literally an entry in the month chain —
 *    that lookup is what crash recovery keys on.
 *  - AUDIT-DEGRADED ABORT: a receipt with `auditDegraded: true` kills the run
 *    before DONE and before the receipt store — fail-open audit is not
 *    acceptable for a ledger whose only job is the audit.
 *
 * TAG FORM — `fleet.<sessionHash>.<messageId>` (dots). The spec's original
 * colon form cannot pass core's colon-free COST_CENTER_PATTERN (a security
 * boundary — shared/ids.ts); separator amended to "." by coordinator decision
 * 2026-08-10. Injectivity survives because sessionHash is fixed-width 12 hex:
 * the round-trip test below pins that claim.
 */
import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { verifyVault } from "usertrust";
import { openJournal } from "./journal.mts";
import type { FleetRecord } from "./parse.mts";
import { fleetMeters, fleetTag, parseFleetTag, replayMonth } from "./replay.mts";
import { readReceiptStore } from "./rollup.mts";

const MONTH = "2026-07";

/** Fresh per-test directory, removed when the test ends. */
const tempDir = (t: TestContext): string => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-replay-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

/** A valid FleetRecord (allowlist keys only), overridable per test. */
const record = (over: Partial<FleetRecord> = {}): FleetRecord => ({
	messageId: "msg_01ReplayAAA",
	model: "claude-opus-4-8",
	sessionHash: "abc123def456",
	occurredAt: "2026-07-15T10:00:00.000Z",
	isSidechain: false,
	speed: "standard",
	inputTokens: 300,
	outputTokens: 120,
	cacheReadTokens: 80,
	cacheWrite5m: 40,
	cacheWrite1h: 16,
	...over,
});

interface ChainEvent {
	kind: string;
	hash: string;
	data?: Record<string, unknown>;
}

/** Read every audit segment in the month vault (events.jsonl + rotations). */
const readChain = (vaultBase: string): ChainEvent[] => {
	const auditDir = join(vaultBase, ".usertrust", "audit");
	if (!existsSync(auditDir)) return [];
	const events: ChainEvent[] = [];
	for (const file of readdirSync(auditDir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(auditDir, file), "utf-8").split("\n")) {
			if (line.trim() === "") continue;
			events.push(JSON.parse(line) as ChainEvent);
		}
	}
	return events;
};

const tagEvents = (vaultBase: string, tag: string): ChainEvent[] =>
	readChain(vaultBase).filter((e) => e.data?.costCenter === tag);

interface StoredLine {
	receipt: {
		model: string;
		auditHash: string;
		auditDegraded?: boolean;
		usageSource?: string;
		usage?: Record<string, number>;
	};
	provenance: Record<string, unknown>;
}

const readStore = (path: string): StoredLine[] =>
	readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as StoredLine);

test("fleet tag: dot form composes and parses back exactly (injectivity pinned)", () => {
	// messageId itself contains dots and dashes — the fixed-width 12-hex
	// sessionHash is what keeps the parse unambiguous anyway.
	const tag = fleetTag("abc123def456", "msg_01.dotted-id.x");
	assert.equal(tag, "fleet.abc123def456.msg_01.dotted-id.x");
	assert.deepStrictEqual(parseFleetTag(tag), {
		sessionHash: "abc123def456",
		messageId: "msg_01.dotted-id.x",
	});
});

test("pre-mint guard: illegal tag or wrong-month record aborts before any write", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const journal = openJournal(join(dir, "fleet"), MONTH);
	const receiptStorePath = join(dir, "receipts.jsonl");

	// (1) charset: a messageId core's COST_CENTER_PATTERN refuses
	await assert.rejects(
		replayMonth({
			month: MONTH,
			records: [record({ messageId: "msg 01 spaces" })],
			vaultRoot,
			journal,
			receiptStorePath,
		}),
		/COST_CENTER_PATTERN/,
	);
	// (2) length: legal charset, but the composed tag exceeds 64 chars
	await assert.rejects(
		replayMonth({
			month: MONTH,
			records: [record({ messageId: `msg_${"x".repeat(56)}` })],
			vaultRoot,
			journal,
			receiptStorePath,
		}),
		/COST_CENTER_PATTERN/,
	);
	// (3) month routing: an August record must never reach a July vault
	await assert.rejects(
		replayMonth({
			month: MONTH,
			records: [record({ occurredAt: "2026-08-02T09:00:00.000Z" })],
			vaultRoot,
			journal,
			receiptStorePath,
		}),
		/outside month/,
	);

	// Aborts happened BEFORE any journal, vault, or store write.
	assert.deepStrictEqual(journal.pendingIntents(), []);
	assert.deepStrictEqual(journal.seen(), new Set());
	assert.equal(existsSync(join(vaultRoot, MONTH)), false);
	assert.equal(existsSync(receiptStorePath), false);
});

test("two-record replay mints two provider-sourced receipts with tier-sum cache writes", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const journal = openJournal(join(dir, "fleet"), MONTH);
	const receiptStorePath = join(dir, "receipts", `${MONTH}.jsonl`);
	const recA = record();
	const recB = record({
		messageId: "msg_01ReplayBBB",
		model: "claude-sonnet-5",
		sessionHash: "fed654cba321",
		occurredAt: "2026-07-16T11:00:00.000Z",
		isSidechain: true,
		inputTokens: 1000,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 7,
	});

	const result = await replayMonth({
		month: MONTH,
		records: [recA, recB],
		vaultRoot,
		journal,
		receiptStorePath,
	});
	assert.deepStrictEqual(result, { minted: 2, recovered: 0 });

	const lines = readStore(receiptStorePath);
	assert.equal(lines.length, 2);
	for (const [i, rec] of [recA, recB].entries()) {
		const stored = lines[i];
		assert.ok(stored, `missing stored line ${i}`);
		const { receipt, provenance } = stored;
		assert.equal(receipt.model, rec.model);
		assert.equal(receipt.usageSource, "provider");
		// Four-tier usage IS the transcript numbers; cacheWriteTokens is the
		// nested tier sum (5m + 1h), matching fromAnthropicUsage.
		assert.deepStrictEqual(receipt.usage, {
			inputTokens: rec.inputTokens,
			outputTokens: rec.outputTokens,
			cacheReadTokens: rec.cacheReadTokens,
			cacheWriteTokens: rec.cacheWrite5m + rec.cacheWrite1h,
		});
		const capturedAt = provenance.capturedAt;
		assert.equal(typeof capturedAt, "string");
		assert.ok(!Number.isNaN(Date.parse(capturedAt as string)));
		// EXACT provenance shape — nothing beyond the allowlisted sidecar.
		assert.deepStrictEqual(provenance, {
			mode: "dry-run",
			source: "claude-code-transcript",
			occurredAt: rec.occurredAt,
			capturedAt,
			sessionHash: rec.sessionHash,
			isSidechain: rec.isSidechain,
			messageId: rec.messageId,
			cacheWriteTiers: { m5: rec.cacheWrite5m, h1: rec.cacheWrite1h },
		});
	}
	assert.deepStrictEqual(journal.seen(), new Set([recA.messageId, recB.messageId]));
});

test("chain membership: each mint's event carries the tag and each DONE auditHash is in the chain", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const vaultBase = join(vaultRoot, MONTH);
	const fleetDir = join(dir, "fleet");
	const journal = openJournal(fleetDir, MONTH);
	const receiptStorePath = join(dir, "receipts", `${MONTH}.jsonl`);
	const recA = record();
	const recB = record({ messageId: "msg_01ReplayBBB", sessionHash: "fed654cba321" });

	await replayMonth({ month: MONTH, records: [recA, recB], vaultRoot, journal, receiptStorePath });

	for (const rec of [recA, recB]) {
		const tagged = tagEvents(vaultBase, fleetTag(rec.sessionHash, rec.messageId));
		assert.equal(tagged.length, 1, `expected exactly one tagged event for ${rec.messageId}`);
		assert.equal(tagged[0]?.kind, "llm_call");
	}

	// Membership (capture-evidence precedent): every DONE auditHash — which is
	// also every stored receipt's auditHash — must exist in the chain.
	const chainHashes = new Set(readChain(vaultBase).map((e) => e.hash));
	for (const { receipt } of readStore(receiptStorePath)) {
		assert.ok(chainHashes.has(receipt.auditHash), `auditHash ${receipt.auditHash} not in chain`);
	}
	const doneLines = readFileSync(join(fleetDir, "journal", `${MONTH}.jsonl`), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { type: string; auditHash?: string })
		.filter((e) => e.type === "DONE");
	assert.equal(doneLines.length, 2);
	for (const done of doneLines) {
		assert.ok(chainHashes.has(done.auditHash as string), "DONE auditHash not in chain");
	}
});

test("crash recovery: INTENT + chain event without DONE resolves from the chain, no duplicate", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const vaultBase = join(vaultRoot, MONTH);
	const rec = record();
	const tag = fleetTag(rec.sessionHash, rec.messageId);

	// Run 1 completes: the chain event for rec is durably in the month vault.
	const journal1 = openJournal(join(dir, "fleet-run1"), MONTH);
	await replayMonth({
		month: MONTH,
		records: [rec],
		vaultRoot,
		journal: journal1,
		receiptStorePath: join(dir, "store1.jsonl"),
	});

	// Crash state: a journal holding the INTENT but which never got the DONE —
	// exactly what a crash between the vault write and the DONE append leaves.
	const crashedDir = join(dir, "fleet-crashed");
	const journal2 = openJournal(crashedDir, MONTH);
	journal2.intent(rec.messageId, rec.sessionHash, fleetMeters(rec));

	const result = await replayMonth({
		month: MONTH,
		records: [rec],
		vaultRoot,
		journal: journal2,
		receiptStorePath: join(dir, "store2.jsonl"),
	});
	assert.deepStrictEqual(result, { minted: 0, recovered: 1 });
	assert.deepStrictEqual(journal2.seen(), new Set([rec.messageId]));
	assert.deepStrictEqual(journal2.pendingIntents(), []);

	// No duplicate mint: the chain still carries exactly ONE event with the tag.
	const tagged = tagEvents(vaultBase, tag);
	assert.equal(tagged.length, 1);

	// The recovered DONE points at the REAL chain event, under the same tag.
	const done = readFileSync(join(crashedDir, "journal", `${MONTH}.jsonl`), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { type: string; auditHash?: string; costCenter?: string })
		.find((e) => e.type === "DONE");
	assert.ok(done);
	assert.equal(done.auditHash, tagged[0]?.hash);
	assert.equal(done.costCenter, tag);

	// Recovery writes DONE only — it never fabricates a receipt line.
	assert.equal(existsSync(join(dir, "store2.jsonl")), false);

	// Idempotent rerun on the completed journal: everything seen, nothing to do.
	const rerun = await replayMonth({
		month: MONTH,
		records: [rec],
		vaultRoot,
		journal: journal1,
		receiptStorePath: join(dir, "store1.jsonl"),
	});
	assert.deepStrictEqual(rerun, { minted: 0, recovered: 0 });
	assert.equal(readStore(join(dir, "store1.jsonl")).length, 1);
});

test("crash recovery: a tagged FAILURE/DENIAL event never satisfies recovery — the record replays", async (t) => {
	// The P1 (Codex PR-91 #1). Every one of these kinds carries `data.costCenter`
	// when the call was attributed, so a tag-only lookup would find one and write
	// DONE for a call that produced NO receipt — the record is then filtered out
	// forever and a real call vanishes from the ledger. Note `llm_call_failed`
	// STARTS WITH the success kind: a prefix/substring test would still accept it,
	// which is exactly the shortcut this test exists to refuse.
	for (const kind of ["llm_call_failed", "policy_denied", "ledger_rejected"]) {
		const dir = mkdtempSync(join(tmpdir(), `fleet-replay-${kind}-`));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const vaultRoot = join(dir, "vault");
		const vaultBase = join(vaultRoot, MONTH);
		const rec = record();
		const tag = fleetTag(rec.sessionHash, rec.messageId);

		// The crashed run's ONLY chain trace for this record is a failure/denial
		// event carrying the tag (governor wrote it, then the replay threw).
		const auditDir = join(vaultBase, ".usertrust", "audit");
		mkdirSync(auditDir, { recursive: true });
		writeFileSync(
			join(auditDir, "events.jsonl"),
			`${JSON.stringify({
				id: `evt_${kind}`,
				timestamp: "2026-07-15T10:00:00.000Z",
				previousHash: "0".repeat(64),
				hash: "9".repeat(64),
				kind,
				actor: "local",
				data: { costCenter: tag, model: rec.model, error: "boom" },
				sequence: 1,
			})}\n`,
		);

		const fleetDir = join(dir, "fleet");
		const journal = openJournal(fleetDir, MONTH);
		journal.intent(rec.messageId, rec.sessionHash, fleetMeters(rec));
		const receiptStorePath = join(dir, "store.jsonl");

		const result = await replayMonth({
			month: MONTH,
			records: [rec],
			vaultRoot,
			journal,
			receiptStorePath,
		});

		// REPLAYED, not recovered: the call gets a real receipt and a store row.
		assert.deepStrictEqual(result, { minted: 1, recovered: 0 }, `${kind}: must replay`);
		const stored = readStore(receiptStorePath);
		assert.equal(stored.length, 1, `${kind}: the real call must reach the receipt store`);
		// …and the DONE points at the newly minted SUCCESS event, never the
		// failure event's hash.
		const success = tagEvents(vaultBase, tag).filter((e) => e.kind === "llm_call");
		assert.equal(success.length, 1, `${kind}: exactly one success event`);
		assert.equal(stored[0]?.receipt.auditHash, success[0]?.hash);
		assert.notEqual(stored[0]?.receipt.auditHash, "9".repeat(64));
		assert.deepStrictEqual(journal.pendingIntents(), []);
	}
});

test("auditDegraded receipt aborts the run: no DONE, no receipt-store line", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const vaultBase = join(vaultRoot, MONTH);
	const auditDir = join(vaultBase, ".usertrust", "audit");
	mkdirSync(auditDir, { recursive: true });
	chmodSync(auditDir, 0o555); // every audit write now fails => degraded receipt
	// Tolerant restore: hook ordering may run after the tempDir rmSync.
	t.after(() => {
		if (existsSync(auditDir)) chmodSync(auditDir, 0o755);
	});
	const journal = openJournal(join(dir, "fleet"), MONTH);
	const receiptStorePath = join(dir, "receipts.jsonl");
	const rec = record();

	await assert.rejects(
		replayMonth({ month: MONTH, records: [rec], vaultRoot, journal, receiptStorePath }),
		/auditDegraded/,
	);

	// The abort left the WAL in the honest crash-window state: INTENT without
	// DONE (and no chain event exists, so the next run replays, not recovers).
	assert.deepStrictEqual(journal.seen(), new Set());
	assert.deepStrictEqual(journal.pendingIntents(), [
		{ messageId: rec.messageId, sessionHash: rec.sessionHash },
	]);
	assert.equal(existsSync(receiptStorePath), false);
});

test("receipt store: replay repairs a crashed run's torn tail before appending", async (t) => {
	// The call site for the repair (Codex PR-91 #4). Without it the next append
	// glues itself onto the uncommitted bytes and the resulting INTERIOR
	// malformed line makes every later rollup of this month throw — permanently.
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const fleetDir = join(dir, "fleet");
	const receiptStorePath = join(dir, "receipts", `${MONTH}.jsonl`);
	const recA = record();
	const recB = record({ messageId: "msg_01ReplayBBB", sessionHash: "fed654cba321" });

	await replayMonth({
		month: MONTH,
		records: [recA],
		vaultRoot,
		journal: openJournal(fleetDir, MONTH),
		receiptStorePath,
	});
	// The crash: a second append that stopped mid-record, no newline.
	appendFileSync(receiptStorePath, '{"receipt":{"cost":1,"tornMidWri');

	await replayMonth({
		month: MONTH,
		records: [recA, recB],
		vaultRoot,
		journal: openJournal(fleetDir, MONTH),
		receiptStorePath,
	});

	// The store reads back cleanly — one line per real receipt, torn bytes gone.
	const lines = readReceiptStore(receiptStorePath);
	assert.equal(lines.length, 2);
	assert.deepStrictEqual(
		lines.map((l) => l.provenance.messageId),
		[recA.messageId, recB.messageId],
	);
	assert.ok(!readFileSync(receiptStorePath, "utf-8").includes("tornMidWri"), "torn bytes gone");
});

test("no piiDetected/piiPaths keys on any fleet event (absence, not false)", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const vaultBase = join(vaultRoot, MONTH);
	const journal = openJournal(join(dir, "fleet"), MONTH);
	await replayMonth({
		month: MONTH,
		records: [record()],
		vaultRoot,
		journal,
		receiptStorePath: join(dir, "receipts.jsonl"),
	});

	const auditDir = join(vaultBase, ".usertrust", "audit");
	const raw = readdirSync(auditDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => readFileSync(join(auditDir, f), "utf-8"))
		.join("\n");
	assert.ok(raw.length > 0, "expected audit content");
	assert.ok(!raw.includes('"piiDetected"'), "piiDetected key must be absent");
	assert.ok(!raw.includes('"piiPaths"'), "piiPaths key must be absent");
});

test("verifyVault passes over the replayed month vault", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const journal = openJournal(join(dir, "fleet"), MONTH);
	await replayMonth({
		month: MONTH,
		records: [record()],
		vaultRoot,
		journal,
		receiptStorePath: join(dir, "receipts.jsonl"),
	});

	const verdict = verifyVault(join(vaultRoot, MONTH, ".usertrust"));
	assert.equal(verdict.valid, true, `verifyVault errors: ${JSON.stringify(verdict.errors)}`);
});

test("month boundary: records in two months land in two vaults, both verify", async (t) => {
	const dir = tempDir(t);
	const vaultRoot = join(dir, "vault");
	const fleetDir = join(dir, "fleet");
	const julRec = record();
	const augRec = record({ messageId: "msg_01ReplayAug", occurredAt: "2026-08-02T09:00:00.000Z" });

	await replayMonth({
		month: "2026-07",
		records: [julRec],
		vaultRoot,
		journal: openJournal(fleetDir, "2026-07"),
		receiptStorePath: join(dir, "receipts", "2026-07.jsonl"),
	});
	await replayMonth({
		month: "2026-08",
		records: [augRec],
		vaultRoot,
		journal: openJournal(fleetDir, "2026-08"),
		receiptStorePath: join(dir, "receipts", "2026-08.jsonl"),
	});

	for (const [month, rec] of [
		["2026-07", julRec],
		["2026-08", augRec],
	] as const) {
		const vaultBase = join(vaultRoot, month);
		const verdict = verifyVault(join(vaultBase, ".usertrust"));
		assert.equal(verdict.valid, true, `${month}: ${JSON.stringify(verdict.errors)}`);
		assert.equal(tagEvents(vaultBase, fleetTag(rec.sessionHash, rec.messageId)).length, 1);
	}
	// No cross-month bleed: July's vault never saw August's tag.
	assert.equal(
		tagEvents(join(vaultRoot, "2026-07"), fleetTag(augRec.sessionHash, augRec.messageId)).length,
		0,
	);
});
