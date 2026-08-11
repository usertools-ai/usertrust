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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	assertPublishable,
	collectRecords,
	projectDirAllowlist,
	VERIFY_CLI,
} from "../fleet-collector.mts";
import { openJournal } from "./journal.mts";
import type { FleetRecord } from "./parse.mts";
import type { FleetProvenance } from "./replay.mts";
import {
	buildFleetSummary,
	CACHE_READ_MULT,
	CACHE_WRITE_1H_MULT,
	CACHE_WRITE_5M_MULT,
	type FleetStoreLine,
	listRatesForModel,
	RESIDUAL_CAUSES,
	renderFleetSummary,
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

test("publish refuses when usertrust-verify exits non-zero", (t) => {
	const dir = tempDir(t);
	const fleetDir = join(dir, "fleet");
	const vaultRoot = join(dir, "vault");
	const hash = "f".repeat(64);

	// Journal: clean (INTENT + DONE), DONE's auditHash present in the chain —
	// so the FIRST two gate checks pass and the refusal is verify's alone.
	const journal = openJournal(fleetDir, MONTH);
	journal.intent("msg_bad", "abc123def456", "{}");
	journal.done("msg_bad", hash, "fleet.abc123def456.msg_bad");

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
