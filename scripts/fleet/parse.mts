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

const asCount = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const asNonEmptyString = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/**
 * Extract one FleetRecord from a parsed transcript line, or null when the line
 * is not an ingestable assistant usage line (user lines, `<synthetic>` model
 * stubs, lines missing id/model/sessionId/timestamp/usage).
 */
function toFleetRecord(parsed: unknown): FleetRecord | null {
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

	// Cache-write split: real usage carries a nested cache_creation block with
	// ephemeral_5m/1h tiers; older lines carry only the flat
	// cache_creation_input_tokens — spec default is {5m: flat, 1h: 0}, so the
	// tier sum (5m + 1h) always equals total cache writes.
	const nested = asObject(usage.cache_creation);

	// ALLOWLIST: exactly the FleetRecord keys, all primitives, built fresh.
	return {
		messageId,
		model,
		sessionHash: createHash("sha256").update(sessionId).digest("hex").slice(0, 12),
		occurredAt,
		isSidechain: line.isSidechain === true,
		speed: asNonEmptyString(usage.speed) ?? "standard",
		inputTokens: asCount(usage.input_tokens),
		outputTokens: asCount(usage.output_tokens),
		cacheReadTokens: asCount(usage.cache_read_input_tokens),
		cacheWrite5m: nested
			? asCount(nested.ephemeral_5m_input_tokens)
			: asCount(usage.cache_creation_input_tokens),
		cacheWrite1h: nested ? asCount(nested.ephemeral_1h_input_tokens) : 0,
	};
}

export function parseTranscriptFile(
	path: string,
	nowMs: number,
): {
	records: FleetRecord[];
	deferred: number;
} {
	const mtimeMs = statSync(path).mtimeMs;
	const byId = new Map<string, FleetRecord>();
	for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = rawLine.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // malformed line: skip, never throw
		}
		const record = toFleetRecord(parsed);
		if (record) byId.set(record.messageId, record); // last wins
	}
	if (!isQuiescent(mtimeMs, nowMs)) {
		// Still streaming: defer EVERY id — partial ingest of a live file is how
		// cumulative usage gets double-counted or undercounted.
		return { records: [], deferred: byId.size };
	}
	return { records: [...byId.values()], deferred: 0 };
}
