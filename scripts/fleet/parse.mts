/**
 * parse.mts — fleet-ledger transcript parser (usage metadata only).
 *
 * Reads one Claude Code transcript (.jsonl) and extracts provider-reported
 * usage metadata for the fleet ledger.
 *
 * PRIVACY CONTRACT — ALLOWLIST ONLY. Every emitted record is a fresh object
 * literal with EXACTLY the FleetRecord keys and primitive values; nothing from
 * the transcript object graph is passed through by reference. No conversation
 * content, no prompts, no paths, and no raw session ids ever leave this
 * module: sessionId is reduced to sha256(sessionId) hex, first 12 chars.
 * The Object.keys assertion in parse.test.mts is the enforcement of this
 * contract — widening the record means widening that test first, deliberately.
 *
 * QUIESCENCE — file-mtime age is the ONLY signal (spec r2/C2). During
 * streaming the SAME message.id is rewritten with cumulative usage, and
 * sessions interleave (A→B→A): seeing a different id after A does not prove
 * A's totals are final. A "later different id" shortcut was reviewed out; do
 * not reintroduce it. A non-quiescent file defers ALL of its ids.
 *
 * DEDUP — last occurrence in file order wins, matching the cumulative-usage
 * streaming behavior of real transcripts.
 *
 * COUNTERS — read exactly the way core's `readCount`
 * (packages/core/src/ledger/usage.ts) reads them, because core is what turns
 * these numbers back into a priced receipt. A line whose `input_tokens` or
 * `output_tokens` is not a usable count is REFUSED (reported as `malformed`),
 * never zero-filled: a fabricated zero would come back from the fake client as
 * a provider-reported zero, and core would label the receipt
 * `usageSource: "provider"` — the D5 mislabel, priced at the 1-usertoken floor.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** Spec-pinned: a file is ingestable once its mtime is >= 30 minutes old. */
export const QUIESCENCE_MS = 30 * 60 * 1000;

export interface FleetRecord {
	messageId: string;
	model: string;
	sessionHash: string;
	occurredAt: string;
	isSidechain: boolean;
	speed: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
}

export function isQuiescent(fileMtimeMs: number, nowMs: number): boolean {
	return nowMs - fileMtimeMs >= QUIESCENCE_MS;
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;

/**
 * Read one provider-reported count, mirroring core's `readCount`
 * (packages/core/src/ledger/usage.ts): `null` — distinct from `0` — for
 * anything unusable (absent, non-numeric, NaN, Infinity, negative), and a
 * fractional count rounds UP, because understatement is the direction that
 * silently drains a budget.
 *
 * Mirrored rather than imported: `usage.ts` is not a public `usertrust` export
 * and the collector may not deep-import `dist/`. Drift cannot hide — core
 * recomputes these same tiers when it mints, and the rollup refuses any line
 * whose tier sum disagrees with the chained `cacheWriteTokens`.
 */
const readCount = (value: unknown): number | null => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return Math.ceil(value) + 0; // `+ 0` normalizes -0, as core does
};

const asNonEmptyString = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/**
 * An assistant usage line we REFUSE rather than ingest: it looks like a real
 * call but does not carry the counters a priced receipt needs. Distinguished
 * from `null` (not an ingestable line at all) so the run report can say how
 * many real-looking lines were dropped instead of hiding them.
 */
const MALFORMED = "malformed" as const;
type ParsedLine = FleetRecord | typeof MALFORMED | null;

/**
 * Extract one FleetRecord from a parsed transcript line; `null` when the line
 * is not an ingestable assistant usage line (user lines, `<synthetic>` model
 * stubs, lines missing id/model/sessionId/timestamp/usage), `MALFORMED` when it
 * is one but its required token counters are unusable.
 */
function toFleetRecord(parsed: unknown): ParsedLine {
	const line = asObject(parsed);
	if (line?.type !== "assistant") return null;
	const message = asObject(line.message);
	if (!message) return null;
	const usage = asObject(message.usage);
	const messageId = asNonEmptyString(message.id);
	const model = asNonEmptyString(message.model);
	const sessionId = asNonEmptyString(line.sessionId);
	const occurredAt = asNonEmptyString(line.timestamp);
	if (!usage || !messageId || !model || !sessionId || !occurredAt) return null;
	if (model === "<synthetic>") return null;

	// D5: both required counters must be REPORTED. Zero-filling either one
	// fabricates a provider-metered call — the fake client would hand core a
	// numeric zero, core would stamp `usageSource: "provider"`, and the rollup
	// would publish an understated call as though the provider had said so.
	const inputTokens = readCount(usage.input_tokens);
	const outputTokens = readCount(usage.output_tokens);
	if (inputTokens === null || outputTokens === null) return MALFORMED;

	// Cache-write split, PRECEDENCE MIRRORING core's `fromAnthropicUsage`: real
	// usage carries a nested cache_creation block with ephemeral_5m/1h tiers;
	// older lines carry only the flat cache_creation_input_tokens. The nested
	// block wins only when at least ONE tier yields a usable count — presence of
	// the OBJECT is not enough, because an empty or junk-valued block beside a
	// valid flat counter would otherwise record ZERO cache writes and underprice
	// the call against the receipt core mints from the same payload. Falling
	// back gives {5m: flat, 1h: 0}, so the tier sum (5m + 1h) always equals
	// core's `cacheWriteTokens`.
	const nested = asObject(usage.cache_creation);
	const nested5m = nested ? readCount(nested.ephemeral_5m_input_tokens) : null;
	const nested1h = nested ? readCount(nested.ephemeral_1h_input_tokens) : null;
	const useNested = nested5m !== null || nested1h !== null;

	// ALLOWLIST: exactly the FleetRecord keys, all primitives, built fresh.
	return {
		messageId,
		model,
		sessionHash: createHash("sha256").update(sessionId).digest("hex").slice(0, 12),
		occurredAt,
		isSidechain: line.isSidechain === true,
		speed: asNonEmptyString(usage.speed) ?? "standard",
		inputTokens,
		outputTokens,
		cacheReadTokens: readCount(usage.cache_read_input_tokens) ?? 0,
		cacheWrite5m: useNested ? (nested5m ?? 0) : (readCount(usage.cache_creation_input_tokens) ?? 0),
		cacheWrite1h: useNested ? (nested1h ?? 0) : 0,
	};
}

export function parseTranscriptFile(
	path: string,
	nowMs: number,
): {
	records: FleetRecord[];
	deferred: number;
	/**
	 * Assistant usage lines REFUSED for unusable counters — reported so a
	 * corpus that starts dropping calls is visible in the run report rather
	 * than silently smaller. Zero for a deferred file: nothing there was
	 * ingested, so nothing there has been refused *yet*; the run that finally
	 * ingests the quiesced file is the run that counts it.
	 */
	malformed: number;
} {
	const mtimeMs = statSync(path).mtimeMs;
	const byId = new Map<string, FleetRecord>();
	let malformed = 0;
	for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = rawLine.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // unparseable line: skip, never throw
		}
		const outcome = toFleetRecord(parsed);
		if (outcome === MALFORMED) {
			malformed += 1;
			continue;
		}
		if (outcome) byId.set(outcome.messageId, outcome); // last wins
	}
	if (!isQuiescent(mtimeMs, nowMs)) {
		// Still streaming: defer EVERY id — partial ingest of a live file is how
		// cumulative usage gets double-counted or undercounted.
		return { records: [], deferred: byId.size, malformed: 0 };
	}
	return { records: [...byId.values()], deferred: 0, malformed };
}
