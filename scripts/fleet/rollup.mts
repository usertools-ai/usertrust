/**
 * rollup.mts — fleet-ledger rollup (`fleet-summary.json` derivation).
 *
 * Derives the published month's summary from CHAIN EVENTS + the collector's
 * RECEIPT STORE — never the SDK receipt index (it truncates at `indexLimit`,
 * 10k default; spec r1/B4). The store carries the figures; the chain gates
 * them: a month store line whose `auditHash` is not a chain event is refused
 * outright, so nothing unchained can reach the page.
 *
 * TWO PRICED BASES, NEVER MIXED (spec §6):
 *  - Kernel base (canonical): the receipts' own `cost` in usertokens, priced
 *    through `PRICING_TABLE` at capture time. Summed, never recomputed here —
 *    the collector does NO kernel price math.
 *  - API-list-price equivalent (context only): recomputed below from the raw
 *    tier split using the provider's PUBLISHED per-MTok rates + multipliers.
 *    The two bases diverge for the reasons pinned in RESIDUAL_CAUSES — the
 *    1h cache-write tier alone bills 2x base input at list but the kernel
 *    table collapses it to the 5m rate (1.25x).
 *
 * DETERMINISM: `renderFleetSummary` sorts keys recursively and the builder
 * sorts every aggregate, so same inputs (any order) render byte-identical
 * JSON. The /fleet page renders every figure from this file; its bytes are
 * the whole data contract.
 */
import { existsSync, readFileSync } from "node:fs";
import type { FleetProvenance } from "./replay.mts";

// ── list-price constants (spec §6: source-URL comments required) ──

/**
 * 5-minute cache writes bill at 1.25x base input.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * ("Prompt caching pricing", retrieved 2026-08-10).
 */
export const CACHE_WRITE_5M_MULT = 1.25;

/**
 * 1-hour cache writes bill at 2x base input — the tier the kernel table
 * deliberately collapses to the 5m rate, which is residual cause #1 below.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * ("Prompt caching pricing", retrieved 2026-08-10).
 */
export const CACHE_WRITE_1H_MULT = 2;

/**
 * Cache hits (reads) bill at 0.1x base input.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * ("Prompt caching pricing", retrieved 2026-08-10).
 */
export const CACHE_READ_MULT = 0.1;

/**
 * Published base-input / output $/MTok per model — the SAME page Task 1 cited
 * for the kernel's PRICING_TABLE rows, so the two bases share one source.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * (model-pricing table, retrieved 2026-08-10). claude-sonnet-5 is entered at
 * the STANDARD $3/$15 rate; the $2/$10 introductory rate in effect through
 * 2026-08-31 is deliberately not entered — that drift is residual cause #2.
 */
export const LIST_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
	"claude-sonnet-4-6": { input: 3, output: 15 },
	"claude-haiku-4-5": { input: 1, output: 5 },
	"claude-opus-4-6": { input: 5, output: 25 },
	"claude-fable-5": { input: 10, output: 50 },
	"claude-opus-5": { input: 5, output: 25 },
	"claude-sonnet-5": { input: 3, output: 15 },
	"claude-opus-4-8": { input: 5, output: 25 },
};

/** Longest-first for prefix matching, mirroring pricing.ts's SORTED_TABLE. */
const SORTED_LIST_KEYS = Object.keys(LIST_USD_PER_MTOK).sort((a, b) => b.length - a.length);

/**
 * Resolve a model's published list rates the way `getModelRates` resolves
 * kernel rates (exact key, then longest prefix) — but THROW where the kernel
 * would fall back. A silent sonnet-class guess in the reconciliation block
 * would be exactly the unlabeled-basis mixing spec §6 forbids.
 */
export function listRatesForModel(model: string): { input: number; output: number } {
	if (Object.hasOwn(LIST_USD_PER_MTOK, model)) {
		const exact = LIST_USD_PER_MTOK[model];
		if (exact) return exact;
	}
	for (const key of SORTED_LIST_KEYS) {
		if (model.startsWith(key)) {
			const rates = LIST_USD_PER_MTOK[key];
			if (rates) return rates;
		}
	}
	throw new Error(
		`fleet rollup: no published list rate for model "${model}" — add its $/MTok row ` +
			`(with a source-URL comment) to LIST_USD_PER_MTOK before rolling up`,
	);
}

/**
 * Residual causes for kernel-vs-list divergence — pinned strings, spec §6
 * order, rendered verbatim on the page's reconciliation block.
 */
export const RESIDUAL_CAUSES: readonly string[] = [
	"cache-write TTL split",
	"pricing-table vs list-price drift (incl. promotional rates)",
	"capture-time vs occurrence-time pricing across table versions",
	"kernel per-call rounding floor/ceiling",
];

// ── shapes ──

/** The receipt fields the rollup reads from a store line (subset of TrustReceipt). */
export interface FleetStoreReceipt {
	cost: number;
	auditHash: string;
	model: string;
	usageSource?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	meter?: { rateSource: string };
	pricing?: { tableVersion: string };
}

/** One line of `.usertrust-fleet/receipts/<YYYY-MM>.jsonl` (replayMonth's append). */
export interface FleetStoreLine {
	receipt: FleetStoreReceipt;
	provenance: FleetProvenance;
}

export interface FleetScanReport {
	dirsScanned: number;
	candidateDirsSkipped: number;
	deferredIds: number;
}

/** The exact published shape — the /fleet page renders every figure from this. */
export interface FleetSummary {
	generatedAt: string;
	collectorCommit: string;
	tableVersions: string[];
	window: { firstOccurredAt: string; publishedMonth: string };
	scanReport: FleetScanReport;
	month: {
		calls: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		usertokens: number;
		kernelUsd: number;
		listPriceUsd: number;
	};
	byModel: {
		model: string;
		calls: number;
		usertokens: number;
		kernelUsd: number;
		rateSource: "table";
	}[];
	bySession: {
		sessionHash: string;
		calls: number;
		usertokens: number;
		sidechainShare: number;
	}[];
	residualCauses: string[];
}

// ── store reading ──

const asObject = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/**
 * Read one receipt-store JSONL file. Same crash tolerance as every other
 * fleet reader: ONLY an unterminated, unparseable FINAL line is skipped (the
 * one signature an append-only writer can leave); interior garbage throws —
 * a store we cannot read honestly must not feed a published summary.
 */
export function readReceiptStore(path: string): FleetStoreLine[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf-8");
	const lines = raw.split("\n");
	const out: FleetStoreLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			const isFinalLine = i === lines.length - 1 && !raw.endsWith("\n");
			if (isFinalLine) continue; // torn tail: the append never committed
			throw new Error(`fleet rollup: unparseable receipt-store line at ${path}:${i + 1}`);
		}
		const obj = asObject(parsed);
		const receipt = asObject(obj?.receipt);
		const provenance = asObject(obj?.provenance);
		if (!obj || !receipt || !provenance) {
			throw new Error(`fleet rollup: malformed receipt-store line at ${path}:${i + 1}`);
		}
		out.push(obj as unknown as FleetStoreLine);
	}
	return out;
}

// ── the rollup ──

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const byOccurredAtThenId = (a: FleetStoreLine, b: FleetStoreLine): number => {
	if (a.provenance.occurredAt !== b.provenance.occurredAt) {
		return a.provenance.occurredAt < b.provenance.occurredAt ? -1 : 1;
	}
	if (a.provenance.messageId === b.provenance.messageId) return 0;
	return a.provenance.messageId < b.provenance.messageId ? -1 : 1;
};

/** List-price USD equivalent of one line, from the RAW tier split (§6). */
function listPriceUsdFor(line: FleetStoreLine): number {
	const usage = line.receipt.usage;
	if (!usage) throw new Error(`fleet rollup: unreachable — usage checked by caller`);
	const rates = listRatesForModel(line.receipt.model);
	const tiers = line.provenance.cacheWriteTiers;
	return (
		(usage.inputTokens * rates.input +
			usage.outputTokens * rates.output +
			usage.cacheReadTokens * rates.input * CACHE_READ_MULT +
			tiers.m5 * rates.input * CACHE_WRITE_5M_MULT +
			tiers.h1 * rates.input * CACHE_WRITE_1H_MULT) /
		1e6
	);
}

/** Refuse a month line the page could not stand behind. */
function assertPublishableLine(line: FleetStoreLine, chainHashes: ReadonlySet<string>): void {
	const { receipt, provenance } = line;
	const id = provenance.messageId;
	if (!chainHashes.has(receipt.auditHash)) {
		throw new Error(
			`fleet rollup: receipt for ${id} (auditHash ${receipt.auditHash.slice(0, 12)}…) is not ` +
				`in the published month's chain — refusing to roll up unchained figures`,
		);
	}
	if (receipt.usageSource !== "provider" || !receipt.usage) {
		throw new Error(`fleet rollup: receipt for ${id} is not provider-metered`);
	}
	if (receipt.meter?.rateSource !== "table") {
		throw new Error(
			`fleet rollup: receipt for ${id} has rateSource ` +
				`${JSON.stringify(receipt.meter?.rateSource)} — fallback-priced rows must not exist ` +
				`(the pre-flight should have made this impossible)`,
		);
	}
	if (typeof receipt.pricing?.tableVersion !== "string") {
		throw new Error(`fleet rollup: receipt for ${id} carries no pricing.tableVersion`);
	}
	const tierSum = provenance.cacheWriteTiers.m5 + provenance.cacheWriteTiers.h1;
	if (tierSum !== receipt.usage.cacheWriteTokens) {
		throw new Error(
			`fleet rollup: receipt for ${id} tier sum ${tierSum} != chained cacheWriteTokens ` +
				`${receipt.usage.cacheWriteTokens} — the two priced bases would disagree on the split`,
		);
	}
}

/**
 * Build the published summary. `lines` is EVERY store line (all months — the
 * backfill window derives from the whole store); month figures cover only
 * `publishedMonth`, and each month line must be chain-checked against
 * `chainHashes` (that month's chain events).
 */
export function buildFleetSummary(opts: {
	lines: FleetStoreLine[];
	chainHashes: ReadonlySet<string>;
	publishedMonth: string;
	scanReport: FleetScanReport;
	generatedAt: string;
	collectorCommit: string;
}): FleetSummary {
	const { lines, chainHashes, publishedMonth, scanReport, generatedAt, collectorCommit } = opts;
	if (!/^\d{4}-\d{2}$/.test(publishedMonth)) {
		throw new Error(`fleet rollup: publishedMonth must be YYYY-MM, got ${publishedMonth}`);
	}
	if (lines.length === 0) {
		throw new Error("fleet rollup: empty receipt store — nothing to roll up");
	}

	// Deterministic internal order regardless of how the caller read the store.
	const sorted = [...lines].sort(byOccurredAtThenId);
	const firstLine = sorted[0];
	if (firstLine === undefined) throw new Error("fleet rollup: unreachable — length checked");
	const firstOccurredAt = firstLine.provenance.occurredAt;
	const monthLines = sorted.filter((l) => l.provenance.occurredAt.startsWith(publishedMonth));

	const month = {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		usertokens: 0,
		kernelUsd: 0,
		listPriceUsd: 0,
	};
	let listPriceUsd = 0;
	const tableVersions = new Set<string>();
	const byModel = new Map<string, { calls: number; usertokens: number }>();
	const bySession = new Map<string, { calls: number; usertokens: number; sidechain: number }>();

	for (const line of monthLines) {
		assertPublishableLine(line, chainHashes);
		const { receipt, provenance } = line;
		const usage = receipt.usage;
		if (!usage) throw new Error("fleet rollup: unreachable — asserted above");

		month.calls += 1;
		month.inputTokens += usage.inputTokens;
		month.outputTokens += usage.outputTokens;
		month.cacheReadTokens += usage.cacheReadTokens;
		month.cacheWriteTokens += usage.cacheWriteTokens;
		month.usertokens += receipt.cost;
		listPriceUsd += listPriceUsdFor(line);
		tableVersions.add(receipt.pricing?.tableVersion ?? "");

		const m = byModel.get(receipt.model) ?? { calls: 0, usertokens: 0 };
		m.calls += 1;
		m.usertokens += receipt.cost;
		byModel.set(receipt.model, m);

		const s = bySession.get(provenance.sessionHash) ?? { calls: 0, usertokens: 0, sidechain: 0 };
		s.calls += 1;
		s.usertokens += receipt.cost;
		if (provenance.isSidechain) s.sidechain += 1;
		bySession.set(provenance.sessionHash, s);
	}
	month.kernelUsd = round6(month.usertokens / 10_000); // 1 usertoken = $0.0001
	month.listPriceUsd = round6(listPriceUsd);

	const modelRows = [...byModel.entries()]
		.sort((a, b) => b[1].usertokens - a[1].usertokens || (a[0] < b[0] ? -1 : 1))
		.map(([model, m]) => ({
			model,
			calls: m.calls,
			usertokens: m.usertokens,
			kernelUsd: round6(m.usertokens / 10_000),
			rateSource: "table" as const,
		}));

	const sessionRows = [...bySession.entries()].sort(
		(a, b) => b[1].usertokens - a[1].usertokens || (a[0] < b[0] ? -1 : 1),
	);
	const top = sessionRows.slice(0, 8).map(([sessionHash, s]) => ({
		sessionHash,
		calls: s.calls,
		usertokens: s.usertokens,
		sidechainShare: round4(s.sidechain / s.calls),
	}));
	const rest = sessionRows.slice(8);
	if (rest.length > 0) {
		const folded = rest.reduce(
			(acc, [, s]) => {
				acc.calls += s.calls;
				acc.usertokens += s.usertokens;
				acc.sidechain += s.sidechain;
				return acc;
			},
			{ calls: 0, usertokens: 0, sidechain: 0 },
		);
		top.push({
			sessionHash: "other",
			calls: folded.calls,
			usertokens: folded.usertokens,
			sidechainShare: round4(folded.sidechain / folded.calls),
		});
	}

	return {
		generatedAt,
		collectorCommit,
		tableVersions: [...tableVersions].sort(),
		window: { firstOccurredAt, publishedMonth },
		scanReport: {
			dirsScanned: scanReport.dirsScanned,
			candidateDirsSkipped: scanReport.candidateDirsSkipped,
			deferredIds: scanReport.deferredIds,
		},
		month,
		byModel: modelRows,
		bySession: top,
		residualCauses: [...RESIDUAL_CAUSES],
	};
}

// ── deterministic rendering ──

/** Recursively sort object keys so identical summaries serialize identically. */
function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** Render `fleet-summary.json` bytes: sorted keys, tab indent, trailing newline. */
export function renderFleetSummary(summary: FleetSummary): string {
	return `${JSON.stringify(sortKeysDeep(summary), null, "\t")}\n`;
}
