// Real usage from Claude Code's own session transcripts. Zero dependencies.
//
// WHAT THE TRANSCRIPT HOLDS (measured, shape only):
//  - One JSONL file per agent. The parent ("main") agent writes
//    <projectDir>/<sessionId>.jsonl — the hook's `transcript_path`. Every
//    subagent writes <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl,
//    beside agent-<agentId>.meta.json (which carries `agentType`). Each
//    subagent entry repeats the same `agentId` and has `isSidechain: true`; the
//    parent file carries no subagent usage.
//  - BUT a FORKED subagent's file begins with a copy of its ancestor's entries:
//    the same uuids and message ids, with `agentId` rewritten to the fork's own.
//    Read per agent, that usage would be counted once more per fork; the claims
//    below make each message id one agent's to post.
//  - Assistant entries carry `message.{id, model, usage, stop_reason}`. ONE API
//    response is written as SEVERAL entries sharing `message.id` (one per
//    content block, and progressively while streaming). Their input and cache
//    counts are identical; `output_tokens` only grows. A message is complete
//    once an entry has a non-null `stop_reason`, and one id can have several
//    complete entries. So an id's usage is the per-field MAX over its entries
//    (a later entry can never lower it), and an incomplete id waits. `message.id`
//    and the entry's `requestId` are one-to-one, so one id is one API request.
//  - `usage` is the provider's own response block: `input_tokens` (fresh input,
//    cache EXCLUDED), `cache_read_input_tokens`, `cache_creation_input_tokens`,
//    `output_tokens`. These four are already disjoint, which is exactly the
//    usertrust settle contract (cache tiers are never folded into inputTokens).
//
// THE MECHANISM: the PreToolUse hold IS the settlement vehicle. PreToolUse
// assigns the agent's new complete messages (one model's worth: the "window")
// to the hold it authorizes, sized to cover them plus the upcoming tool;
// PostToolUse settles that hold at exactly the window's counts. Messages no
// hold picked up (another model, a final answer with no tool call, a lock that
// was busy) are posted by ONE remainder authorize→settle per model at
// Stop/SubagentStop.
//
// WHAT THE SERVER HONOURS (its /v1/health `capabilities`, read once per hook;
// an older server strips request keys it does not know, so nothing is assumed):
//  - `idempotency-key`: every authorize that carries messages carries their
//    VEHICLE KEY (`vehicleKey`, from the message ids alone), and the server
//    charges a key at most once. A settle whose outcome is unknown then leaves
//    its vehicle UNRESOLVED — retried as itself, same key, same ids, same
//    counts, at the next Stop/SubagentStop — instead of losing it. Settles never
//    carry the key: a settle the server cannot match stays a plain 404.
//  - `principal`: every transcript-mode authorize names the agent, its type and
//    the session — and the `unit` / `role` from UT_CC_UNIT / UT_CC_ROLE when they
//    are valid principal fields; the server records it on every audit record the
//    call leaves (and, ledger-backed, as tags on its transfers).
//  - `release`: a hold with no usage is released (no failure, no charge) rather
//    than settled at the 1-unit floor or aborted.
//
// INVARIANTS:
//  1. Every hold is terminated EXACTLY ONCE: settled when usage was assigned to
//     it, given back when none was. A failed settle's hold is given back for
//     hygiene (the server's TTL sweep is the backstop). An unresolved vehicle's
//     retry is a new authorize under its key, not the old hold.
//  2. Every transcript message id is posted AT MOST ONCE, decided in ONE place:
//     every post path takes its ids from `selectOwn`, which returns an id only
//     under a CLAIM this cursor made and recorded — published exclusively before
//     anything could post it. A claim that already exists, whoever made it, is
//     never posted again. Within the agent: an id is assigned to one hold (and
//     settled with it), posted by one remainder settle, parked in one unresolved
//     vehicle, or marked `denied`; it is held in the cursor before anything that
//     could post it, and released only when the server proved nothing was posted
//     (authorize failed, or settle answered 400, or an unkeyed 404). Under a key
//     an ambiguous outcome — a 5xx, no answer, a crash mid-settle — is retried
//     as the same vehicle: exactly once. Without one it stays claimed: usage can
//     be lost to an outage, never posted twice.
//  3. An estimate is SETTLED only where it is the agent's only record, so a
//     period settled at an estimate never has its real usage posted as well:
//     with an agent id unsafe in a path (no transcript of it is ever read), or
//     once the agent's estimate mode is RECORDED — UT_CC_USAGE=estimate, its
//     transcript could not be read, a hook named none, or (for a subagent)
//     another agent of its session is in estimate mode, since a fork copies its
//     ancestor's responses — by a marker outside its cursor (`stickToEstimate`),
//     written before any estimate is settled, so losing the cursor cannot undo
//     it. While the transcript state cannot be used (the state dir, a corrupt
//     cursor) or the marker cannot be written, a hold is given back instead: the
//     transcript still holds that usage, for the first settle point that can.
//
// STATE, per (session, agent), in <state>/transcripts (private: 0700, ours):
//   { v: 2, byteOffset, partial, accounted, denied, assigned, estimateMode,
//     lastModel, unresolved }
//  - byteOffset: the transcript is read incrementally, a bounded chunk at a
//    time, and only past complete lines — at most about 64 MiB per hook, the
//    next one reading on; a file shorter than the offset is re-read from 0 (the
//    id sets still prevent re-posting).
//  - partial: every id seen but not yet accounted or denied, with its counts,
//    and whether this agent holds its claim.
//  - accounted / denied: the most recent 10 000 ids each.
//  - assigned: id → the vehicle it is BOUND to — a transferId, "remainder" (a
//    remainder in flight) or "authorizing" (written BEFORE PreToolUse's
//    authorize) — each recorded before any call that could post it. A binding
//    whose outcome nothing recorded — its hold gone, no journal naming it — may
//    have posted, so its ids are NEVER posted again (`reconcile`): a crash after
//    a settle went out is charged once, and a crash before is an under-count. A
//    hold such a crash left behind is never settled: the server's TTL sweep, and
//    TigerBeetle's own timeout, void it.
//  - unresolved: vehicle key → { ids, model, agentType, counts }.
// Shared by every agent of every session: <state>/transcripts/claims, one file
// per claimed message id (named by its SHA-256), naming the agent that owns it.
// Per (session, agent), OUTSIDE the cursor: <state>/transcripts/estimate/
// <session>__<agent>, the agent's recorded estimate mode. And once:
// <state>/transcripts/since, when this state was first made — a transcript entry
// written before it is never posted (see `firstRun`).
// A hold's outcome is journalled beside its pending file (<hold>.settling while
// in flight, <hold>.done after) so the cursor can be brought up to date by the
// next hook that gets the lock, even when the settling hook could not. Each name
// is the hold's own, keyed by its transfer (lib.mjs `holdFilePath`): a stale
// settler of an earlier hold of the same call finds only that hold's file, and
// one hold's outcome never lands in another's journal.
import { createHash, randomBytes } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { howToSet, settingName, settings } from "./config.mjs";
import { labelsFor, resolveJob } from "./job-log.mjs";
import {
	abandonHold,
	boundElsewhere,
	budgetShare,
	cleanup,
	clearPending,
	guardMode,
	isAlreadySettled,
	isUnknownRoute,
	isUnknownTransfer,
	jobCapable,
	jobHoldFields,
	LINKLESS,
	listPending,
	publishExclusive,
	recordUnconfirmedCall,
	recordWatchEvent,
	releaseHold,
	sanitize,
	sanitizeReason,
	say,
	serverCapabilities,
	serverRequest,
	stateRoot,
	tenantBinding,
	timeLeft,
	usageMode,
} from "./lib.mjs";

/** Never priced when its usage is all zero: Claude Code's local placeholder. */
const SYNTHETIC_MODEL = "<synthetic>";
/** A message no entry names a model for. */
const UNKNOWN_MODEL = "unknown";
/**
 * A model id as the transcript wrote it: 1 to 256 characters, none of them a
 * control, format or separator character. Pricing looks the id up VERBATIM (the
 * server's table and an operator's `customRates`), so an id is never rewritten:
 * one outside this rule is sent as `unknown`, never as a different id.
 */
const MODEL_ID = /^[^\p{C}\p{Z}]{1,256}$/u;

/**
 * The capability of a server that sizes a hold per cache tier, from
 * `estimatedCacheReadTokens` / `estimatedCacheWriteTokens` (see `holdEstimate`).
 */
const CACHE_TIERS = "authorize-cache-tiers";

const CURSOR_VERSION = 2;
/** v1 cursors (no `unresolved`) are read as v2 with nothing unresolved. */
const READABLE_CURSOR_VERSIONS = new Set([1, 2]);
/** A lock older than this is a crashed holder, not a live one. */
const STALE_LOCK_MS = 60_000;
/**
 * A hold left "settling" this long belongs to a crashed hook. It must stay ABOVE the
 * ledger's pending timeout (core's `LEDGER_HOLD_TIMEOUT_MS`, 5 min): the journal then
 * clears a stale record without giving its hold back, which strands nothing only
 * because the ledger has expired that hold by then. Pinned by
 * `tests/stale-settling.test.ts`.
 */
export const STALE_SETTLING_MS = 10 * 60_000;
const ID_HISTORY = 10_000;
const MAX_ID_CHARS = 256;
/** A transcript is read a chunk of this size at a time: a hook's memory stays bounded. */
const READ_CHUNK_BYTES = 1 << 20;
/** One hook reads on until this much is behind it; the next settle point reads on from there. */
const MAX_READ_BYTES = 64 << 20;
/**
 * A line longer than this is skipped unread. No entry with usage comes near it:
 * each holds one content block of one response, bounded by its output tokens.
 */
const MAX_LINE_BYTES = 16 << 20;
/** Only a line with this in it can carry usage. */
const USAGE_FIELD = Buffer.from('"usage"');
/** How long a hook that names no transcript waits for its agent's lock to record that. */
const NO_PATH_LOCK_WAIT_MS = 500;
/**
 * How long Stop and SubagentStop wait for the turn's final response to reach the
 * transcript (`awaitFinalResponse`), and how much of the transcript's tail they
 * read to find it.
 */
const FLUSH_WAIT_MS = 2_000;
const FLUSH_TAIL_BYTES = 256 << 10;
/*
 * The time limits of a hook's steps are shares of its budget (lib.mjs
 * `budgetShare`), so SessionEnd's short one still holds every step. At the 10 s
 * budget of every other hook: a transcript request takes at most 3 s, none starts
 * with less than 250 ms, 3 s are kept for giving back holds, and no claim is made
 * with less than 6 s left.
 */
const callTimeoutCap = () => budgetShare(0.3);
const minCall = () => budgetShare(0.025);
/** Stop, SubagentStop and SessionEnd keep this much for giving back holds without usage. */
export const cleanupReserve = () => budgetShare(0.3);
/** Claiming new message ids stops while less than this is left of the hook's budget. */
const claimFloor = () => budgetShare(0.6);
/** How long SessionEnd waits for an agent's lock that a finishing Stop still holds. */
export const sessionEndLockWait = () => budgetShare(0.2);

const AUTHORIZING = "authorizing";
const REMAINDER = "remainder";
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COUNT_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
/**
 * One field of a usertrust `principal`: the server refuses anything else. It must
 * equal core's PRINCIPAL_FIELD_PATTERN — a tightening there would turn every
 * attributed authorize into a 400 (a BLOCK in enforce mode); tests/principal-pattern
 * pins the two together.
 */
export const PRINCIPAL_FIELD = /^[A-Za-z0-9._:-]{1,128}$/;
/** What a settle vehicle's key is: the transcript messages it carries, and nothing else. */
const VEHICLE_KEY = /^cc:[0-9a-f]{48}$/;
/** Where the cross-agent message claims live, inside the private state dir (see `selectOwn`). */
const CLAIMS_DIR = "claims";
/** Where an agent's estimate mode is recorded, outside its cursor (see `stickToEstimate`). */
const ESTIMATE_DIR = "estimate";
/** When this plugin's transcript state was first made (see `firstRun`). */
const SINCE_FILE = "since";

/**
 * Untrusted strings in a path or an actor string (agent type/id) →
 * [A-Za-z0-9._-], at most 128 chars. Never a model id: see `modelId`.
 */
export function safeName(value, fallback) {
	const text =
		typeof value === "string" ? value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) : "";
	return text === "" ? fallback : text;
}

/** The transcript's model id, exactly as written, or null (see MODEL_ID). */
function modelId(value) {
	return typeof value === "string" && MODEL_ID.test(value) ? value : null;
}

function count(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function errText(err) {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-call timeout for a transcript request: at most its cap, and never past the budget. */
function callTimeout(reserveMs = 0) {
	return Math.min(callTimeoutCap(), timeLeft() - reserveMs);
}

function sumCounts(messages) {
	const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	for (const m of messages) for (const key of COUNT_KEYS) sum[key] += m[key];
	return sum;
}

/**
 * Messages by model, each model's in their order, the models in first-seen order:
 * one authorize→settle per model. Appended in place — linear in the backlog, which
 * after a long outage can be tens of thousands of messages, every one of them
 * waiting on this before any settle.
 */
export function groupByModel(messages, keyOf) {
	const groups = new Map();
	for (const m of messages) {
		// One settle never spans a job switch: a group is a model AND a job, so a
		// record never carries two jobs and never the job open at settle time.
		const key = keyOf === undefined ? m.model : `${m.model}\u0000${keyOf(m)}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [m]);
		else group.push(m);
	}
	return groups;
}

/** The ISO time of an epoch-ms value, or undefined when it is not a usable time. */
export function isoOf(ms) {
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * The job labels an AUTHORIZE carries: the job (or why there is none) and when the
 * usage began. The authorize capture is the only source of both on the record.
 */
export function authorizeLabels(labels) {
	return {
		...(labels.job === undefined ? {} : { job: labels.job }),
		...(labels.jobState === undefined ? {} : { jobState: labels.jobState }),
		...(labels.usageFrom === undefined ? {} : { usageFrom: labels.usageFrom }),
	};
}

/**
 * The labels a SETTLE carries: the hold's job again (the server refuses a settle
 * that names another, which only a bug could send) and when the usage ended. NEVER
 * `usageFrom`: the server refuses a settle that states it.
 */
export function settleLabels(labels) {
	return {
		...(labels.job === undefined ? {} : { job: labels.job }),
		...(labels.jobState === undefined ? {} : { jobState: labels.jobState }),
		...(labels.usageTo === undefined ? {} : { usageTo: labels.usageTo }),
	};
}

/** The earliest and latest finite `ts` of a message list, as ISO strings. */
export function usageSpan(messages) {
	// A loop, never `Math.min(...times)`: a spread of ~125k arguments throws a RangeError, and
	// this runs in EVERY hook over whatever backlog a long outage left.
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const m of messages) {
		const t = m.ts;
		if (!Number.isFinite(t)) continue;
		if (t < min) min = t;
		if (t > max) max = t;
	}
	if (min === Number.POSITIVE_INFINITY) return {};
	return { usageFrom: isoOf(min), usageTo: isoOf(max) };
}

function describeCounts(c) {
	return `input ${c.inputTokens}, output ${c.outputTokens}, cache read ${c.cacheReadTokens}, cache write ${c.cacheWriteTokens}`;
}

/**
 * The idempotency key of a SETTLE VEHICLE: the set of transcript messages one
 * authorize→settle carries, for one agent of one session. Derived from the message
 * ids alone, sorted — never from which hook or path carries them — so the same
 * usage can be charged at most once whatever retries it: usertrust posts every
 * keyed charge under one ledger anchor per key. The raw ids never leave the
 * machine; the server sees this hash.
 */
export function vehicleKey(sessionId, agentId, ids) {
	const digest = createHash("sha256")
		.update(JSON.stringify([String(sessionId), String(agentId), [...ids].sort()]))
		.digest("hex");
	return `cc:${digest.slice(0, 48)}`;
}

/** A value forced into a usertrust principal field (`[A-Za-z0-9._:-]{1,128}`). */
function principalField(value, fallback) {
	const text =
		typeof value === "string" ? value.replace(/[^A-Za-z0-9._:-]/g, ".").slice(0, 128) : "";
	return PRINCIPAL_FIELD.test(text) ? text : fallback;
}

/** The attribution fields a note was already written for, in this hook. */
const attributionNoted = new Set();

/**
 * The optional `unit` and `role` a principal carries, from UT_CC_UNIT /
 * UT_CC_ROLE (a config file's `unit` and `role`: config.mjs). Each is sent only as
 * it is, and only if it is a valid principal
 * field: a strict server refuses a principal with anything else — a 400, which is
 * a gap in watch mode and a BLOCK in enforce mode — so a value that is empty or
 * invalid is never sent, nor forced into shape (it would attribute the spend to a
 * name nobody chose). It is left out, with one note on stderr per hook.
 */
function principalAttribution() {
	const fields = {};
	const { unit, role } = settings();
	for (const [key, value] of [
		["unit", unit],
		["role", role],
	]) {
		if (value === undefined) continue;
		if (PRINCIPAL_FIELD.test(value)) {
			fields[key] = value;
		} else if (!attributionNoted.has(key)) {
			attributionNoted.add(key);
			const why =
				value === ""
					? "it is empty"
					: value.length > 128
						? `it is ${value.length} characters long`
						: "it has a character outside that set";
			say(
				`usertrust: ${settingName(key)} is not sent — a principal ${key} must be 1-128 characters of [A-Za-z0-9._:-], and ${why}`,
			);
		}
	}
	return fields;
}

/**
 * WHO spent, as usertrust records it on every record the hold leaves: the agent,
 * its type, the Claude Code session it ran in, and — when set and valid — the
 * organisational `unit` and `role` (`principalAttribution`). Unlike `actor` and
 * `params`, which stay on the request, a principal reaches the audit chain; it is
 * sent only to a server that advertises the `principal` capability.
 */
export function principalFor(sessionId, agentId, agentType) {
	return {
		id: principalField(agentId, "main"),
		type: principalField(agentType, "subagent"),
		origin: principalField(`claude-code:${sessionId}`, "claude-code"),
		...principalAttribution(),
	};
}

/**
 * The principal for an authorize on the ESTIMATE path, where no transcript (and
 * no subagent meta file) is read: the same shape as `principalFor`, with the type
 * taken the way `agentTypeFor` takes it without a meta file — `main` for the
 * parent, else the hook's own `agent_type` hint, else `subagent`.
 */
export function estimatePrincipalFor(sessionId, agentId, agentTypeHint) {
	const type =
		agentId === "main"
			? "main"
			: typeof agentTypeHint === "string" && agentTypeHint !== ""
				? agentTypeHint.slice(0, 128)
				: "subagent";
	return principalFor(sessionId, agentId, type);
}

/**
 * The authorize fields that size a hold for transcript `counts`, on top of a tool
 * call's own estimate (`toolInput` tokens in, `toolOutput` out). A hold below the
 * real cost would cap what its settle can post (a shortfall), and one far above it
 * can be refused near the budget — and a refused window is usage already spent,
 * marked denied. So:
 *  - a server that publishes `authorize-cache-tiers` (`capabilities`) prices each
 *    cache tier at its own rate, as settle does: the tiers go separately;
 *  - any other server prices every estimated input token at the higher of its
 *    input and cache-write rates, which covers each tier's price already (cache
 *    reads are the cheapest tier): the counts go in as one plain sum, never
 *    weighted again. A rate table whose cache-read rate tops both would be
 *    under-held there.
 */
export function holdEstimate(counts, capabilities, { toolInput = 0, toolOutput = 0 } = {}) {
	const maxOutputTokens = toolOutput + Math.max(1, counts.outputTokens);
	if (capabilities?.has(CACHE_TIERS)) {
		return {
			estimatedInputTokens: toolInput + counts.inputTokens,
			estimatedCacheReadTokens: counts.cacheReadTokens,
			estimatedCacheWriteTokens: counts.cacheWriteTokens,
			maxOutputTokens,
		};
	}
	return {
		estimatedInputTokens:
			toolInput + counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens,
		maxOutputTokens,
	};
}

function isAgentId(agentId) {
	return agentId === "main" || (typeof agentId === "string" && AGENT_ID.test(agentId));
}

/** The transcript file for one agent of a session, or undefined when there is none. */
export function transcriptPathFor(input, agentId) {
	const main = input.transcript_path;
	if (agentId === "main") return typeof main === "string" && main !== "" ? main : undefined;
	if (!isAgentId(agentId)) return undefined;
	const file = `agent-${agentId}.jsonl`;
	const hinted = input.agent_transcript_path;
	if (typeof hinted === "string" && basename(hinted) === file) return hinted;
	if (typeof main !== "string" || main === "") return undefined;
	return join(dirname(main), basename(main, ".jsonl"), "subagents", file);
}

/** Every subagent of the session with a transcript, as agent ids safe to use in a path. */
export async function subagentIds(input) {
	const main = input.transcript_path;
	if (typeof main !== "string" || main === "") return [];
	let names;
	try {
		names = await readdir(join(dirname(main), basename(main, ".jsonl"), "subagents"));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
		.map((name) => name.slice("agent-".length, -".jsonl".length))
		.filter((id) => AGENT_ID.test(id));
}

/**
 * `agentType` from the subagent's meta file, else the hook's, else "subagent":
 * `name` made safe for a path or an actor string, and `raw` for the principal
 * (which keeps characters such as `:` that a path cannot).
 */
async function agentTypeFor(transcriptPath, agentId, hinted) {
	if (agentId === "main") return { name: "main", raw: "main" };
	try {
		const meta = JSON.parse(
			await readFile(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf-8"),
		);
		if (typeof meta?.agentType === "string" && meta.agentType !== "") {
			return { name: safeName(meta.agentType, "subagent"), raw: meta.agentType.slice(0, 128) };
		}
	} catch {
		// No meta file — use the hint.
	}
	return {
		name: safeName(hinted, "subagent"),
		raw: typeof hinted === "string" && hinted !== "" ? hinted.slice(0, 128) : "subagent",
	};
}

/**
 * <state>/transcripts, created 0700 and verified: a real directory (not a
 * symlink), owned by this user, with no group/other write bit. Anything else
 * makes transcript accounting unavailable for this run.
 */
async function privateStateDir() {
	const dir = join(stateRoot(), "transcripts");
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const info = await lstat(dir);
		if (!info.isDirectory()) return { ok: false, reason: "state dir is not a directory" };
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
			return { ok: false, reason: "state dir is owned by another user" };
		}
		if ((info.mode & 0o022) !== 0) {
			return { ok: false, reason: "state dir is writable by group or others" };
		}
		return { ok: true, dir };
	} catch (err) {
		return { ok: false, reason: `state dir unavailable (${err?.code ?? "error"})` };
	}
}

function emptyCursor() {
	return {
		byteOffset: 0,
		nextSeq: 0,
		partial: new Map(),
		accounted: new Set(),
		denied: new Set(),
		assigned: new Map(),
		estimateMode: false,
		estimateReason: null,
		lastModel: null,
		unresolved: new Map(),
	};
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A v1 or v2 cursor, or null if any field is not what this code wrote. */
function parseCursor(raw) {
	if (!isObject(raw) || !READABLE_CURSOR_VERSIONS.has(raw.v)) return null;
	if (!Number.isSafeInteger(raw.byteOffset) || raw.byteOffset < 0) return null;
	if (!isObject(raw.partial) || !isObject(raw.assigned)) return null;
	if (!isStringArray(raw.accounted) || !isStringArray(raw.denied)) return null;
	if (typeof raw.estimateMode !== "boolean") return null;
	const cursor = emptyCursor();
	cursor.byteOffset = raw.byteOffset;
	for (const [id, m] of Object.entries(raw.partial)) {
		if (!isObject(m) || !Number.isSafeInteger(m.n)) return null;
		cursor.partial.set(id, {
			n: m.n,
			model: modelId(m.model) ?? UNKNOWN_MODEL,
			synthetic: m.synthetic === true,
			complete: m.complete === true,
			claimed: m.claimed === true,
			// When the message happened (epoch ms), or null when no entry said: the job
			// it belongs to is the one open at THAT time, never at settle time.
			ts: Number.isFinite(m.ts) ? m.ts : null,
			inputTokens: count(m.inputTokens),
			outputTokens: count(m.outputTokens),
			cacheReadTokens: count(m.cacheReadTokens),
			cacheWriteTokens: count(m.cacheWriteTokens),
		});
	}
	for (const [id, value] of Object.entries(raw.assigned)) {
		if (typeof value !== "string" || value === "") return null;
		cursor.assigned.set(id, value);
	}
	cursor.accounted = new Set(raw.accounted);
	cursor.denied = new Set(raw.denied);
	cursor.estimateMode = raw.estimateMode;
	cursor.estimateReason = typeof raw.estimateReason === "string" ? raw.estimateReason : null;
	cursor.lastModel = modelId(raw.lastModel);
	if (raw.v >= 2) {
		if (!isObject(raw.unresolved)) return null;
		for (const [key, v] of Object.entries(raw.unresolved)) {
			const vehicle = parseVehicle(key, v);
			if (vehicle === null) return null;
			cursor.unresolved.set(key, vehicle);
		}
	}
	const seqs = [...cursor.partial.values()].map((m) => m.n + 1);
	cursor.nextSeq = Math.max(Number.isSafeInteger(raw.nextSeq) ? raw.nextSeq : 0, 0, ...seqs);
	return cursor;
}

/**
 * An UNRESOLVED settle vehicle: its outcome is unknown (a settle that answered
 * 5xx, nothing, or `settled: false`), so it is retried as itself — the same key,
 * the same ids, the same counts — until the server says it posted (200, or 409
 * `already_settled`). Never folded into a new window or remainder: a different
 * set of ids is a different key, and would charge again what may have posted.
 */
function parseVehicle(key, v) {
	if (!VEHICLE_KEY.test(key) || !isObject(v) || !isStringArray(v.ids) || v.ids.length === 0) {
		return null;
	}
	const vehicle = {
		ids: v.ids,
		model: modelId(v.model) ?? UNKNOWN_MODEL,
		agentType: typeof v.agentType === "string" ? v.agentType : "subagent",
		// The server and key it was authorized under (lib.mjs `tenantBinding`), when
		// known: it is retried only through that server and key (`boundElsewhere`).
		...(typeof v.serverUrl === "string" && typeof v.keyHash === "string"
			? { serverUrl: v.serverUrl, keyHash: v.keyHash }
			: {}),
	};
	for (const k of COUNT_KEYS) vehicle[k] = count(v[k]);
	// The job labels the vehicle was first sent with: a retry is the SAME charge, so it
	// carries the same job, never the one open when the retry happens.
	const labels = jobHoldFields(v.labels);
	if (Object.keys(labels).length > 0) vehicle.labels = labels;
	return vehicle;
}

/**
 * The settle vehicle a hold file (or its journal record) describes: its key and
 * vehicle when it was authorized under a key, else null.
 */
function holdVehicle(body) {
	const key = body?.idempotencyKey;
	if (typeof key !== "string") return null;
	const vehicle = parseVehicle(key, {
		ids: body.assignedIds,
		model: body.holdModel,
		agentType: body.agentType,
		serverUrl: body.serverUrl,
		keyHash: body.keyHash,
		inputTokens: body.inputTokens,
		outputTokens: body.outputTokens,
		cacheReadTokens: body.cacheReadTokens,
		cacheWriteTokens: body.cacheWriteTokens,
		labels: body,
	});
	return vehicle === null ? null : { key, vehicle };
}

/** Every id an unresolved vehicle carries: those are retried as that vehicle only. */
function unresolvedIds(cursor) {
	const ids = new Set();
	for (const vehicle of cursor.unresolved.values()) for (const id of vehicle.ids) ids.add(id);
	return ids;
}

/**
 * Only a MISSING cursor starts empty. One that exists but cannot be read or
 * parsed is reported, never treated as empty: an empty cursor would re-post
 * every message it had accounted.
 */
async function readCursor(path) {
	let text;
	try {
		text = await readFile(path, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return { ok: true, cursor: emptyCursor() };
		return { ok: false, reason: `transcript cursor unreadable (${err?.code ?? "error"})` };
	}
	let cursor = null;
	try {
		cursor = parseCursor(JSON.parse(text));
	} catch {
		cursor = null;
	}
	if (cursor === null) return { ok: false, reason: "transcript cursor is corrupt" };
	return { ok: true, cursor };
}

async function writeAtomic(path, text) {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(tmp, text, { mode: 0o600 });
	await rename(tmp, path);
}

async function writeCursor(path, cursor) {
	await writeAtomic(
		path,
		JSON.stringify({
			v: CURSOR_VERSION,
			byteOffset: cursor.byteOffset,
			nextSeq: cursor.nextSeq,
			partial: Object.fromEntries(cursor.partial),
			accounted: [...cursor.accounted].slice(-ID_HISTORY),
			denied: [...cursor.denied].slice(-ID_HISTORY),
			assigned: Object.fromEntries(cursor.assigned),
			estimateMode: cursor.estimateMode,
			estimateReason: cursor.estimateReason,
			lastModel: cursor.lastModel,
			unresolved: Object.fromEntries(cursor.unresolved),
		}),
	);
}

function accountIds(cursor, ids) {
	for (const id of ids) {
		cursor.assigned.delete(id);
		cursor.partial.delete(id);
		cursor.accounted.add(id);
	}
}

function releaseIds(cursor, ids) {
	for (const id of ids) {
		cursor.assigned.delete(id);
	}
}

function denyIds(cursor, ids) {
	for (const id of ids) {
		cursor.assigned.delete(id);
		cursor.partial.delete(id);
		cursor.denied.add(id);
	}
}

/**
 * Exclusive per-(session, agent) lock: an atomic mkdir holding an ownership
 * token. A lock older than STALE_LOCK_MS belongs to a crashed holder and is
 * reclaimed (`replaceStaleLock`); a lock is released only by the holder whose
 * token is still inside. Any failure reads as busy. Returns a release fn or null.
 */
async function acquireLock(path, { waitMs = 0 } = {}) {
	const lock = `${path}.lock`;
	const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
	const until = Date.now() + waitMs;
	for (;;) {
		if (await tryLock(lock, token)) {
			return async () => {
				try {
					if ((await readFile(join(lock, "owner"), "utf-8")) === token) {
						await rm(lock, { recursive: true, force: true });
					}
				} catch {
					// Already gone, or no longer ours.
				}
			};
		}
		if (Date.now() >= until) return null;
		await sleep(25);
	}
}

async function tryLock(lock, token) {
	try {
		await mkdir(lock);
	} catch (err) {
		if (err?.code !== "EEXIST") return false;
		try {
			if (Date.now() - (await stat(lock)).mtimeMs < STALE_LOCK_MS) return false;
			return await replaceStaleLock(lock, token, await lockOwner(lock));
		} catch {
			return false;
		}
	}
	return writeOwner(lock, token);
}

/** The token inside a lock; "" when it has none (its holder died before writing it). */
async function lockOwner(lock) {
	try {
		return await readFile(join(lock, "owner"), "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return "";
		throw err;
	}
}

async function writeOwner(lock, token) {
	try {
		await writeFile(join(lock, "owner"), token, { flag: "wx", mode: 0o600 });
		return true;
	} catch {
		// Never removed here: the directory may no longer be the one this call made.
		// An ownerless lock goes stale and is reclaimed.
		return false;
	}
}

/**
 * Take over a STALE lock — one judged stale while it named `observed` as its owner
 * — and ONLY that lock. Two rules close the reclaim race:
 *  - one reclaimer per stale owner: a mutex file named by that owner's token,
 *    created exclusively, so no two reclaimers remove-and-recreate at once;
 *  - remove only what was judged: the lock must still name `observed`, and still
 *    be stale. A lock another reclaimer already replaced names its new holder,
 *    and is left alone.
 * Exported for tests.
 */
export async function replaceStaleLock(lock, token, observed) {
	const mutex = `${lock}.reclaim.${createHash("sha256").update(observed).digest("hex").slice(0, 16)}`;
	try {
		await writeFile(mutex, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		// Another reclaimer holds it — or died holding it: a stale mutex is cleared
		// for the next attempt.
		if (err?.code === "EEXIST") {
			const age = await stat(mutex).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0,
			);
			if (age > STALE_LOCK_MS) await unlink(mutex).catch(() => {});
		}
		return false;
	}
	try {
		if ((await lockOwner(lock)) !== observed) return false;
		if (Date.now() - (await stat(lock)).mtimeMs < STALE_LOCK_MS) return false;
		await rm(lock, { recursive: true, force: true });
		await mkdir(lock);
		return await writeOwner(lock, token);
	} catch {
		return false;
	} finally {
		await unlink(mutex).catch(() => {});
	}
}

/**
 * Every hold file of one agent that carries assigned ids: live (`.json`),
 * in flight (`.settling`) and finished (`.done`, with the outcome).
 */
async function holdJournal(sessionId, agentId) {
	const root = stateRoot();
	const prefix = `${sanitize(sessionId)}__`;
	const want = sanitize(agentId);
	let names;
	try {
		names = await readdir(root);
	} catch {
		return [];
	}
	const records = [];
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const kind = name.endsWith(".json")
			? "live"
			: name.endsWith(".settling")
				? "settling"
				: name.endsWith(".done")
					? "done"
					: null;
		if (kind === null) continue;
		const path = join(root, name);
		try {
			const body = JSON.parse(await readFile(path, "utf-8"));
			if (sanitize(body?.agentId ?? "main") !== want) continue;
			const ids = isStringArray(body.assignedIds) ? body.assignedIds : [];
			if (ids.length === 0 && kind === "live") continue;
			const { mtimeMs } = await stat(path);
			records.push({
				kind,
				path,
				ids,
				outcome: body.outcome,
				keyed: holdVehicle(body),
				mtimeMs,
				estimate: body.usage !== "transcript",
				agentId: sanitize(body.agentId ?? "main"),
				...jobHoldFields(body),
				...(typeof body.startedAt === "string" ? { startedAt: body.startedAt } : {}),
			});
		} catch {
			// Corrupt or concurrently removed — skip.
		}
	}
	return records;
}

/**
 * Bring the cursor up to date with the hold journal. Returns the ids held by
 * live or in-flight holds (never part of a new window or the remainder) and the
 * finished-hold files to delete once the cursor is written.
 */
async function reconcile(cursor, sessionId, agentId) {
	const live = new Set();
	const finished = [];
	const now = Date.now();
	for (const record of await holdJournal(sessionId, agentId)) {
		if (record.kind === "done") {
			if (record.outcome === "released") releaseIds(cursor, record.ids);
			else if (record.outcome === "unresolved") holdUnresolved(cursor, record);
			else accountIds(cursor, record.ids);
			finished.push(record.path);
		} else if (record.kind === "settling" && now - record.mtimeMs > STALE_SETTLING_MS) {
			// Its hook died mid-settle: the outcome is unknown. An ESTIMATE hold's
			// .settling lands here too, with no ids: fresh, it adds nothing to `live`;
			// stale, its hold is past the ledger's pending timeout (STALE_SETTLING_MS), so
			// clearing the file is all there is left to do.
			holdUnresolved(cursor, record);
			// An ESTIMATE hold left `.settling` this long is a call that RAN whose charge was never
			// confirmed. Clearing the file would also clear the only trace of it: write the gap first.
			if (record.estimate && record.ids.length === 0) {
				await recordUnconfirmedCall(sessionId, record, "call-ran");
			}
			finished.push(record.path);
		} else {
			for (const id of record.ids) live.add(id);
		}
	}
	for (const [id] of cursor.assigned) {
		// A binding — AUTHORIZING, REMAINDER, or a hold — whose outcome nothing
		// recorded: its hold is gone and no journal names it. A crash after a settle
		// went out looks exactly like this, so it may have posted: at most once, its
		// ids are never posted again.
		if (!live.has(id)) accountIds(cursor, [id]);
	}
	return { live, finished };
}

/**
 * A hold whose settle may or may not have posted. Authorized under a key, it
 * becomes an UNRESOLVED vehicle, retried as itself until the server answers (the
 * key's anchor makes a second charge impossible). Without a key a retry could post
 * it twice, so its ids stay claimed: accounted, never retried.
 */
function holdUnresolved(cursor, record) {
	if (record.keyed === null) accountIds(cursor, record.ids);
	else keepUnresolved(cursor, record.keyed.key, record.keyed.vehicle);
}

/** Park a vehicle as unresolved: assigned to no hold, and kept out of every new window. */
function keepUnresolved(cursor, key, vehicle) {
	releaseIds(cursor, vehicle.ids);
	cursor.unresolved.set(key, vehicle);
}

async function removeFiles(paths) {
	for (const path of paths.splice(0)) await unlink(path).catch(() => {});
}

/**
 * Read the transcript on from the cursor's byte offset, a chunk at a time, and
 * fold each complete line into `cursor.partial` (`foldLine`). The offset only
 * ever moves past a complete line, so a line still being written is read whole
 * next time; a file shorter than the offset is read again from 0. Memory holds
 * one chunk and one line: a line over MAX_LINE_BYTES is skipped unread
 * (`longLines`). A call stops at the first line end MAX_READ_BYTES past where it
 * started — the next settle point reads on. Only an I/O failure is "unreadable".
 */
async function ingest(cursor, path, since) {
	let handle;
	try {
		handle = await open(path, "r");
	} catch (err) {
		return { ok: false, reason: `transcript unreadable (${err?.code ?? "error"})` };
	}
	const result = { ok: true, badLines: 0, longLines: 0 };
	try {
		const { size } = await handle.stat();
		if (size < cursor.byteOffset) cursor.byteOffset = 0; // truncated or replaced: start over
		const start = cursor.byteOffset;
		const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - start));
		let position = start;
		let line = []; // the line so far, as copies: `chunk` is reused
		let lineBytes = 0;
		let skipping = false; // the line is over MAX_LINE_BYTES
		while (position < size && cursor.byteOffset - start < MAX_READ_BYTES) {
			const want = Math.min(chunk.length, size - position);
			const { bytesRead } = await handle.read(chunk, 0, want, position);
			if (bytesRead === 0) break;
			const view = chunk.subarray(0, bytesRead);
			let from = 0;
			for (let end = view.indexOf(0x0a); end !== -1; end = view.indexOf(0x0a, from)) {
				const tail = view.subarray(from, end);
				if (skipping) result.longLines += 1;
				else if (
					!foldLine(cursor, line.length === 0 ? tail : Buffer.concat([...line, tail]), since)
				) {
					result.badLines += 1;
				}
				line = [];
				lineBytes = 0;
				skipping = false;
				from = end + 1;
				cursor.byteOffset = position + from;
				if (cursor.byteOffset - start >= MAX_READ_BYTES) break;
			}
			position += bytesRead;
			lineBytes += bytesRead - from;
			if (lineBytes > MAX_LINE_BYTES) {
				skipping = true;
				line = [];
			} else if (from < bytesRead) {
				line.push(Buffer.from(view.subarray(from)));
			}
		}
	} catch (err) {
		return { ok: false, reason: `transcript unreadable (${err?.code ?? "error"})` };
	} finally {
		await handle.close().catch(() => {});
	}
	return result;
}

/**
 * Fold one transcript line into `cursor.partial`: per message id, the per-field
 * max of its entries' counts, and the first model an entry names (over a
 * placeholder) — skipping an entry written before `since`. False when the line is
 * not JSON.
 */
function foldLine(cursor, bytes, since) {
	if (!bytes.includes(USAGE_FIELD)) return true;
	let entry;
	try {
		entry = JSON.parse(bytes.toString("utf-8"));
	} catch {
		return false;
	}
	// Written before this plugin's state was first made: never posted (`firstRun`).
	if (Date.parse(entry?.timestamp) < since) return true;
	const message = entry?.message;
	const usage = message?.usage;
	const id = message?.id;
	if (typeof id !== "string" || id === "" || id.length > MAX_ID_CHARS) return true;
	if (!isObject(usage)) return true;
	if (cursor.accounted.has(id) || cursor.denied.has(id)) return true;
	const model = modelId(message.model);
	// A model that generated tokens, not the placeholder.
	const named = model !== null && model !== SYNTHETIC_MODEL;
	let m = cursor.partial.get(id);
	if (m === undefined) {
		m = {
			n: cursor.nextSeq,
			model: model ?? UNKNOWN_MODEL,
			synthetic: model === SYNTHETIC_MODEL,
			complete: false,
			claimed: false,
			ts: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		cursor.nextSeq += 1;
		cursor.partial.set(id, m);
	} else if (named && (m.synthetic || m.model === UNKNOWN_MODEL)) {
		// First seen as a placeholder (`<synthetic>`, or no model): its usage is
		// the named model's, and is priced as that model's.
		m.model = model;
		m.synthetic = false;
	}
	// The EARLIEST entry's time: one API response is written as several entries, and
	// min is idempotent however many are re-read.
	const at = Date.parse(entry?.timestamp);
	if (Number.isFinite(at) && (m.ts === null || at < m.ts)) m.ts = at;
	m.inputTokens = Math.max(m.inputTokens, count(usage.input_tokens));
	m.outputTokens = Math.max(m.outputTokens, count(usage.output_tokens));
	m.cacheReadTokens = Math.max(m.cacheReadTokens, count(usage.cache_read_input_tokens));
	m.cacheWriteTokens = Math.max(m.cacheWriteTokens, count(usage.cache_creation_input_tokens));
	if (message.stop_reason != null) m.complete = true;
	if (named) cursor.lastModel = model;
	return true;
}

/**
 * The agent's NEW complete messages — not accounted, assigned, denied, or held
 * by a live hold — oldest first. A `<synthetic>` placeholder whose usage is all
 * zero is accounted on the spot: it was never billed.
 */
function selectNew(cursor, live) {
	const fresh = [];
	const free = [];
	const retried = unresolvedIds(cursor);
	for (const [id, m] of cursor.partial) {
		if (!m.complete || cursor.assigned.has(id) || live.has(id) || retried.has(id)) continue;
		const total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
		if (m.synthetic && total === 0) free.push(id);
		else fresh.push({ id, ...m });
	}
	accountIds(cursor, free);
	return fresh.sort((a, b) => a.n - b.n);
}

/**
 * THE CHOKE POINT: the new messages THIS agent may post. Every post path takes its
 * messages from here — a window (`prepareWindow`) and a remainder (`postRemainder`)
 * — so "a message is settled at most once" is decided here and nowhere else. (Both
 * reach it through `openAgent`, which turns away an agent whose estimate mode is
 * recorded: its usage is never posted.)
 *
 * A message is this agent's to post only under a CLAIM this cursor made and
 * recorded (`claimed`): a file per message id (named by its SHA-256), published
 * exclusively — link(2), which never replaces a name — BEFORE anything can post
 * it. A claim that ALREADY exists is never posted again, whoever made it:
 *  - another agent (a fork's copy of its ancestor's messages): posted there, and
 *    accounted here;
 *  - this agent, with no record of it in this cursor — a cursor since removed or
 *    reset, a hook killed between claiming and saving, or a message re-read after
 *    its id left the cursor's history: posted then, or written off with a note.
 * Nothing about such a claim can say whether it was posted, so it never is again:
 * the worst a lost record does is under-count. An id whose claim cannot be made or
 * read, or that the hook's time no longer covers, is left for a later settle
 * point, never posted unverified.
 */
async function selectOwn(opened) {
	const { cursor } = opened;
	const fresh = selectNew(cursor, opened.live);
	const own = [];
	const failed = new Map();
	let deferred = 0;
	let writtenOff = 0;
	for (const m of fresh) {
		if (m.claimed) {
			own.push(m);
			continue;
		}
		// Each claim is file I/O: never let them eat the time the calls need.
		if (timeLeft() < claimFloor()) {
			deferred += 1;
			continue;
		}
		const claim = await claimHolder(opened.claimsDir, m.id, opened.owner);
		if (claim.created) {
			const state = cursor.partial.get(m.id);
			if (state !== undefined) state.claimed = true;
			own.push(m);
		} else if (claim.holder === opened.owner) {
			accountIds(cursor, [m.id]);
			writtenOff += 1;
		} else if (claim.holder !== null) {
			accountIds(cursor, [m.id]);
		} else {
			failed.set(claim.code, (failed.get(claim.code) ?? 0) + 1);
		}
	}
	if (failed.size > 0) {
		const total = [...failed.values()].reduce((sum, n) => sum + n, 0);
		const codes = [...failed.keys()].join(", ");
		say(
			`usertrust: ${total} transcript message(s) could not be claimed (${codes}) — NOT posted; tried again at the next settle point`,
		);
	}
	if (deferred > 0) {
		say(
			`usertrust: ${deferred} transcript message(s) not claimed this time (out of time) — posted at a later settle point`,
		);
	}
	if (writtenOff > 0) {
		say(
			`usertrust: ${writtenOff} transcript message(s) were claimed by this agent before its cursor was removed or reset, or by a hook that died before saving — not posted again (any of them not yet posted is written off)`,
		);
	}
	return own;
}

/**
 * The claim on a message id: `{ holder, created }` — `created` when this call made
 * it — or `{ holder: null, code }` when it can be neither made nor read. Published
 * by link(2), which never replaces an existing name, so a claim is whole the moment
 * it exists; on a filesystem without hard links, by an exclusive create.
 */
async function claimHolder(claimsDir, id, owner) {
	const digest = createHash("sha256").update(id).digest("hex");
	const dir = join(claimsDir, digest.slice(0, 2));
	const path = join(dir, digest.slice(2));
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(tmp, owner, { mode: 0o600 });
		await link(tmp, path);
		return { holder: owner, created: true };
	} catch (err) {
		if (LINKLESS.has(err?.code)) {
			try {
				await writeFile(path, owner, { flag: "wx", mode: 0o600 });
				return { holder: owner, created: true };
			} catch (exclusive) {
				if (exclusive?.code !== "EEXIST") return { holder: null, code: exclusive?.code ?? "error" };
			}
		} else if (err?.code !== "EEXIST") {
			return { holder: null, code: err?.code ?? "error" };
		}
	} finally {
		await unlink(tmp).catch(() => {});
	}
	try {
		const holder = await readFile(path, "utf-8");
		return holder === "" ? { holder: null, code: "EMPTY" } : { holder, created: false };
	} catch (err) {
		return { holder: null, code: err?.code ?? "error" };
	}
}

/**
 * Where an agent's transcript, cursor, claims and estimate marker live, or why it
 * has none this run. With an agent id unsafe in a path, no transcript of the agent
 * is ever read: its estimate is its only record. `unavailable`: the state dir
 * cannot be used now. A hook that reads no transcript — under UT_CC_USAGE=estimate,
 * or naming none — gets `transcriptPath: undefined` and the reason in `unread`
 * when it `mayEstimate`, so its estimate is recorded before it settles (see
 * `openAgent`); one that does not is turned away before the state dir is touched.
 */
async function locate({ sessionId, agentId, input, mayEstimate }) {
	const configured = usageMode() === "estimate";
	// The user's own setting, as this session spells it: UT_CC_USAGE=estimate, or the config file's.
	const bySetting = howToSet("usage", "estimate");
	if (configured && !mayEstimate) return { ok: false, reason: bySetting };
	if (!isAgentId(agentId)) return { ok: false, reason: "agent id is not safe in a path" };
	const transcriptPath = configured ? undefined : transcriptPathFor(input, agentId);
	if (transcriptPath === undefined && !mayEstimate) {
		return { ok: false, reason: "no transcript path" };
	}
	const where = await cursorLocation(sessionId, agentId);
	if (!where.ok) return where;
	return {
		...where,
		transcriptPath,
		unread: configured ? bySetting : "no transcript path",
	};
}

/**
 * A SUBAGENT inherits the estimate mode of any agent of its session: a forked
 * subagent's transcript begins with a copy of its ancestor's responses, and an
 * agent in estimate mode never claims its responses, so the fork would post them
 * — usage its ancestor already settled at the estimate. Which agent a fork copied
 * is not recorded anywhere, so every subagent of such a session settles at the
 * estimate too. The parent ("main") copies no one: it inherits nothing. Returns why,
 * or null; a marker dir that cannot be read throws.
 */
async function inheritedEstimate(where, agentId) {
	if (agentId === "main") return null;
	const dir = dirname(where.estimatePath);
	const own = basename(where.estimatePath);
	const prefix = own.slice(0, own.length - agentId.length);
	let names;
	try {
		names = await readdir(dir);
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
	const other = names.find((name) => name !== own && name.startsWith(prefix));
	return other === undefined
		? null
		: `${other.slice(prefix.length)} of this session settles at the estimate (a fork copies its ancestor's responses)`;
}

/** The agent's cursor, its estimate marker and the message claims, in the private state dir. */
async function cursorLocation(sessionId, agentId) {
	if (!isAgentId(agentId)) return { ok: false, reason: "agent id is not safe in a path" };
	const dir = await privateStateDir();
	if (!dir.ok) return { ok: false, reason: dir.reason, unavailable: true };
	let since;
	try {
		since = await firstRun(dir.dir);
	} catch (err) {
		return {
			ok: false,
			reason: `first-run time unreadable (${err?.code ?? errText(err)})`,
			unavailable: true,
		};
	}
	const name = `${sanitize(sessionId)}__${agentId}`;
	return {
		ok: true,
		cursorPath: join(dir.dir, `${name}.json`),
		claimsDir: join(dir.dir, CLAIMS_DIR),
		estimatePath: join(dir.dir, ESTIMATE_DIR, name),
		since,
	};
}

/**
 * When this plugin's transcript state was first made, in ms: published once, whole
 * (`publishOnce`), and never moved. A transcript entry written before it is never
 * posted: usage from before this state existed — a session resumed after an upgrade
 * from the estimate plugin, or after the state dir was deleted and remade — may have
 * been settled another way, and at most once means an under-count there. An entry
 * with no readable timestamp counts as after it. One that cannot be read leaves the
 * state unavailable: nothing is posted, and nothing settled at the estimate.
 */
async function firstRun(dir) {
	const path = join(dir, SINCE_FILE);
	const read = () =>
		readFile(path, "utf-8").catch((err) => {
			if (err?.code === "ENOENT") return null;
			throw err;
		});
	let text = await read();
	if (text === null) {
		await publishOnce(path, new Date().toISOString());
		text = await read();
	}
	const at = Date.parse(text ?? "");
	if (!Number.isFinite(at)) throw new Error("not a time");
	return at;
}

/**
 * Publish `content` at `path` unless something is there already: by link(2), which
 * never replaces a name, so it is whole the moment it exists — on a filesystem
 * without hard links, by an exclusive create.
 */
async function publishOnce(path, content) {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, content, { mode: 0o600 });
		await link(tmp, path);
	} catch (err) {
		if (err?.code === "EEXIST") return;
		if (!LINKLESS.has(err?.code)) throw err;
		await writeFile(path, content, { flag: "wx", mode: 0o600 }).catch((exclusive) => {
			if (exclusive?.code !== "EEXIST") throw exclusive;
		});
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

/**
 * Why an agent's estimate mode is recorded, or null when it is not. A marker that
 * cannot be read throws: an agent that may be in estimate mode posts nothing.
 */
async function estimateMarker(path) {
	try {
		const text = await readFile(path, "utf-8");
		return text === "" ? "estimate mode" : text;
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
}

/**
 * Make an agent's estimate mode DURABLE — a marker outside its cursor, so losing
 * the cursor cannot undo it — BEFORE any of its holds settles at the estimate: a
 * period settled at an estimate must never have its real usage posted as well.
 * From then on `openAgent` turns the agent away from every post path. It is
 * recorded while holding the agent's lock, as every post is made, so no hook posts
 * while it is being recorded — except to back-fill a cursor that already records
 * estimate mode, whose agent posts nothing anyway. A marker that cannot be written
 * leaves the agent `unavailable`: the hold is given back, never settled at the
 * estimate.
 */
async function stickToEstimate(where, reason, announce) {
	const unrecorded = (code) => ({
		kind: "unavailable",
		reason: `${reason}, and estimate mode could not be recorded (${code})`,
	});
	try {
		await mkdir(dirname(where.estimatePath), { recursive: true, mode: 0o700 });
		await writeFile(where.estimatePath, reason, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if (err?.code !== "EEXIST") return unrecorded(err?.code ?? errText(err));
		// Recorded already, by a hook that got here first — if it reads back.
		const recorded = await estimateMarker(where.estimatePath).catch(() => null);
		return recorded === null ? unrecorded("EEXIST") : { kind: "estimate", reason: recorded };
	}
	return { kind: "estimate", reason, becameSticky: announce };
}

/** Why an agent's hold settles at the estimate, for PostToolUse's note; null when unknown. */
export async function estimateReasonFor({ sessionId, agentId, input }) {
	if (usageMode() === "estimate") return howToSet("usage", "estimate");
	if (!isAgentId(agentId)) return "agent id is not safe in a path";
	const marker = join(
		stateRoot(),
		"transcripts",
		ESTIMATE_DIR,
		`${sanitize(sessionId)}__${agentId}`,
	);
	const recorded = await estimateMarker(marker).catch(() => null);
	if (recorded !== null) return recorded;
	return transcriptPathFor(input, agentId) === undefined ? "no transcript path" : null;
}

/**
 * Open an agent's transcript state: lock, cursor, journal reconcile, then an
 * incremental read. Returns one of:
 *  - `{ kind: "estimate", reason }`: the agent's usage is settled at the
 *    estimate, and nothing of its transcript is ever posted: see `locate`, or its
 *    recorded estimate mode (`stickToEstimate`: UT_CC_USAGE=estimate, its
 *    transcript could not be read, a hook that `mayEstimate` named none, or one it
 *    inherited, `inheritedEstimate`);
 *  - `{ kind: "unavailable", reason }`: its transcript state cannot be used NOW
 *    (the state dir, a corrupt cursor, an error). Nothing is posted, and nothing
 *    may be settled at the estimate either: the transcript still holds that
 *    usage, and the first settle point that can use the state posts it;
 *  - `{ kind: "busy", lastModel }`, or `{ kind: "ready", ... }` holding the lock.
 */
async function openAgent({ sessionId, agentId, input, waitMs = 0, mayEstimate = false }) {
	const where = await locate({ sessionId, agentId, input, mayEstimate });
	if (!where.ok) {
		return { kind: where.unavailable ? "unavailable" : "estimate", reason: where.reason };
	}
	let recorded;
	try {
		recorded = await estimateMarker(where.estimatePath);
	} catch (err) {
		return { kind: "unavailable", reason: `estimate marker unreadable (${err?.code ?? "error"})` };
	}
	if (recorded !== null) return { kind: "estimate", reason: recorded };
	let inherited;
	try {
		inherited = await inheritedEstimate(where, agentId);
	} catch (err) {
		return { kind: "unavailable", reason: `estimate markers unreadable (${err?.code ?? "error"})` };
	}
	const { cursorPath, transcriptPath } = where;
	// Nothing of this agent is read now (UT_CC_USAGE=estimate, no transcript path),
	// or its session's estimate mode is its own (`inheritedEstimate`), and a hold
	// may settle at the estimate: recorded first, so no later hook posts the same
	// usage for real.
	if (transcriptPath === undefined || inherited !== null) {
		const reason = inherited ?? where.unread;
		const held = await acquireLock(cursorPath, { waitMs: Math.max(waitMs, NO_PATH_LOCK_WAIT_MS) });
		if (held === null) {
			return { kind: "unavailable", reason: `${reason}, and another hook holds the agent's lock` };
		}
		try {
			// UT_CC_USAGE=estimate (or the config file's) is the user's own setting: nothing to announce.
			return await stickToEstimate(where, reason, reason !== howToSet("usage", "estimate"));
		} finally {
			await held();
		}
	}
	const release = await acquireLock(cursorPath, { waitMs });
	if (release === null) {
		const peek = await readCursor(cursorPath);
		if (!peek.ok) return { kind: "unavailable", reason: peek.reason };
		if (peek.cursor.estimateMode) {
			// A cursor from before the marker: record it now.
			return stickToEstimate(where, peek.cursor.estimateReason ?? "transcript unreadable", false);
		}
		return { kind: "busy", lastModel: peek.cursor.lastModel, transcriptPath };
	}
	try {
		// Again under the lock: a hook that recorded estimate mode since the check
		// above did so holding it (`stickToEstimate`), so it is done.
		const marked = await estimateMarker(where.estimatePath);
		if (marked !== null) {
			await release();
			return { kind: "estimate", reason: marked };
		}
		const inheritedNow = await inheritedEstimate(where, agentId);
		if (inheritedNow !== null) {
			const sticky = await stickToEstimate(where, inheritedNow, true);
			await release();
			return sticky;
		}
		const read = await readCursor(cursorPath);
		if (!read.ok) {
			// Post nothing, and leave the cursor exactly as it is.
			await release();
			return { kind: "unavailable", reason: read.reason };
		}
		const { cursor } = read;
		if (cursor.estimateMode) {
			await release();
			return stickToEstimate(where, cursor.estimateReason ?? "transcript unreadable", false);
		}
		const { live, finished } = await reconcile(cursor, sessionId, agentId);
		const ingested = await ingest(cursor, transcriptPath, where.since);
		if (!ingested.ok) {
			const sticky = await stickToEstimate(where, ingested.reason, true);
			if (sticky.kind === "estimate") {
				cursor.estimateMode = true;
				cursor.estimateReason = ingested.reason;
				await writeCursor(cursorPath, cursor);
				await removeFiles(finished);
			}
			await release();
			return sticky;
		}
		if (ingested.badLines > 0) {
			say(`usertrust: skipped ${ingested.badLines} unparseable transcript line(s)`);
		}
		if (ingested.longLines > 0) {
			say(
				`usertrust: skipped ${ingested.longLines} transcript line(s) over ${MAX_LINE_BYTES >> 20} MiB, unread`,
			);
		}
		return {
			kind: "ready",
			cursor,
			live,
			transcriptPath,
			claimsDir: where.claimsDir,
			owner: `${sanitize(sessionId)}/${agentId}`,
			release,
			async save() {
				await writeCursor(cursorPath, cursor);
				await removeFiles(finished);
			},
		};
	} catch (err) {
		await release();
		return { kind: "unavailable", reason: `transcript state unavailable (${errText(err)})` };
	}
}

/**
 * Apply journalled hold outcomes to one agent's cursor, if its lock is free soon, and
 * return the hold files this reconcile finished and removed (none when it could not
 * run). PreToolUse runs it before it decides what a `.settling` record of the same
 * tool call still blocks: the journal decides a stale one (`STALE_SETTLING_MS`) and
 * removes its file. Under the agent's lock, only one reconcile can remove a given
 * file, so the hook whose reconcile removed it is the one that may reserve afresh.
 */
export async function reconcileAgent(sessionId, agentId) {
	const where = await cursorLocation(sessionId, agentId);
	if (!where.ok) return [];
	const release = await acquireLock(where.cursorPath, { waitMs: 300 });
	if (release === null) return []; // the next lock holder reconciles
	try {
		const read = await readCursor(where.cursorPath);
		if (!read.ok) return [];
		const { finished } = await reconcile(read.cursor, sessionId, agentId);
		await writeCursor(where.cursorPath, read.cursor);
		const removed = [...finished];
		await removeFiles(finished);
		return removed;
	} catch {
		return []; // Left for the next lock holder.
	} finally {
		await release();
	}
}

/**
 * Pick this tool call's window and mark it "authorizing" BEFORE the authorize.
 * Returns `{ mode: "estimate" | "unavailable", reason, becameSticky }` (see
 * `openAgent`) or `{ mode: "transcript",
 * window: null | { model, ids, counts }, key, agentType, agentTypeRaw, principal,
 * lastModel, commit, settledElsewhere, abandon, release }`. With the lock busy,
 * the window is empty. `key` is the window's vehicle key (null without a window);
 * `agentType` is safe for an actor string, `agentTypeRaw` is what a principal is
 * built from, and `principal` is what the server may record.
 */
export async function prepareWindow({
	sessionId,
	agentId,
	agentTypeHint,
	input,
	jobs = null,
	holdKey = "none",
}) {
	const opened = await openAgent({ sessionId, agentId, input, mayEstimate: true });
	if (opened.kind === "estimate" || opened.kind === "unavailable") {
		return { mode: opened.kind, reason: opened.reason, becameSticky: opened.becameSticky === true };
	}
	const none = async () => {};
	const empty = (lastModel, agentType) => ({
		mode: "transcript",
		window: null,
		key: null,
		agentType: agentType.name,
		agentTypeRaw: agentType.raw,
		principal: principalFor(sessionId, agentId, agentType.raw),
		lastModel,
		commit: none,
		settledElsewhere: none,
		abandon: none,
		release: none,
	});
	if (opened.kind === "busy") {
		return empty(
			opened.lastModel,
			await agentTypeFor(opened.transcriptPath, agentId, agentTypeHint),
		);
	}
	const { cursor } = opened;
	const agentType = await agentTypeFor(opened.transcriptPath, agentId, agentTypeHint);
	let window = null;
	try {
		const fresh = await selectOwn(opened);
		// With the `job` capability the hold has ONE job (the one open at this call), and
		// only messages that happened under that job may ride it: a message from before a
		// switch stays unassigned and is posted by a remainder under ITS job. The hold is
		// never settled with a job it was not authorized with.
		const eligible =
			jobs === null ? fresh : fresh.filter((m) => labelsFor(jobs, m.ts).key === holdKey);
		if (eligible.length > 0) {
			const model = eligible[0].model;
			const messages = eligible.filter((m) => m.model === model);
			for (const m of messages) cursor.assigned.set(m.id, AUTHORIZING);
			window = {
				model,
				ids: messages.map((m) => m.id),
				counts: sumCounts(messages),
				...usageSpan(messages),
			};
		}
		await opened.save();
	} catch (err) {
		await opened.release();
		say(`usertrust: transcript window skipped — ${errText(err)}`);
		return empty(cursor.lastModel, agentType);
	}
	let decided = false;
	const key = window === null ? null : vehicleKey(sessionId, agentId, window.ids);
	return {
		mode: "transcript",
		window,
		key,
		agentType: agentType.name,
		agentTypeRaw: agentType.raw,
		principal: principalFor(sessionId, agentId, agentType.raw),
		lastModel: cursor.lastModel,
		async commit(transferId) {
			if (window === null || decided) return;
			decided = true;
			for (const id of window.ids) cursor.assigned.set(id, transferId);
			// If this write fails the pending file still names the ids, and the
			// journal keeps them out of every other window until the hold ends.
			await opened.save().catch((err) => {
				say(`usertrust: cursor not updated — ${errText(err)}`);
			});
		},
		async settledElsewhere() {
			// The server answered `already_settled` for the window's key: an earlier
			// settle of exactly these messages landed, though this cursor never heard.
			// If this write fails they stay "authorizing", a binding with no recorded
			// outcome, which the next lock holder writes off all the same.
			if (window === null || decided) return;
			decided = true;
			accountIds(cursor, window.ids);
			await opened.save().catch((err) => {
				say(`usertrust: cursor not updated — ${errText(err)}`);
			});
		},
		async abandon() {
			// Once committed the ids belong to a recorded hold: never release them.
			if (window === null || decided) return;
			decided = true;
			releaseIds(cursor, window.ids);
			await opened.save().catch((err) => {
				say(`usertrust: cursor not updated — ${errText(err)}`);
			});
		},
		release: opened.release,
	};
}

/** Give a hold back after a settle that failed: the server re-queues such a hold. */
/** Give a hold back for hygiene; say whether the server confirmed it is gone. */
async function hygieneRelease(transferId, why) {
	const timeoutMs = callTimeout();
	if (timeoutMs < minCall()) return false;
	try {
		const response = await releaseHold(transferId, why, { timeoutMs });
		return response.status === 200 || isUnknownTransfer(response);
	} catch {
		// The server's pending-TTL sweep releases it.
		return false;
	}
}

/**
 * Settle a hold at `counts`; `keyed` when it was authorized under a vehicle key.
 * Outcomes:
 *  - `settled`: the server charged it — or, keyed, answered `already_settled`:
 *    the key's charge stands;
 *  - `released`: the server proved nothing posted (400; 404 when unkeyed);
 *  - `unresolved` (keyed only): it may or may not have posted — a 404, a 5xx, no
 *    answer, or a receipt that says `settled: false`. Retried as itself under its
 *    key: the server answers `already_settled` if this settle landed, or places a
 *    hold for the key and charges it once;
 *  - `claimed` (unkeyed only): it may have posted, so its ids are never retried.
 * Every hold that is not settled is given back for hygiene (the server re-queues a
 * hold after a failed settle), except one a `settled: false` receipt says is spent.
 */
async function settleAt(transferId, counts, { keyed, labels = {} }) {
	let settle;
	try {
		settle = await serverRequest(
			"/v1/settle",
			{ transferId, ...counts, usageSource: "provider", ...settleLabels(labels) },
			{ timeoutMs: callTimeout() },
		);
	} catch (err) {
		const holdEnded = await hygieneRelease(transferId, "transcript settle unanswered");
		return {
			outcome: keyed ? "unresolved" : "claimed",
			reason: `settle unreachable: ${errText(err)}`,
			holdEnded,
		};
	}
	return settleOutcome(transferId, settle, keyed);
}

async function settleOutcome(transferId, settle, keyed) {
	if (settle.status === 200) {
		// `settled: false`: the server's ledger post was ambiguous. The hold is spent,
		// and whether it charged is unknown.
		if (settle.json?.settled === false) {
			const reason = "the ledger post is ambiguous (settled: false)";
			return keyed
				? { outcome: "unresolved", reason, holdEnded: true }
				: { outcome: "claimed", reason: `${reason}; the usage may be unrecorded`, holdEnded: true };
		}
		return { outcome: "settled", holdEnded: true };
	}
	if (keyed && isAlreadySettled(settle)) return { outcome: "settled", holdEnded: true };
	// The hold is known gone only when the server says so: this settle's 404
	// `unknown transferId`, or a confirmed hygiene release.
	const released = await hygieneRelease(transferId, "transcript settle failed");
	const holdEnded = released || isUnknownTransfer(settle);
	const reason = `settle returned ${settle.status}`;
	if (settle.status === 400) return { outcome: "released", reason, holdEnded };
	if (keyed) return { outcome: "unresolved", reason, holdEnded };
	return { outcome: settle.status === 404 ? "released" : "claimed", reason, holdEnded };
}

/**
 * A hold no usage was assigned to (a parallel tool call, or nothing new yet)
 * carries no spend: it is released — no charge, no failure. A server that cannot
 * release gets the old settle at zero, which costs its 1-unit floor.
 */
async function returnEmptyHold(transferId) {
	const capabilities = await serverCapabilities();
	if (capabilities === null || capabilities.has("release")) {
		try {
			const response = await serverRequest(
				"/v1/release",
				{
					transferId,
					reason: "no transcript usage was assigned to this hold",
					// Its call's usage is posted by message, never by this hold: nothing hides behind it.
					...((await jobCapable(capabilities)) ? { releaseClass: "unused" } : {}),
				},
				{ timeoutMs: callTimeout() },
			);
			if (response.status === 200) return { outcome: "returned" };
			// Capabilities unknown, and the server has no release route: an older one.
			if (capabilities !== null || !isUnknownRoute(response)) {
				return { outcome: "unreturned", reason: `release returned ${response.status}` };
			}
		} catch (err) {
			// The server's pending-TTL sweep releases it.
			return { outcome: "unreturned", reason: `release unreachable: ${errText(err)}` };
		}
	}
	const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	return settleAt(transferId, zero, { keyed: false });
}

/**
 * Terminate a transcript-mode hold. A hold with assigned usage is SETTLED at its
 * counts: claimed first by renaming its file, so it is settled at most once even
 * if two hooks reach it, and its outcome journalled and applied to the cursor. A
 * hold with none is given back — released, on a server that can release; settled
 * at zero (the server's 1-unit floor) on one that cannot. Returns `{ outcome,
 * reason?, holdEnded? }`; `returned` is an empty hold given back, `deferred` means
 * out of time, hold untouched. A windowed hold's `holdEnded` says whether the
 * server is known to hold it no more: settled or spent, a 404 `unknown
 * transferId`, or a confirmed release. Otherwise it may still be live.
 */
export async function settleTranscriptHold(sessionId, entry) {
	if (callTimeout() < minCall()) return { outcome: "deferred", reason: "out of time" };
	const ids = entry.assignedIds ?? [];
	if (ids.length === 0) {
		const result = await returnEmptyHold(entry.transferId);
		await clearPending(entry.path);
		return result;
	}
	const counts = {};
	for (const key of COUNT_KEYS) counts[key] = count(entry[key]);
	// The hold's own file, as its listing found it: never whatever file the call's
	// name holds now, which may be a later hold's.
	const livePath = entry.path;
	const base = livePath.slice(0, -".json".length);
	// A rename keeps the hold's own mtime: from authorize, maybe long ago. The
	// journal reads a .settling file's age as how long a settle has been in flight,
	// so the file is touched first — the .settling file is never born old.
	const now = new Date();
	await utimes(livePath, now, now).catch(() => {});
	try {
		await rename(livePath, `${base}.settling`);
	} catch (err) {
		if (err?.code === "ENOENT") {
			return { outcome: "skipped", reason: "another hook is settling this hold" };
		}
		return { outcome: "deferred", reason: `hold could not be claimed (${err?.code ?? "error"})` };
	}
	const keyed = typeof entry.idempotencyKey === "string";
	const result = await settleAt(entry.transferId, counts, { keyed, labels: jobHoldFields(entry) });
	try {
		// Exclusive: an outcome never lands over another hold's. Only a 1.4.0 per-call
		// name can already be taken (two holds of one call shared it then). That leaves
		// this hold `.settling`, which the journal reads as unknown once stale: retried
		// under its key, or (unkeyed) its ids accounted, at most once.
		await publishExclusive(
			`${base}.done`,
			JSON.stringify({
				agentId: entry.agentId,
				transferId: entry.transferId,
				assignedIds: ids,
				outcome: result.outcome,
				// What a retry of an unresolved settle needs: the vehicle, as authorized.
				...(keyed
					? {
							idempotencyKey: entry.idempotencyKey,
							holdModel: entry.holdModel,
							agentType: entry.agentType,
							...counts,
							...(typeof entry.serverUrl === "string" && typeof entry.keyHash === "string"
								? { serverUrl: entry.serverUrl, keyHash: entry.keyHash }
								: {}),
							// The labels it was authorized with: a retry is the SAME charge, so it
							// must carry the job that was open when the usage happened.
							...jobHoldFields(entry),
						}
					: {}),
			}),
			{ mode: 0o600 },
		);
		await unlink(`${base}.settling`).catch(() => {});
	} catch (err) {
		// The .settling file stays: once stale, its settle reads as unknown — retried
		// under its key, or (unkeyed) its ids stay claimed.
		say(
			`usertrust: hold ${entry.transferId} ${result.outcome}, but the outcome could not be journalled (${err?.code ?? errText(err)}); a later settle point treats it as unknown`,
		);
	}
	await reconcileAgent(sessionId, entry.agentId);
	return result;
}

/** What an outcome means for the usage, where its name alone does not say. */
export const OUTCOME_NOTES = new Map([
	["unresolved", "; its usage is NOT recorded yet, and is retried under its key at the next Stop"],
	["claimed", "; its usage may be unrecorded, and is never retried (no key)"],
]);

/**
 * Stop/SubagentStop: SETTLE every leftover hold that carries assigned usage. One made
 * under another server or key is dropped instead, nothing sent (lib.mjs
 * `boundElsewhere`): its usage goes unrecorded, never charged to this tenant.
 */
export async function settleAssignedHolds(sessionId, agentId) {
	for (const entry of await listPending(sessionId, agentId)) {
		if ((entry.assignedIds?.length ?? 0) === 0) continue;
		if (boundElsewhere(entry)) {
			// Its window is accounted unrecorded by the agent's next reconcile.
			await abandonHold(entry, "leftover hold", sessionId);
			continue;
		}
		const result = await settleTranscriptHold(sessionId, entry);
		if (result.outcome !== "settled") {
			say(
				`usertrust: leftover hold ${entry.transferId} ${result.outcome} — ${result.reason ?? ""}${OUTCOME_NOTES.get(result.outcome) ?? ""}`,
			);
		}
	}
}

/**
 * Stop and SubagentStop fire as a turn ends, and the turn's final response may
 * not be in the transcript yet — after the LAST turn, nothing would ever post it.
 * The hooks reference (https://code.claude.com/docs/en/hooks) says: "The
 * transcript file is written asynchronously and may lag the in-memory
 * conversation", and, of Stop's `last_assistant_message`, "use this field rather
 * than reading `transcript_path`: the transcript file isn't guaranteed to include
 * the final message at Stop time on all versions". So, given that text, wait — at
 * most FLUSH_WAIT_MS, and never into the time the hook keeps back — until the
 * transcript's last complete assistant entry carries it; then go on either way:
 * "not flushed" leaves the response for SessionEnd or a later Stop.
 */
export async function awaitFinalResponse(transcriptPath, lastMessage, waitMs = FLUSH_WAIT_MS) {
	const want = typeof lastMessage === "string" ? lastMessage.trim() : "";
	if (want === "" || typeof transcriptPath !== "string" || transcriptPath === "") {
		return "nothing to wait for";
	}
	// Never so long that the remainder could not claim what it then reads.
	const until = Date.now() + Math.min(waitMs, timeLeft() - claimFloor() - budgetShare(0.1));
	for (;;) {
		const text = await lastCompleteText(transcriptPath);
		if (text !== null && text !== "" && (text === want || want.endsWith(text))) return "flushed";
		if (Date.now() >= until) return "not flushed";
		await sleep(100);
	}
}

/** The text of the transcript's last complete assistant entry, or null. */
async function lastCompleteText(path) {
	let handle;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		const length = Math.min(size, FLUSH_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString("utf-8", 0, bytesRead).split("\n");
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i] ?? "";
			if (!line.includes('"stop_reason"')) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const message = entry?.message;
			if (entry?.type !== "assistant" || message?.stop_reason == null) continue;
			const blocks = Array.isArray(message.content) ? message.content : [];
			return blocks
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("")
				.trim();
		}
		return null;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * The end of a turn of the session (Stop) or of the session itself (SessionEnd):
 *  1. LEFTOVER HOLDS, across all agents. A hold with assigned transcript usage was
 *     billed even if its tool was interrupted, so it is SETTLED with its counts —
 *     first, so that one whose settle is UNRESOLVED is retried by step 2.
 *  2. REMAINDER. For the parent ("main") and every subagent transcript recorded for
 *     the session — so an agent whose SubagentStop never fired is still accounted —
 *     first retry each unresolved settle as itself, then post the complete messages
 *     no hold picked up (another model, a final answer with no tool call), one
 *     authorize→settle per model, through `selectOwn` like every post. An agent in
 *     estimate mode is skipped: its holds already carried its usage.
 *  3. What is left holds no usage: it is given back — released, or aborted on a
 *     server that cannot release.
 * The remainder stops early enough to leave time for step 3. `lockWaitMs`: how long
 * to wait for an agent's lock another hook holds (SessionEnd is the last chance).
 */
export async function settleSession({ input, hook, lockWaitMs = 0 }) {
	const sessionId = input.session_id ?? "unknown";
	await settleAssignedHolds(sessionId, null);
	if (usageMode() === "transcript") {
		const agents = ["main", ...(await subagentIds(input))];
		for (const [index, agentId] of agents.entries()) {
			try {
				const result = await postRemainder({
					sessionId,
					agentId,
					input,
					hook,
					reserveMs: cleanupReserve(),
					lockWaitMs,
				});
				if (result.skipped !== undefined) {
					say(`usertrust: no transcript usage for ${agentId} — ${result.skipped}`);
				}
				for (const note of result.notes ?? []) {
					say(`usertrust: transcript usage for ${agentId}: ${note}`);
				}
				if (result.serverDown) {
					const rest = agents.slice(index + 1);
					if (rest.length > 0) {
						say(
							`usertrust: server unreachable — transcript usage of ${rest.join(", ")} left for the next settle point`,
						);
					}
					break;
				}
			} catch (err) {
				say(`usertrust: transcript usage failed for ${agentId}: ${errText(err)}`);
			}
		}
	}
	await cleanup(sessionId, null);
}

/**
 * Post one agent's usage that no hold carried: first every UNRESOLVED vehicle,
 * retried exactly as it was; then the unassigned complete messages, one
 * authorize→settle per model. A call starts only if the budget (less
 * `reserveMs`) still covers authorize + settle + release. Returns `{ skipped }` or
 * `{ posted, notes, serverDown }`.
 */
export async function postRemainder({
	sessionId,
	agentId,
	agentTypeHint,
	input,
	hook,
	reserveMs,
	lockWaitMs = 0,
}) {
	const opened = await openAgent({ sessionId, agentId, input, waitMs: lockWaitMs });
	if (opened.kind === "estimate" || opened.kind === "unavailable") {
		return { skipped: opened.reason };
	}
	if (opened.kind === "busy") return { skipped: "a concurrent hook holds this agent's lock" };
	const { cursor } = opened;
	const summary = { posted: 0, notes: [], serverDown: false };
	const callBudget = () => Math.min(callTimeoutCap(), Math.floor((timeLeft() - reserveMs) / 3));
	try {
		const fresh = await selectOwn(opened);
		await opened.save();
		if (fresh.length === 0 && cursor.unresolved.size === 0) return summary;
		// What the server honours decides what these calls may carry (see lib.mjs).
		// Unknown (a failed probe) reads as absent: no key, no principal, no retry.
		const capabilities = await serverCapabilities();
		const keyed = capabilities?.has("idempotency-key") ?? false;
		const principalOf = (rawType) =>
			capabilities?.has("principal") ? principalFor(sessionId, agentId, rawType) : undefined;
		const agentType = await agentTypeFor(opened.transcriptPath, agentId, agentTypeHint);

		// A retry under a key the server would strip could post twice: unresolved
		// vehicles wait for a server that honours keys.
		if (!keyed && cursor.unresolved.size > 0) {
			summary.notes.push(
				capabilities === null
					? `${cursor.unresolved.size} unresolved settle(s) not retried: the server's capabilities are unknown`
					: `${cursor.unresolved.size} unresolved settle(s) wait for a server that honours idempotency keys`,
			);
		}
		for (const [key, vehicle] of keyed ? [...cursor.unresolved] : []) {
			if (boundElsewhere(vehicle)) {
				// Its settle may have posted at that server. Retried here, under a key this
				// server never saw, it would be charged to this tenant as well: it goes
				// unrecorded instead. That is a gap, written before the vehicle goes, so
				// dropping it never erases the one record of an unconfirmed charge.
				const recorded = await recordWatchEvent({
					kind: "gap",
					mode: guardMode(),
					phase: "abandon",
					session: sessionId,
					agent: agentId,
					reason: "an unresolved settle was made under another server or key",
					// When its usage began, from the labels it was sent with, else unknown.
					started: vehicle.labels?.usageFrom ?? null,
				});
				cursor.unresolved.delete(key);
				accountIds(cursor, vehicle.ids);
				await opened.save();
				summary.notes.push(
					`an unresolved ${vehicle.model} settle made under another server or key is not retried here: its usage goes unrecorded${recorded ? " (recorded as a gap)" : ""}`,
				);
				continue;
			}
			const timeoutMs = callBudget();
			if (timeoutMs < minCall()) {
				summary.notes.push("unresolved settles: deferred to the next settle point (out of time)");
				return summary;
			}
			const counts = vehicleCounts(vehicle);
			const result = await postGroup({
				sessionId,
				agentId,
				agentType: safeName(vehicle.agentType, "subagent"),
				hook,
				model: vehicle.model,
				ids: vehicle.ids,
				counts,
				timeoutMs,
				key,
				principal: principalOf(vehicle.agentType),
				capabilities,
				labels: vehicle.labels ?? {},
				retry: true,
			});
			if (result.outcome !== "unresolved") cursor.unresolved.delete(key);
			if (result.outcome === "settled") {
				accountIds(cursor, vehicle.ids);
				summary.posted += vehicle.ids.length;
			} else if (result.outcome === "denied") {
				denyIds(cursor, vehicle.ids);
				await reportDenied(
					agentType.name,
					agentId,
					result.reason,
					vehicle.ids,
					vehicle.model,
					counts,
					{
						sessionId,
						labels: vehicle.labels,
						status: result.status,
						error: result.error,
					},
				);
			} else summary.notes.push(`unresolved ${vehicle.model} settle: ${result.reason}`);
			await opened.save();
			if (result.serverDown) {
				summary.serverDown = true;
				return summary;
			}
		}

		// What this session's job log says NOW, read once per remainder: a message's job
		// is the one open at the message's OWN time, so a remainder spanning a switch
		// settles once per job.
		const jobs = (await jobCapable(capabilities)) ? await resolveJob(sessionId) : null;
		const groups = groupByModel(
			fresh,
			jobs === null ? undefined : (m) => labelsFor(jobs, m.ts).key,
		);
		for (const messages of groups.values()) {
			const model = messages[0].model;
			const span = jobs === null ? {} : usageSpan(messages);
			const labels =
				jobs === null
					? {}
					: {
							...labelsFor(jobs, messages.find((m) => Number.isFinite(m.ts))?.ts ?? Number.NaN)
								.labels,
							...span,
						};
			const timeoutMs = callBudget();
			if (timeoutMs < minCall()) {
				summary.notes.push(`${model}: deferred to the next settle point (out of time)`);
				break;
			}
			const ids = messages.map((m) => m.id);
			const counts = sumCounts(messages);
			const key = keyed ? vehicleKey(sessionId, agentId, ids) : undefined;
			// CLAIM first, before anything could post it. Under a key the group is
			// parked as an unresolved vehicle, so a hook killed mid-call leaves it to be
			// retried as itself; without one, a crash can only lose it, never repeat it.
			if (key === undefined) for (const id of ids) cursor.assigned.set(id, REMAINDER);
			else {
				cursor.unresolved.set(key, {
					ids,
					model,
					agentType: agentType.raw,
					...counts,
					...tenantBinding(),
					...(Object.keys(labels).length === 0 ? {} : { labels }),
				});
			}
			await opened.save();
			const result = await postGroup({
				sessionId,
				agentId,
				agentType: agentType.name,
				hook,
				model,
				ids,
				counts,
				timeoutMs,
				key,
				principal: principalOf(agentType.raw),
				capabilities,
				labels,
				retry: false,
			});
			// An unresolved vehicle stays parked; any other outcome is final for it.
			if (key !== undefined && result.outcome !== "unresolved") cursor.unresolved.delete(key);
			if (result.outcome === "settled" || result.outcome === "claimed") accountIds(cursor, ids);
			else if (result.outcome === "denied") denyIds(cursor, ids);
			else if (result.outcome !== "unresolved") releaseIds(cursor, ids);
			await opened.save();
			if (result.outcome === "settled") summary.posted += ids.length;
			else if (result.outcome === "denied") {
				await reportDenied(agentType.name, agentId, result.reason, ids, model, counts, {
					sessionId,
					labels,
					status: result.status,
					error: result.error,
				});
			} else summary.notes.push(`${model}: ${result.outcome} — ${result.reason}`);
			if (result.serverDown) {
				summary.serverDown = true;
				break;
			}
		}
		return summary;
	} finally {
		await opened.release();
	}
}

function vehicleCounts(vehicle) {
	const counts = {};
	for (const key of COUNT_KEYS) counts[key] = count(vehicle[key]);
	return counts;
}

async function reportDenied(agentType, agentId, reason, ids, model, counts, extra = {}) {
	// A refused segment is never dropped silently: with a job it is also written down as a
	// `would_block` record naming the job and the tokens, so a job's refused spend stays
	// countable (the posted records alone would understate it).
	if (
		extra.labels !== undefined &&
		(extra.labels.job !== undefined || extra.labels.jobState !== undefined)
	) {
		await recordWatchEvent({
			kind: "would_block",
			session: extra.sessionId,
			agent: agentId,
			tool: "(remainder)",
			// The refused usage's own start, not the Stop that ran when it was refused: a
			// remainder refused while another job is open belongs to ITS job's interval.
			// When the refused usage began, or null when it is not known (a timestamp-less message):
			// never the time of the Stop that ran the refusal.
			started: extra.labels.usageFrom ?? null,
			status: extra.status,
			error: extra.error,
			reason: sanitizeReason(reason),
			...(extra.labels.job === undefined ? {} : { job: extra.labels.job }),
			...(extra.labels.jobState === undefined ? {} : { jobState: extra.labels.jobState }),
			model,
			tokens: { ...counts },
		});
	}
	say(
		`usertrust: ${agentType}:${agentId} usage NOT recorded — ${reason}; ${ids.length} ${model} message(s) (${describeCounts(counts)} tokens) are marked denied and never retried`,
	);
}

/**
 * One authorize→settle for a remainder group, or for an unresolved vehicle's
 * retry (`retry`). Under a key the server charges a vehicle at most once: a key
 * whose charge stands is `already_settled`, which settles the vehicle. Release
 * ONLY when nothing was posted for certain — and never on a retry, whose earlier
 * settle may have posted: what is not settled or denied stays unresolved.
 */
async function postGroup({
	sessionId,
	agentId,
	agentType,
	hook,
	model,
	ids,
	counts,
	timeoutMs,
	key,
	principal,
	capabilities,
	labels = {},
	retry,
}) {
	const unsettled = (reason, extra = {}) => ({
		outcome: retry ? "unresolved" : "released",
		reason,
		...extra,
	});
	let auth;
	try {
		auth = await serverRequest(
			"/v1/authorize",
			{
				model,
				...holdEstimate(counts, capabilities),
				params: {
					hook,
					usageOrigin: "transcript",
					agent_id: agentId,
					agent_type: agentType,
					messages: ids.length,
				},
				actor: `claude-code:${sessionId}:${agentType}:${agentId}`,
				...(key === undefined ? {} : { idempotencyKey: key }),
				...(principal === undefined ? {} : { principal }),
				...authorizeLabels(labels),
			},
			{ timeoutMs },
		);
	} catch (err) {
		// No answer: a hold may exist server-side, but nothing settled it; the TTL
		// sweep releases it. Pointless to try the next group now.
		return unsettled(`authorize unreachable: ${errText(err)}`, { serverDown: true });
	}
	if (key !== undefined && isAlreadySettled(auth)) return { outcome: "settled" };
	if (auth.status === 402 || auth.status === 403 || auth.status === 429) {
		return {
			outcome: "denied",
			status: auth.status,
			error: safeName(auth.json?.error, "denied"),
			reason: `authorize ${auth.status} (${safeName(auth.json?.error, "denied")})`,
		};
	}
	const transferId = auth.json?.transferId;
	if (auth.status !== 200 || typeof transferId !== "string" || transferId === "") {
		return unsettled(
			auth.json?.shadow === true
				? "shadow mode (not recorded)"
				: `authorize returned ${auth.status}`,
		);
	}
	let settle;
	try {
		settle = await serverRequest(
			"/v1/settle",
			{ transferId, ...counts, usageSource: "provider", ...settleLabels(labels) },
			{ timeoutMs },
		);
	} catch (err) {
		await hygieneRelease(transferId, "transcript settle unanswered");
		return {
			outcome: key === undefined ? "claimed" : "unresolved",
			reason: `settle unreachable: ${errText(err)}`,
		};
	}
	const result = await settleOutcome(transferId, settle, key !== undefined);
	return retry && result.outcome === "released" ? { ...result, outcome: "unresolved" } : result;
}
