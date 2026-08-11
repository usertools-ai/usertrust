/**
 * rollup.test.mts — contract tests for the collector CLI (Task 5).
 *
 * The two load-bearing surfaces (task brief / reviewer note):
 *  - THE PUBLISH GATE: journal clean (no INTENT without DONE) + every DONE
 *    auditHash present in the month chain + `usertrust-verify` exit 0 — and
 *    the gate REFUSES otherwise. A fleet page served from an unverified or
 *    half-ingested vault is worse than no page.
 *  - THE ROLLUP SHAPE: `fleet-summary.json` carries EXACTLY the FleetSummary
 *    keys, rendered deterministically (same inputs ⇒ byte-identical JSON,
 *    keys sorted) — the /fleet page renders every figure from this file, so
 *    its bytes are the page's entire data contract.
 *
 * Pre-flight (spec r2/C1, task-4 handoff): abort BEFORE any vault write when
 * a new record's model resolves to FALLBACK_RATE (reference-equality probe —
 * `getModelRates(m) === FALLBACK_RATE`) or its speed is not "standard".
 */
import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { coreDistBuilt, REPO_ROOT } from "../fleet-collector.mts";
import {
	assertPublishable,
	collectRecords,
	dedupeRecords,
	projectDirAllowlist,
	publishMonthFor,
	scanTranscripts,
	VERIFY_CLI,
} from "./collect.mts";
import { openJournal } from "./journal.mts";
import { type FleetRecord, QUIESCENCE_MS } from "./parse.mts";
import type { FleetProvenance } from "./replay.mts";
import {
	buildFleetSummary,
	CACHE_READ_MULT,
	CACHE_WRITE_1H_MULT,
	CACHE_WRITE_5M_MULT,
	type FleetStoreLine,
	listRatesForModel,
	RESIDUAL_CAUSES,
	readReceiptStore,
	renderFleetSummary,
	repairReceiptStoreTail,
} from "./rollup.mts";

const MONTH = "2026-07";

/** Fresh per-test directory, removed when the test ends. */
const tempDir = (t: TestContext): string => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-rollup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

/** A valid FleetRecord (allowlist keys only), overridable per test. */
const record = (over: Partial<FleetRecord> = {}): FleetRecord => ({
	messageId: "msg_01RollupAAA",
	model: "claude-opus-5",
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

/** A receipt-store line shaped exactly like replayMonth's `{receipt, provenance}` append. */
const storeLine = (over: {
	messageId: string;
	model: string;
	sessionHash: string;
	occurredAt: string;
	isSidechain: boolean;
	cost: number;
	auditHash: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	tiers: { m5: number; h1: number };
	tableVersion?: string;
	rateSource?: string;
}): FleetStoreLine => {
	const provenance: FleetProvenance = {
		mode: "dry-run",
		source: "claude-code-transcript",
		occurredAt: over.occurredAt,
		capturedAt: "2026-08-10T12:00:00.000Z",
		sessionHash: over.sessionHash,
		isSidechain: over.isSidechain,
		messageId: over.messageId,
		cacheWriteTiers: over.tiers,
	};
	return {
		receipt: {
			cost: over.cost,
			auditHash: over.auditHash,
			model: over.model,
			usageSource: "provider",
			usage: over.usage,
			meter: { rateSource: over.rateSource ?? "table" },
			pricing: { tableVersion: over.tableVersion ?? "2026-08-10" },
		},
		provenance,
	};
};

/**
 * The two hand-checked July lines every rollup test builds on.
 *
 * List-price hand-derivation (published $/MTok from
 * platform.claude.com/docs/en/about-claude/pricing, retrieved 2026-08-10):
 *  opus-5   ($5 in / $25 out):  (1000×5 + 500×25 + 2000×5×0.1 + 3000×5×1.25 + 4000×5×2) / 1e6
 *                             = (5000 + 12500 + 1000 + 18750 + 40000) / 1e6 = 0.07725
 *  haiku-4-5 ($1 in / $5 out): (10000×1 + 2000×5 + 50000×1×0.1 + 8000×1×1.25 + 0) / 1e6
 *                             = (10000 + 10000 + 5000 + 10000 + 0) / 1e6 = 0.035
 *  total listPriceUsd = 0.11225
 */
const julyLines = (): FleetStoreLine[] => [
	storeLine({
		messageId: "msg_opus",
		model: "claude-opus-5",
		sessionHash: "aaaaaaaaaaaa",
		occurredAt: "2026-07-15T10:00:00.000Z",
		isSidechain: false,
		cost: 773,
		auditHash: "a".repeat(64),
		usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 7000 },
		tiers: { m5: 3000, h1: 4000 },
	}),
	storeLine({
		messageId: "msg_haiku",
		model: "claude-haiku-4-5",
		sessionHash: "aaaaaaaaaaaa",
		occurredAt: "2026-07-16T11:00:00.000Z",
		isSidechain: true,
		cost: 350,
		auditHash: "b".repeat(64),
		usage: {
			inputTokens: 10_000,
			outputTokens: 2000,
			cacheReadTokens: 50_000,
			cacheWriteTokens: 8000,
		},
		tiers: { m5: 8000, h1: 0 },
	}),
];

const julyChainHashes = (): Set<string> => new Set(["a".repeat(64), "b".repeat(64)]);

const summaryOpts = (lines: FleetStoreLine[]) => ({
	lines,
	chainHashes: julyChainHashes(),
	publishedMonth: MONTH,
	scanReport: { dirsScanned: 3, candidateDirsSkipped: 2, deferredIds: 7 },
	generatedAt: "2026-08-10T12:34:56.000Z",
	collectorCommit: "abc1234",
});

// ── pre-flight ──

test("pre-flight aborts listing offenders (unknown model, fast speed) before any vault write", async (t) => {
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	const records = [
		record({ messageId: "msg_unknownmodel", model: "totally-unknown-model-x" }),
		record({ messageId: "msg_fastmode", model: "claude-opus-5", speed: "fast" }),
		record({ messageId: "msg_ok", model: "claude-opus-5" }),
	];

	await assert.rejects(
		collectRecords({ records, fleetDir, vaultRoot }),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			// Both offenders listed, each with its reason; the clean record is not.
			assert.match(err.message, /msg_unknownmodel/);
			assert.match(err.message, /FALLBACK_RATE/);
			assert.match(err.message, /msg_fastmode/);
			assert.match(err.message, /speed "fast"/);
			assert.ok(!err.message.includes("msg_ok"));
			return true;
		},
		"pre-flight must reject with every offender named",
	);

	// BEFORE any vault write: the month vault was never created…
	assert.equal(existsSync(vaultRoot), false, "vault root must stay absent");
	// …and no INTENT reached the journal (the WAL exists but is empty).
	const journalPath = join(fleetDir, "journal", `${MONTH}.jsonl`);
	assert.equal(readFileSync(journalPath, "utf-8"), "", "journal must hold no INTENT");
});

// ── rollup ──

test("rollup determinism: same inputs render byte-identical JSON with sorted keys", () => {
	// A June line proves the backfill window: it moves firstOccurredAt but is
	// excluded from every month figure (and needs no July chain membership).
	const june = storeLine({
		messageId: "msg_june",
		model: "claude-sonnet-5",
		sessionHash: "bbbbbbbbbbbb",
		occurredAt: "2026-06-30T23:59:59.000Z",
		isSidechain: false,
		cost: 10,
		auditHash: "c".repeat(64),
		usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
		tiers: { m5: 0, h1: 0 },
		tableVersion: "2026-08-09",
	});
	const linesA = [...julyLines(), june];
	// Same inputs in REVERSED order: the rollup must not depend on input order.
	const linesB = structuredClone(linesA).reverse();

	const renderedA = renderFleetSummary(buildFleetSummary(summaryOpts(linesA)));
	const renderedB = renderFleetSummary(buildFleetSummary(summaryOpts(linesB)));
	assert.equal(renderedA, renderedB, "byte-identical across runs and input orderings");
	assert.ok(renderedA.endsWith("\n"));

	const parsed = JSON.parse(renderedA) as Record<string, unknown>;

	// Keys sorted, recursively, in the rendered bytes (JSON.parse preserves
	// insertion order for non-numeric keys, so this walk sees render order).
	const assertSortedKeys = (value: unknown, path: string): void => {
		if (Array.isArray(value)) {
			for (const [i, v] of value.entries()) assertSortedKeys(v, `${path}[${i}]`);
			return;
		}
		if (value !== null && typeof value === "object") {
			const keys = Object.keys(value);
			assert.deepStrictEqual(keys, [...keys].sort(), `keys sorted at ${path}`);
			for (const k of keys) {
				assertSortedKeys((value as Record<string, unknown>)[k], `${path}.${k}`);
			}
		}
	};
	assertSortedKeys(parsed, "$");

	// The June line moved the window but not the month block.
	const window = parsed.window as { firstOccurredAt: string; publishedMonth: string };
	assert.equal(window.firstOccurredAt, "2026-06-30T23:59:59.000Z");
	assert.equal(window.publishedMonth, MONTH);
	const month = parsed.month as { calls: number };
	assert.equal(month.calls, 2, "June is outside the published month");
	// Only July's table version is observed for the published month.
	assert.deepStrictEqual(parsed.tableVersions, ["2026-08-10"]);

	// Residual causes: pinned strings, spec §6 order, verbatim.
	assert.deepStrictEqual(parsed.residualCauses, [
		"cache-write TTL split",
		"pricing-table vs list-price drift (incl. promotional rates)",
		"capture-time vs occurrence-time pricing across table versions",
		"kernel per-call rounding floor/ceiling",
	]);
	assert.deepStrictEqual(parsed.residualCauses, [...RESIDUAL_CAUSES]);
});

test("list-price math matches hand-computed fixture values", () => {
	// sonnet-5's list rate is the INTRODUCTORY $2 in / $10 out published rate
	// (in effect through 2026-08-31) — this line makes that rate load-bearing
	// in the hand-derivation so a silent revert to standard $3/$15 fails here:
	//  sonnet-5 ($2 in / $10 out): (2000×2 + 1000×10 + 5000×2×0.1 + 1000×2×1.25 + 500×2×2) / 1e6
	//                            = (4000 + 10000 + 1000 + 2500 + 2000) / 1e6 = 0.0195
	//  total listPriceUsd = 0.11225 (julyLines) + 0.0195 = 0.13175
	const sonnet = storeLine({
		messageId: "msg_sonnet",
		model: "claude-sonnet-5",
		sessionHash: "cccccccccccc",
		occurredAt: "2026-07-17T12:00:00.000Z",
		isSidechain: false,
		cost: 200,
		auditHash: "d".repeat(64),
		usage: { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 1500 },
		tiers: { m5: 1000, h1: 500 },
	});
	const summary = buildFleetSummary({
		...summaryOpts([...julyLines(), sonnet]),
		chainHashes: new Set([...julyChainHashes(), "d".repeat(64)]),
	});

	assert.equal(summary.month.listPriceUsd, 0.13175, "hand-derived in the fixture comments");
	assert.equal(summary.month.calls, 3);
	assert.equal(summary.month.inputTokens, 13_000);
	assert.equal(summary.month.outputTokens, 3500);
	assert.equal(
		summary.month.cacheWriteTokens,
		16_500,
		"tier sum: (3000+4000) + (8000+0) + (1000+500)",
	);
	assert.equal(summary.month.cacheReadTokens, 57_000);
	assert.equal(summary.month.usertokens, 1323);
	assert.equal(summary.month.kernelUsd, 0.1323, "1 usertoken = $0.0001");

	// Published multipliers pinned (source-URL comments live on the constants).
	assert.equal(CACHE_WRITE_5M_MULT, 1.25);
	assert.equal(CACHE_WRITE_1H_MULT, 2);
	assert.equal(CACHE_READ_MULT, 0.1);

	// byModel: spend-descending, every row rateSource "table" by construction.
	assert.deepStrictEqual(summary.byModel, [
		{ model: "claude-opus-5", calls: 1, usertokens: 773, kernelUsd: 0.0773, rateSource: "table" },
		{ model: "claude-haiku-4-5", calls: 1, usertokens: 350, kernelUsd: 0.035, rateSource: "table" },
		{ model: "claude-sonnet-5", calls: 1, usertokens: 200, kernelUsd: 0.02, rateSource: "table" },
	]);

	// Two sessions, spend-descending; half of the first session's calls sidechain.
	assert.deepStrictEqual(summary.bySession, [
		{ sessionHash: "aaaaaaaaaaaa", calls: 2, usertokens: 1123, sidechainShare: 0.5 },
		{ sessionHash: "cccccccccccc", calls: 1, usertokens: 200, sidechainShare: 0 },
	]);

	// Model resolution mirrors getModelRates (exact, then longest prefix) but
	// THROWS where the kernel would fall back — no silent list-price guess.
	assert.deepStrictEqual(listRatesForModel("claude-opus-5"), { input: 5, output: 25 });
	assert.deepStrictEqual(listRatesForModel("claude-opus-5-20260901"), { input: 5, output: 25 });
	// Introductory published rate, through 2026-08-31 (see LIST_USD_PER_MTOK).
	assert.deepStrictEqual(listRatesForModel("claude-sonnet-5"), { input: 2, output: 10 });
	assert.throws(() => listRatesForModel("totally-unknown-model-x"), /no published list rate/);
});

test("bySession folds everything beyond the top 8 into 'other'", () => {
	const lines: FleetStoreLine[] = [];
	const hashes = new Set<string>();
	for (let i = 0; i < 10; i++) {
		const auditHash = i.toString(16).repeat(64);
		hashes.add(auditHash);
		lines.push(
			storeLine({
				messageId: `msg_s${i}`,
				model: "claude-opus-5",
				sessionHash: `00000000000${i.toString(16)}`,
				occurredAt: `2026-07-0${(i % 9) + 1}T10:00:00.000Z`,
				isSidechain: i === 9, // the cheapest session's call is a sidechain
				cost: (10 - i) * 100, // session 0 spends 1000 … session 9 spends 100
				auditHash,
				usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
				tiers: { m5: 0, h1: 0 },
			}),
		);
	}
	const summary = buildFleetSummary({ ...summaryOpts(lines), chainHashes: hashes });

	assert.equal(summary.bySession.length, 9, "top 8 + the fold");
	assert.deepStrictEqual(
		summary.bySession.slice(0, 8).map((s) => s.usertokens),
		[1000, 900, 800, 700, 600, 500, 400, 300],
		"top 8 by spend, descending",
	);
	assert.deepStrictEqual(summary.bySession[8], {
		sessionHash: "other",
		calls: 2,
		usertokens: 300, // 200 + 100
		sidechainShare: 0.5, // one of the two folded calls is a sidechain
	});
});

// ── receipt-store tail repair ──

test("receipt store: a torn final line is DISCARDED before the next append, not just skipped", (t) => {
	// Codex PR-91 #4. The reader tolerates an unterminated final line, but the
	// bytes stay on disk: the next append concatenates onto them and produces a
	// newline-terminated malformed INTERIOR line, which the reader then refuses
	// forever — every later rollup dies on a month that can never be repaired by
	// re-running. Mirrors the journal's proven protocol: truncate back to the
	// last record boundary, and report what was discarded.
	const dir = tempDir(t);
	const path = join(dir, "receipts", `${MONTH}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	const [first, second] = julyLines();
	assert.ok(first && second);
	const committed = JSON.stringify(first);
	const torn = JSON.stringify(second).slice(0, 37); // crash mid-write
	writeFileSync(path, `${committed}\n${torn}`);

	const repair = repairReceiptStoreTail(path);
	assert.deepStrictEqual(repair, { discarded: torn });
	assert.equal(readFileSync(path, "utf-8"), `${committed}\n`, "torn bytes gone from disk");

	// The next append now lands on a clean record boundary.
	appendFileSync(path, `${JSON.stringify(second)}\n`);
	const lines = readReceiptStore(path);
	assert.equal(lines.length, 2);
	assert.equal(lines[1]?.provenance.messageId, "msg_haiku");

	// Repair is idempotent on an already-clean store.
	assert.equal(repairReceiptStoreTail(path), null);
	assert.equal(repairReceiptStoreTail(join(dir, "receipts", "2026-01.jsonl")), null);
});

test("receipt store: a complete final record that lost only its newline is TERMINATED, not discarded", (t) => {
	// The other half of the journal's protocol. These bytes ARE a committed
	// record (the reader already counts it); discarding them would delete a real
	// receipt, and leaving them unterminated would let the next append glue a
	// second record onto the same line.
	const dir = tempDir(t);
	const path = join(dir, "receipts", `${MONTH}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	const [first, second] = julyLines();
	assert.ok(first && second);
	writeFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}`);

	assert.equal(repairReceiptStoreTail(path), null, "nothing discarded");
	assert.ok(readFileSync(path, "utf-8").endsWith("}\n"), "terminator restored");
	appendFileSync(path, `${JSON.stringify(first)}\n`);
	assert.equal(readReceiptStore(path).length, 3);
});

test("receipt store: a parseable tail that is NOT a store line still refuses (no silent discard)", (t) => {
	const dir = tempDir(t);
	const path = join(dir, "receipts", `${MONTH}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(julyLines()[0])}\n{"foreign":"writer"}`);
	assert.throws(() => repairReceiptStoreTail(path), /malformed receipt-store line/);
});

// ── publish gate ──

test("publish gate accepts a genuinely collected month: clean WAL, chained DONEs, verify exit 0", async (t) => {
	// The refusal tests below prove the gate can say no; this proves it can say
	// yes — a gate that refused GOOD vaults would pass every refusal test while
	// making publishing impossible. Full real path: collectRecords mints through
	// real trust(), then the gate re-checks WAL + membership + workspace verify.
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	const records = [
		record({ messageId: "msg_gate_ok_1" }),
		record({ messageId: "msg_gate_ok_2", occurredAt: "2026-07-16T10:00:00.000Z" }),
	];

	const { months, minted } = await collectRecords({ records, fleetDir, vaultRoot });
	assert.deepStrictEqual(months, [MONTH]);
	assert.equal(minted, 2);

	const { transcript } = assertPublishable({
		fleetDir,
		month: MONTH,
		vaultRoot,
		verifyCli: VERIFY_CLI,
	});
	assert.equal(transcript.exitCode, 0);
	// The published command is the LITERAL invocation — node + the real cli
	// path + the real vault path, repo-root-relative — never an `npx` hint
	// that was not what ran (final-review must-fix 4).
	assert.ok(
		transcript.command.startsWith(`node ${join("packages", "verify", "dist", "cli.js")} `),
		`literal node invocation, got: ${transcript.command}`,
	);
	assert.ok(
		transcript.command.endsWith(join("vault", MONTH, ".usertrust")),
		`real vault path, got: ${transcript.command}`,
	);
	assert.ok(!transcript.command.includes("npx"), "no npx hint that was never executed");
	assert.ok(transcript.lines.length > 0, "the published transcript carries the verifier's output");
});

test("publish refuses when the journal has pending intents", (t) => {
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	const journal = openJournal(fleetDir, MONTH);
	journal.intent("msg_pending", "abc123def456", "{}");

	assert.throws(
		() => assertPublishable({ fleetDir, month: MONTH, vaultRoot, verifyCli: VERIFY_CLI }),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /pending INTENT/);
			assert.match(err.message, /msg_pending/);
			return true;
		},
	);
});

test("publish refuses when a DONE auditHash is missing from the month chain", async (t) => {
	// Gate check 2 — the one enforcing "the WAL may never claim a mint the
	// chain cannot show". Collect a real month, then mutate one DONE's
	// auditHash in the WAL: the gate must throw naming the missing hash.
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	await collectRecords({ records: [record({ messageId: "msg_gate_chain" })], fleetDir, vaultRoot });

	const journalPath = join(fleetDir, "journal", `${MONTH}.jsonl`);
	const mutated = readFileSync(journalPath, "utf-8")
		.split("\n")
		.map((line) => {
			if (line.trim() === "") return line;
			const entry = JSON.parse(line) as { type?: string; auditHash?: string };
			if (entry.type === "DONE") entry.auditHash = "e".repeat(64);
			return JSON.stringify(entry);
		})
		.join("\n");
	writeFileSync(journalPath, mutated);

	assert.throws(
		() => assertPublishable({ fleetDir, month: MONTH, vaultRoot, verifyCli: VERIFY_CLI }),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /DONE auditHash/);
			assert.match(err.message, /msg_gate_chain/);
			assert.match(err.message, new RegExp("e".repeat(12)), "names the missing hash");
			return true;
		},
	);
});

test("publish refuses when a chained call has NO receipt-store row", async (t) => {
	// Codex PR-91 round 2, #1(b) — the missing direction. The rollup checks
	// store → chain (nothing unchained reaches the page); nothing checked
	// chain → store, so a call whose store append was lost (crash between the
	// chain event and the append) simply vanished from the summary and the page
	// silently undercounted. Doctor the store by deleting one row: the gate must
	// refuse with both counts named.
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	await collectRecords({
		records: [
			record({ messageId: "msg_gate_count_1" }),
			record({ messageId: "msg_gate_count_2", occurredAt: "2026-07-16T10:00:00.000Z" }),
		],
		fleetDir,
		vaultRoot,
	});

	// The gate says yes while chain and store agree…
	const storePath = join(fleetDir, "receipts", `${MONTH}.jsonl`);
	assert.equal(readReceiptStore(storePath).length, 2);
	assert.equal(
		assertPublishable({ fleetDir, month: MONTH, vaultRoot, verifyCli: VERIFY_CLI }).transcript
			.exitCode,
		0,
	);

	// …and refuses the moment a chained call has no row.
	const kept = readFileSync(storePath, "utf-8").split("\n").filter(Boolean).slice(0, 1);
	writeFileSync(storePath, `${kept.join("\n")}\n`);
	assert.throws(
		() => assertPublishable({ fleetDir, month: MONTH, vaultRoot, verifyCli: VERIFY_CLI }),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /2 llm_call event/);
			assert.match(err.message, /1 receipt-store line/);
			return true;
		},
	);
});

test("publish refuses when usertrust-verify exits non-zero", (t) => {
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	const hash = "f".repeat(64);

	// Journal: clean (INTENT + DONE), DONE's auditHash present in the chain, and
	// one store row for the one chained call — so the FIRST THREE gate checks
	// pass and the refusal is verify's alone.
	const journal = openJournal(fleetDir, MONTH);
	journal.intent("msg_bad", "abc123def456", "{}");
	journal.done("msg_bad", hash, "fleet.abc123def456.msg_bad");
	const storePath = join(fleetDir, "receipts", `${MONTH}.jsonl`);
	mkdirSync(dirname(storePath), { recursive: true });
	writeFileSync(
		storePath,
		`${JSON.stringify(
			storeLine({
				messageId: "msg_bad",
				model: "claude-opus-5",
				sessionHash: "abc123def456",
				occurredAt: "2026-07-15T10:00:00.000Z",
				isSidechain: false,
				cost: 1,
				auditHash: hash,
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
				tiers: { m5: 0, h1: 0 },
			}),
		)}\n`,
	);

	// A chain whose event hash cannot be recomputed from its content: verify
	// walks it, fails the hash check, exits 1.
	const auditDir = join(vaultRoot, MONTH, ".usertrust", "audit");
	mkdirSync(auditDir, { recursive: true });
	const forged = {
		id: "evt_forged",
		timestamp: "2026-07-15T10:00:00.000Z",
		previousHash: "0".repeat(64),
		hash,
		kind: "llm_call",
		actor: "system",
		data: { costCenter: "fleet.abc123def456.msg_bad" },
		sequence: 1,
	};
	writeFileSync(join(auditDir, "events.jsonl"), `${JSON.stringify(forged)}\n`);

	assert.throws(
		() => assertPublishable({ fleetDir, month: MONTH, vaultRoot, verifyCli: VERIFY_CLI }),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /usertrust-verify exited/);
			assert.ok(!err.message.includes("pending INTENT"), "refusal must be verify's, not the WAL's");
			return true;
		},
	);
});

// ── CLI entry: the build check runs before any workspace import ──

test("dist preflight: the CLI entry statically imports node builtins ONLY", () => {
	// Codex PR-91 #6. ESM resolves every static import before the importing
	// module's first statement runs, so a friendly "run npx tsc -b" check cannot
	// live downstream of `import … from "usertrust"`: on a clean checkout
	// (dist/ gitignored, `npm ci` does not build workspaces) the operator gets
	// ERR_MODULE_NOT_FOUND instead. The entry's import list IS the guarantee.
	const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "fleet-collector.mts");
	const src = readFileSync(entry, "utf-8");
	const specifiers = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";$/gm)].map((m) => m[1]);
	assert.ok(specifiers.length >= 3, `expected the entry's own imports, got ${specifiers.length}`);
	for (const spec of specifiers) {
		assert.ok(spec?.startsWith("node:"), `entry must not statically import ${spec}`);
	}
	// …and the check gates the dynamic import that pulls the workspace in.
	const check = src.indexOf("coreDistBuilt(REPO_ROOT)");
	const dynamic = src.indexOf('await import("./fleet/collect.mts")');
	assert.ok(check > 0, "entry must run the build check");
	assert.ok(dynamic > check, "the build check must precede the dynamic import");
});

test("dist preflight: the probe answers built vs unbuilt roots", (t) => {
	assert.equal(coreDistBuilt(REPO_ROOT), true, "this worktree is built (npx tsc -b)");
	assert.equal(coreDistBuilt(tempDir(t)), false, "an unbuilt root must fail the probe");
});

// ── publish month ──

test("publish month is frozen at the clock captured at run START", () => {
	// Codex PR-91 #5. A long replay can cross a UTC month boundary; recomputing
	// the month afterwards points the publish at a month the run never touched —
	// its journal was never opened, so the summary is empty or wrong.
	const startMs = Date.parse("2026-08-31T23:58:00.000Z");
	const afterMs = Date.parse("2026-09-01T00:03:00.000Z");
	assert.equal(publishMonthFor(startMs), "2026-08");
	// The wall clock at rollup time HAS crossed…
	assert.equal(new Date(afterMs).toISOString().slice(0, 7), "2026-09");
	// …and the run-start clock still answers August, which is what publishes.
	assert.equal(publishMonthFor(startMs), "2026-08");
	assert.equal(publishMonthFor(afterMs), "2026-09", "pure function of the clock it is handed");
});

// ── scan report ──

test("scan report counts records refused for unusable token counters", (t) => {
	// The reporting half of Codex PR-91 #2: refusals are surfaced, never silent.
	const dir = tempDir(t);
	const projects = join(dir, "projects");
	mkdirSync(join(projects, "proj"), { recursive: true });
	const line = (id: string, usage: Record<string, unknown>) =>
		JSON.stringify({
			type: "assistant",
			sessionId: "scan-session",
			timestamp: "2026-07-15T10:00:00.000Z",
			isSidechain: false,
			message: { id, type: "message", role: "assistant", model: "claude-opus-5", usage },
		});
	writeFileSync(
		join(projects, "proj", "session.jsonl"),
		`${line("msg_scan_good", { input_tokens: 5, output_tokens: 6 })}\n` +
			`${line("msg_scan_bad", { input_tokens: 5 })}\n`,
	);

	const scan = scanTranscripts(
		projects,
		{ exact: new Set(["proj"]), prefixes: [] },
		Date.now() + 60 * 60 * 1000, // well past quiescence
	);
	assert.equal(scan.filesParsed, 1);
	assert.equal(scan.records.length, 1);
	assert.equal(scan.records[0]?.messageId, "msg_scan_good");
	assert.equal(scan.malformedRecords, 1);
	assert.equal(scan.deferredIds, 0);
});

test("an id deferred by ANY active file is deferred everywhere — the stale copy never ships", (t) => {
	// Codex PR-91 round 2, #2: the cross-FILE twin of the A→B→A quiescence bug
	// (spec r2/C2). The same message id lives in an OLD quiescent transcript and
	// in the continuation that is still being written; per-file deferral only
	// suppressed the active file's copy, so the run ingested the OLD, superseded
	// one — permanently, since the id is `seen()` from then on.
	const dir = tempDir(t);
	const projects = join(dir, "projects");
	mkdirSync(join(projects, "proj"), { recursive: true });
	const line = (id: string, occurredAt: string, input: number, output: number) =>
		JSON.stringify({
			type: "assistant",
			sessionId: "cross-file-session",
			timestamp: occurredAt,
			isSidechain: false,
			message: {
				id,
				type: "message",
				role: "assistant",
				model: "claude-opus-5",
				usage: {
					input_tokens: input,
					output_tokens: output,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		});

	// The old, quiescent transcript: a partial copy of msg_shared plus an id of
	// its own. Its mtime is pushed well past quiescence.
	const quiescent = join(projects, "proj", "a-quiescent.jsonl");
	writeFileSync(
		quiescent,
		`${line("msg_shared", "2026-07-15T10:00:00.000Z", 5, 5)}\n` +
			`${line("msg_only_old", "2026-07-15T10:00:01.000Z", 7, 7)}\n`,
	);
	const old = Date.now() / 1000 - 24 * 60 * 60;
	utimesSync(quiescent, old, old);

	// The continuation, still being written RIGHT NOW: it restates msg_shared
	// with the cumulative totals.
	const active = join(projects, "proj", "b-active.jsonl");
	writeFileSync(active, `${line("msg_shared", "2026-07-15T10:05:00.000Z", 50, 50)}\n`);

	const allow = { exact: new Set(["proj"]), prefixes: [] as string[] };
	const scan = scanTranscripts(projects, allow, Date.now());
	assert.equal(scan.filesParsed, 2);
	assert.deepStrictEqual(
		scan.records.map((r) => r.messageId),
		["msg_only_old"],
		"the shared id is deferred by the ACTIVE file, so the quiescent file's stale copy is withheld",
	);
	assert.equal(scan.deferredIds, 1, "distinct ids deferred");
	assert.equal(scan.withheldRecords, 1, "one quiescent-file record withheld by the global set");

	// Once the continuation goes quiescent too, the FINAL occurrence wins: both
	// files offer msg_shared and the global dedupe keeps the later, larger one.
	const later = scanTranscripts(projects, allow, Date.now() + QUIESCENCE_MS + 60_000);
	assert.equal(later.deferredIds, 0);
	assert.equal(later.withheldRecords, 0);
	const deduped = dedupeRecords(later.records);
	assert.deepStrictEqual(deduped.map((r) => r.messageId).sort(), ["msg_only_old", "msg_shared"]);
	const shared = deduped.find((r) => r.messageId === "msg_shared");
	assert.ok(shared, "msg_shared missing once both files are quiescent");
	assert.equal(shared.inputTokens, 50, "the continuation's restated total, not the stale 5");
	assert.equal(shared.outputTokens, 50);
	assert.equal(shared.occurredAt, "2026-07-15T10:05:00.000Z");
});

// ── allowlist mangling ──

test("project-dir allowlist computes both historical manglings from real paths", () => {
	const allow = projectDirAllowlist(["/Users/camhome/usertrust"]);
	assert.ok(allow.exact.has("-Users-camhome-usertrust"));
	// Claude Code has used two manglings over time: slash→dash with dots kept,
	// and every non-alphanumeric→dash. Both worktree prefixes must be covered.
	assert.ok(allow.prefixes.includes("-Users-camhome-usertrust-.worktrees-"));
	assert.ok(allow.prefixes.includes("-Users-camhome-usertrust--worktrees-"));
	// A sibling dir that merely shares the name must not prefix-match.
	const name = "-Users-camhome-usertrust-foo";
	assert.ok(!allow.exact.has(name) && !allow.prefixes.some((p) => name.startsWith(p)));
});
