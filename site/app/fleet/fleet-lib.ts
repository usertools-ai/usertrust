import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../lib/receipt-json";

/**
 * fleet-lib — typed loaders, formatters and slicers for the /fleet page.
 *
 * The page renders EVERY figure from the committed artifacts under
 * site/public/fleet/ (fleet-summary.json, chain.jsonl, verify-transcript.json
 * — produced by `npm run fleet:collect -- --publish` at the repo root, never
 * hand-written). No component in app/fleet/ carries a digit literal; the
 * check-facts prebuild gate scans that directory to keep it that way, and the
 * formatters here are the only path from artifact to pixel.
 *
 * Loaders resolve against process.cwd(), which is site/ for `next build`,
 * `next dev` AND `npm test` — the three places this module runs. This module
 * touches node:fs, so it is server-only by construction; importing it from a
 * client component fails the build, which is the correct failure.
 */

// ── shapes (mirrors scripts/fleet/rollup.mts's FleetSummary — the data
//    contract is the published file's bytes, so the type lives with its
//    consumer rather than importing across the site/ package boundary) ──

export interface FleetSummary {
	generatedAt: string;
	collectorCommit: string;
	tableVersions: string[];
	window: { firstOccurredAt: string; publishedMonth: string };
	scanReport: { dirsScanned: number; candidateDirsSkipped: number; deferredIds: number };
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

/** One event of the published month chain (core audit-event shape). */
export interface FleetChainEvent {
	sequence: number;
	kind: string;
	hash: string;
	previousHash: string;
	timestamp: string;
	data: {
		costCenter?: string;
		model?: string;
		cost?: number;
		usage?: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
		};
		appliedRates?: Record<string, number>;
		rateSource?: string;
		pricingTableVersion?: string;
		usageSource?: string;
	};
}

export interface FleetVerifyTranscript {
	command: string;
	lines: string[];
	exitCode: number;
}

// ── formatters ──

const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/** Usertokens: full precision, thousands separators, unit suffix. */
export function formatUt(n: number): string {
	return `${n.toLocaleString("en-US")} ut`;
}

/** USD, always two decimal places (exact figures live in the artifact). */
export function formatUsd(n: number): string {
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const dropTrailingZero = (s: string): string => s.replace(/\.0$/, "");

/**
 * Meter totals: exact with separators below a million; abbreviated (M/B, one
 * decimal, trailing .0 dropped) above — a fleet month's cache reads run to ten
 * digits, and the exact figure is one curl away in fleet-summary.json.
 */
export function formatMeter(n: number): string {
	if (n >= BILLION) return `${dropTrailingZero((n / BILLION).toFixed(1))}B`;
	if (n >= MILLION) return `${dropTrailingZero((n / MILLION).toFixed(1))}M`;
	return n.toLocaleString("en-US");
}

/** Sidechain share: fraction → percent, at most one decimal place. */
export function formatShare(x: number): string {
	return `${dropTrailingZero((x * 100).toFixed(1))}%`;
}

/** Date part of an ISO timestamp (the backfill origin, the generated-at day). */
export function isoDay(ts: string): string {
	return ts.slice(0, 10);
}

const HASH_PREFIX_CHARS = 12;

/** Twelve-hex hash prefix with an ellipsis — the site's chain-display idiom. */
export function shortHash(hash: string): string {
	return `${hash.slice(0, HASH_PREFIX_CHARS)}…`;
}

// ── chain parsing + slicing ──

/**
 * Parse the published chain.jsonl. Fail-loud: this file is a committed,
 * gate-checked artifact, so an unparseable or hash-less line is a build
 * defect, never something to skip past silently.
 */
export function parseChainJsonl(text: string): FleetChainEvent[] {
	const events: FleetChainEvent[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`fleet page: unparseable chain.jsonl line ${i + 1}`);
		}
		const event = parsed as FleetChainEvent;
		if (typeof event.hash !== "string" || typeof event.sequence !== "number") {
			throw new Error(`fleet page: chain.jsonl line ${i + 1} carries no hash/sequence`);
		}
		events.push(event);
	}
	return events.sort((a, b) => a.sequence - b.sequence);
}

/** The chain-tail panel length. Display window only — never a data claim. */
export const CHAIN_TAIL_COUNT = 8;

/** Last N events in INGEST ORDER (ascending sequence — how they entered). */
export function chainTail(events: FleetChainEvent[], count = CHAIN_TAIL_COUNT): FleetChainEvent[] {
	return events.slice(-count);
}

/** How many receipts the latest-receipts rail shows. */
export const LATEST_RECEIPT_COUNT = 3;

/** The most recent llm_call events, newest first. */
export function latestReceipts(
	events: FleetChainEvent[],
	count = LATEST_RECEIPT_COUNT,
): FleetChainEvent[] {
	return events
		.filter((e) => e.kind === "llm_call")
		.slice(-count)
		.reverse();
}

/**
 * ALLOWLIST projection of a chain event into the receipt JSON the page
 * renders. Chained fields only, copied key by key — nothing from the event
 * object graph passes through by spread, so `budgetRemaining` and
 * `receiptUrl` can never reach the page even if a future event carries them
 * (fleet receipts are local-mode; the page renders no receipt URL at all).
 */
export function receiptJson(event: FleetChainEvent): JsonObject {
	const d = event.data;
	const json: JsonObject = {};
	if (d.costCenter !== undefined) json.costCenter = d.costCenter;
	if (d.model !== undefined) json.model = d.model;
	if (d.usage !== undefined) {
		json.usage = {
			inputTokens: d.usage.inputTokens,
			outputTokens: d.usage.outputTokens,
			cacheReadTokens: d.usage.cacheReadTokens,
			cacheWriteTokens: d.usage.cacheWriteTokens,
		};
	}
	if (d.cost !== undefined) json.cost = d.cost;
	if (d.appliedRates !== undefined) json.appliedRates = { ...d.appliedRates };
	if (d.rateSource !== undefined) json.rateSource = d.rateSource;
	if (d.pricingTableVersion !== undefined) json.pricingTableVersion = d.pricingTableVersion;
	json.auditHash = event.hash;
	return json;
}

// ── sessions (top-N + "other" render model) ──

export interface SessionDisplayRow {
	label: string;
	calls: number;
	usertokens: number;
	share: string;
	isOther: boolean;
}

/**
 * The rollup already folds everything beyond its top slice into a synthetic
 * "other" row; the page renders rows in rollup order and only STYLES the
 * fold differently — it never re-sorts, re-folds, or invents a row.
 */
export function sessionDisplayRows(bySession: FleetSummary["bySession"]): SessionDisplayRow[] {
	return bySession.map((row) => ({
		label: row.sessionHash,
		calls: row.calls,
		usertokens: row.usertokens,
		share: formatShare(row.sidechainShare),
		isOther: row.sessionHash === "other",
	}));
}

// ── loaders ──

const fleetPublicDir = () => join(process.cwd(), "public", "fleet");

export function loadFleetSummary(): FleetSummary {
	return JSON.parse(
		readFileSync(join(fleetPublicDir(), "fleet-summary.json"), "utf-8"),
	) as FleetSummary;
}

export function loadChainEvents(): FleetChainEvent[] {
	return parseChainJsonl(readFileSync(join(fleetPublicDir(), "chain.jsonl"), "utf-8"));
}

export function loadVerifyTranscript(): FleetVerifyTranscript {
	return JSON.parse(
		readFileSync(join(fleetPublicDir(), "verify-transcript.json"), "utf-8"),
	) as FleetVerifyTranscript;
}
