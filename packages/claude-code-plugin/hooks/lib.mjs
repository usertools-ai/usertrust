// Shared runtime for usertrust Claude Code hooks. Zero dependencies — node
// built-ins only, because hooks execute without an install step.
//
// State store design: each pending hold lives in its OWN file, named by its call
// AND its transfer (<stateDir>/<safeSession>__<safeAgent>__<safeCall>.<transferId>.json,
// the call being the tool_use_id, or the transferId when the host sends none; the
// transferId as the server sent it, which must be a valid id: `holdFilePath`). Hooks for the same session can run concurrently; because there
// is no shared file to read-modify-write, no locking is needed — concurrent-hook
// safety holds by construction. Two holds of one call (an earlier one being ended
// while a fresh one is made) never share a file, and a record is never written
// over another file: it is published with an exclusive link (`recordPending`).
//
// The agent dimension matters because Claude Code reuses one session_id across
// the parent and EVERY subagent (only agent_id is per-subagent). Keying holds
// by agent lets SubagentStop void just the stopping subagent's reservations
// without touching the parent's or a sibling's in-flight holds. The agent id is
// also stored inside each file so a whole-session sweep can recover it without
// re-splitting the (ambiguous, "__"-containing) filename.
//
// A transcript-mode hold file also names the transcript messages assigned to
// it and their counts; transcript.mjs journals its outcome beside it
// (<hold>.settling, <hold>.done), names listPending never returns.
//
// Every reader finds a hold by the ids its file STORES, never by its name: the
// "__" joins are ambiguous, and a 1.4.0 record still carries a per-call name
// (<safeSession>__<safeAgent>__<safeCall>.json). Each hold is then claimed,
// settled, journalled and cleared through the path its listing found, so a 1.4.0
// record is ended through its own name, once.
import { createHash } from "node:crypto";
import {
	appendFile,
	link,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { hostEnv, howToSet, refusalNote, settingName, settings } from "./config.mjs";

export class TransportError extends Error {
	constructor(message) {
		super(message);
		this.name = "TransportError";
	}
}

export function readStdin() {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

export function estimateTokens(text) {
	return Math.max(1, Math.ceil(text.length / 4));
}

/** Shared 16 KiB content cap: tool_input is truncated here, and the output hold is sized to the same bound. */
export const MAX_CONTENT_CHARS = 16 * 1024;

// Conservative output hold: same 16 KiB cap as input, via estimateTokens, so a
// settle of (input + output) at the cap cannot price above the reservation
// (AUD-004). Leaving this at 1 under-debited the wallet on every large result.
export const MAX_OUTPUT_TOKENS = estimateTokens("x".repeat(MAX_CONTENT_CHARS));

/**
 * Where the plugin keeps its state: pending holds, and the transcript cursors and
 * message claims that say what was already posted. DURABLE on purpose, beside
 * Claude Code's own data (its transcripts live in the same config dir): state lost
 * while its transcripts survive would be read as "nothing posted yet". A temp dir
 * is not durable — macOS purges files untouched for three days.
 * `UT_CC_STATE_DIR`, or a config file's `stateDir` (config.mjs).
 */
export function stateRoot() {
	return settings().stateDir;
}

const stateDir = stateRoot;

/**
 * Where real usage comes from. `transcript` (default): Claude Code's own
 * session transcript (see transcript.mjs), with the per-call estimate — labelled
 * `estimated` — only for an agent in estimate mode (its transcript cannot be
 * used, or a subagent inherits it: transcript.mjs `inheritedEstimate`).
 * `estimate`: the per-call estimate only, and each agent's estimate mode is
 * recorded (transcript.mjs `stickToEstimate`), so a session resumed without it
 * posts nothing it settled at the estimate.
 */
export function usageMode() {
	return settings().usage;
}

/**
 * Server- or operator-provided text goes through here before it reaches a
 * permission-decision reason, the debug log or the user's terminal: C0/DEL/C1
 * control characters become spaces (callers clip afterwards).
 */
export function sanitizeReason(value, fallback = "unspecified") {
	const text = typeof value === "string" && value !== "" ? value : fallback;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** The longest line `say` or `announce` writes; anything longer is clipped, after sanitizing. */
export const MAX_NOTE_CHARS = 2000;

/**
 * Control characters out FIRST (`sanitizeReason`: C0, DEL and C1 become spaces),
 * clipped AFTER: the order AGENTS.md requires of untrusted text bound for a
 * terminal.
 */
function sanitizeThenClip(text, max) {
	return sanitizeReason(String(text), "").slice(0, max);
}

/**
 * The ONE way a hook writes to stderr — Claude Code's debug log, and the terminal
 * of whoever reads it. Everything a note carries is untrusted: server answers,
 * transcript ids, operator paths, error messages that quote them. So the line is
 * control-character sanitized first and clipped after (`sanitizeThenClip`), then
 * written with its newline.
 * tests/terminal-sinks.test.ts fails on any other stderr write in hooks/*.mjs.
 */
export function say(text, max = MAX_NOTE_CHARS) {
	process.stderr.write(`${sanitizeThenClip(text, max)}\n`);
}

/**
 * The ONE way a hook speaks to the user: hook JSON output whose `systemMessage`
 * (shown in the user's terminal) is sanitized, then clipped, as `say`'s lines are.
 * JSON escaping alone would leave DEL and C1 (U+007F-U+009F) raw.
 */
export function announce(text, max = MAX_NOTE_CHARS) {
	process.stdout.write(JSON.stringify({ systemMessage: sanitizeThenClip(text, max) }));
}

/**
 * The model an authorize names when no transcript says one: every estimate hold,
 * and a transcript hold before its first model is known.
 */
export function defaultModel() {
	return settings().model;
}

/**
 * Whether the plugin may block a tool call. It never grants one, in either mode
 * (see `proceed` in pre-tool-use.mjs). `watch` (the default) NEVER blocks: a
 * budget, policy or anomaly refusal (402/403/429) is written down as a
 * `would_block` record, and a call that could not be metered (the server is
 * unreachable, times out, or answers something unusable) as a `gap` record —
 * missed metering is visible, never silent. `UT_CC_MODE=enforce` opts in to
 * blocking: denials are enforced, and a failed authorization blocks the call
 * unless `UT_FAIL_OPEN=1`. Any other value runs watch-only, and the
 * session-start announcement names the value it ignored. A config file's `mode`
 * and `failOpen` decide the same (config.mjs), and a refused one runs watch-only.
 */
export function guardMode() {
	return settings().mode;
}

/** Where watch records go: one JSON object per line, beside the plugin's other state. */
export function watchLogPath() {
	return join(stateRoot(), "watch.jsonl");
}

/**
 * The one line the session-start hook shows the user, so the mode is never a
 * surprise: a watch-only plugin must not look like it is enforcing.
 */
export function modeAnnouncement() {
	// The path (the operator's UT_CC_STATE_DIR / CLAUDE_CONFIG_DIR) is raw on
	// purpose: it reaches the user only through `announce`, which sanitizes all of
	// the message, then clips it. An unrecognised UT_CC_MODE value is clipped HERE,
	// so it is sanitized here first. A configured session's state dir is a value
	// from its config file, and no such value is ever echoed: that line names no path.
	const current = settings();
	if (current.refused !== null) {
		return `usertrust: watch-only and key-less — ${refusalNote(current.refused)}, so nothing is sent to any server: every tool call is recorded as a gap in ${watchLogPath()}.`;
	}
	const records = current.configured
		? "watch.jsonl in the config file's state dir"
		: watchLogPath();
	if (current.mode === "enforce") {
		return current.failOpen
			? `usertrust: ENFORCING — over-budget tool calls are blocked. While the server is unreachable, calls proceed unmetered (${howToSet("failOpen", true)}), each recorded as a gap in ${records}.`
			: `usertrust: ENFORCING — over-budget tool calls are blocked, and so is every tool call while the usertrust server is unreachable (${howToSet("failOpen", true)} lets those through).`;
	}
	const ignored = current.unrecognizedMode;
	const note =
		ignored === undefined
			? `Set ${howToSet("mode", "enforce")} to block over-budget calls.`
			: `${settingName("mode")}=${JSON.stringify(sanitizeThenClip(ignored, 40))} is not a mode: use ${howToSet("mode", "enforce")} to block over-budget calls.`;
	return `usertrust: watch-only — nothing is blocked. Calls that would have been blocked, and calls that could not be metered, are recorded in ${records}. ${note}`;
}

/**
 * Append one watch record (`would_block` or `gap`) as a JSON line, with the time,
 * session, agent and tool. Never throws: a record that cannot be written is said
 * on stderr, and the tool call proceeds either way. Returns whether the record was
 * written, so no note claims a record that is not there.
 */
export async function recordWatchEvent(event) {
	const line = JSON.stringify({ at: new Date().toISOString(), ...event });
	try {
		await mkdir(stateRoot(), { recursive: true });
		await appendFile(watchLogPath(), `${line}\n`, { mode: 0o600 });
		return true;
	} catch (err) {
		say(
			`usertrust: could not write a watch record to ${watchLogPath()} (${err instanceof Error ? err.message : String(err)}): ${line}`,
		);
		return false;
	}
}

// Every hook gets a wall-clock budget inside the time Claude Code gives it, so a
// slow server makes a hook give up cleanly instead of being killed mid-write.
// Module evaluation is the hook's start: each hook is its own node process.
const HOOK_STARTED_AT = Date.now();
/** Every hook's budget but SessionEnd's: well inside hooks.json's 15 s timeout. */
export const HOOK_BUDGET_MS = 10_000;
let hookBudgetMs = HOOK_BUDGET_MS;

const SESSION_END_DEFAULT_MS = 1_500;
/** What node takes to start the hook before its budget starts, and to exit. */
const SESSION_END_MARGIN_MS = 300;

/**
 * SessionEnd's budget. Claude Code gives SessionEnd hooks far less time than any
 * other: "SessionEnd hooks have a default timeout of 1.5 seconds", "Timeouts set
 * on plugin-provided hooks don't raise the budget", and
 * `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, in milliseconds, overrides it
 * (https://code.claude.com/docs/en/hooks#sessionend). Less the start-up margin,
 * and never more than any other hook's budget.
 */
export function sessionEndBudgetMs(env = hostEnv()) {
	const raw = env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS ?? "";
	const configured = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : SESSION_END_DEFAULT_MS;
	return Math.max(0, Math.min(configured, HOOK_BUDGET_MS) - SESSION_END_MARGIN_MS);
}

/** This hook's budget, counted from its start (SessionEnd: `sessionEndBudgetMs`). */
export function useHookBudget(ms) {
	hookBudgetMs = ms;
}

/** A share of this hook's budget: the time limits of its steps scale with it. */
export function budgetShare(fraction) {
	return Math.floor(hookBudgetMs * fraction);
}

/** Milliseconds left in this hook's budget (negative once it is spent). */
export function timeLeft() {
	return HOOK_STARTED_AT + hookBudgetMs - Date.now();
}

export function sanitize(part) {
	return String(part ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** What a server's transferId must be to name a hold's file (`isTransferId`). */
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether a server's transferId can name a hold's file AS IT IS: 1 to 128 of
 * `A-Z a-z 0-9 _ -` (usertrust-server mints `tx_<base36 time>_<8 hex>`). It is
 * checked at every authorize answer, and a hold whose id fails it is never
 * recorded. Never sanitized into a name instead: a lossy mapping would let two
 * ids share one hold's file.
 */
export function isTransferId(value) {
	return typeof value === "string" && TRANSFER_ID.test(value);
}

/**
 * Path of one hold's pending file: `<session>__<agent>__<call>.<transferId>.json`,
 * the call being the toolUseId, or the transferId when the host sends none. It is
 * keyed by the TRANSFER, not the call alone: a call can have two holds at once (a
 * resumed call's earlier hold, being ended, and its fresh one), and each claim,
 * settle and journal entry must belong to exactly one of them. The transfer id
 * goes in as it is (`isTransferId`, or this throws), and the `.` before it is a
 * character neither it nor `sanitize` ever contains: no two holds share a name,
 * and no such name can equal a 1.4.0 per-call name (`<session>__<agent>__<call>.json`).
 */
export function holdFilePath(sessionId, agentId, entry) {
	if (!isTransferId(entry.transferId)) {
		throw new Error("a transferId that is not a valid id cannot name a hold's file");
	}
	const call = entry.toolUseId ?? entry.transferId;
	return join(
		stateDir(),
		`${sanitize(sessionId)}__${sanitize(agentId)}__${sanitize(call)}.${entry.transferId}.json`,
	);
}

/**
 * A name another hold's file already has. A record is never written over another
 * file: the fresh hold is given back instead, and the call refused.
 */
export class HoldNameTaken extends Error {
	constructor(path) {
		super(`another hold's file already has this hold's name (${basename(path)})`);
		this.name = "HoldNameTaken";
		this.code = "EEXIST";
	}
}

/**
 * Record a pending hold as its own file (`holdFilePath`), atomic AND exclusive
 * (`publishExclusive`: link(), which never replaces a file already there, as a
 * rename would; an exclusive create on a filesystem without hard links). A name
 * already taken throws `HoldNameTaken`, and that file is left untouched. The agent id is stored in the
 * file body so a whole-session sweep can recover which agent owns the hold.
 * Every hold is marked `gate: 1` (`isGated`) in this same atomic write, never
 * later. The file is the user's alone (0600), as every file in the state dir is.
 */
export async function recordPending(sessionId, agentId, entry, { settling = false } = {}) {
	const live = holdFilePath(sessionId, agentId, entry);
	const path = settling ? settlingPath(live) : live;
	await mkdir(stateDir(), { recursive: true });
	try {
		await publishExclusive(
			path,
			JSON.stringify({
				gate: 1,
				toolUseId: entry.toolUseId ?? null,
				transferId: entry.transferId,
				agentId: String(agentId ?? "main"),
				// Persist the authorize-time input estimate so settle can price both
				// legs. Without it, post-tool-use sent only outputTokens and a large
				// result priced above the 1-token hold (AUD-004).
				...(typeof entry.estimatedInputTokens === "number"
					? { estimatedInputTokens: entry.estimatedInputTokens }
					: {}),
				// Which server and tenant made the hold: never the key itself.
				...tenantBinding(),
				// A transcript-mode hold also records what it will settle: the model it
				// was authorized at, the transcript message ids assigned to it, and their
				// summed counts.
				...(entry.usage === "transcript" ? transcriptHoldFields(entry) : {}),
			}),
			{ mode: 0o600 },
		);
	} catch (err) {
		if (err?.code === "EEXIST") throw new HoldNameTaken(path);
		throw err;
	}
	return path;
}

/** Errors that mean the state dir's filesystem cannot make hard links. */
export const LINKLESS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/**
 * Publish `content` at `path` unless a file is there already (EEXIST, thrown): written
 * in full under a temporary name, then linked into place by link(2), which never
 * replaces a name, so it is whole the moment it exists. On a filesystem without hard
 * links (`LINKLESS`), by an exclusive create instead: still never over another file.
 * Published or not, the temporary name goes, so a write that fails (ENOSPC, say, or
 * a name already taken) leaves no partial file.
 */
export async function publishExclusive(path, content, { mode } = {}) {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	const options = mode === undefined ? {} : { mode };
	try {
		await writeFile(tmp, content, options);
		try {
			await link(tmp, path);
		} catch (err) {
			if (!LINKLESS.has(err?.code)) throw err;
			await writeFile(path, content, { ...options, flag: "wx" });
		}
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

/**
 * Whether a hold was recorded under the settle-attempt gate: its file carries
 * `gate: 1`. Such a hold's settle is claimed (`.json` → `.settling`) before it is
 * sent, so it is settled at most once. A hold an earlier release recorded has no
 * mark. That release kept a hold whose settle posted and lost its answer as a
 * pending `.json`, so the hold may have been charged already. Any other value,
 * including a later format's, is treated the same way. Such a hold is never
 * paired with a call by a host that sends no tool_use_id (`takePendingEntry`) and
 * never re-authorized after a 404 (post-tool-use.mjs `settleEstimateHold`): Stop
 * only gives it back.
 */
export function isGated(entry) {
	return entry?.gate === 1;
}

/**
 * The hold a tool call already has. Claude Code fires PreToolUse again for the SAME
 * tool call when a deferred call resumes (hooks reference, "Defer a tool call for
 * later"), and PreToolUse then ends that hold before it reserves afresh. Returns
 * `{ state: "pending", entry }` for its pending record, the entry as `listPending`
 * gives it; `{ state: "settling", entry }` when its settle is under way or was cut
 * off unanswered (`.settling`; the entry is `{ transferId, assignedIds, transcript,
 * path, mtimeMs }`, with the record's tenant binding when it has one); or null,
 * also when the call has no `tool_use_id`.
 * A record counts only if the ids it STORES are this call's: it is found by its
 * body, never by its name. State-file names join ids with "__", so two calls can
 * share a call name (agent `a__b` with tool `c`, and agent `a` with tool `b__c`),
 * and a 1.4.0 record carries a per-call name. The pending record is found exactly as
 * PostToolUse finds the hold it settles (`takePendingEntry`), so PreToolUse ends
 * only a hold this call's PostToolUse would settle.
 */
export async function holdOfCall(sessionId, agentId, toolUseId) {
	if (typeof toolUseId !== "string" || toolUseId === "") return null;
	const entry = await takePendingEntry(sessionId, agentId, toolUseId);
	if (entry !== null) return { state: "pending", entry };
	const settling = (await settlingRecords(sessionId, agentId)).find(
		(record) => record.toolUseId === toolUseId,
	);
	if (settling === undefined) return null;
	const { toolUseId: _call, ...record } = settling;
	return { state: "settling", entry: record };
}

/** A pending hold's settle-attempted path: `<hold>.settling` beside `<hold>.json`. */
function settlingPath(livePath) {
	return `${livePath.slice(0, -".json".length)}.settling`;
}

/**
 * Mark an estimate hold settle-attempted BEFORE its one settle: touch it, then
 * rename its `.json` to `.settling` atomically — the gate a transcript hold's
 * settle already passes (transcript.mjs `settleTranscriptHold`). `listPending`
 * lists `.json` only, so no later hook can pick the hold again: not even a
 * PostToolUse whose host sent no tool_use_id, which takes the OLDEST hold. Stop
 * only gives a `.settling` estimate hold back (`cleanup`); nothing settles it
 * again. `live` is the pending file as its listing found it (`entry.path`): the
 * claim names one hold, never whatever file a call's name holds now. Returns the
 * `.settling` path, or null when another hook took it first.
 */
export async function claimForSettle(live) {
	const now = new Date();
	await utimes(live, now, now).catch(() => {});
	try {
		await rename(live, settlingPath(live));
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
	return settlingPath(live);
}

/**
 * The `.settling` records of a session (or of one agent): holds whose one settle
 * was attempted, in flight or cut off unanswered. Each is identified by the ids
 * its body stores, never by its name.
 */
async function settlingRecords(sessionId, agentId) {
	const prefix = `${sanitize(sessionId)}__`;
	const wantAgent = agentId == null ? null : sanitize(agentId);
	let names;
	try {
		names = await readdir(stateDir());
	} catch {
		return [];
	}
	const held = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".settling")) continue;
		const path = join(stateDir(), name);
		try {
			const body = JSON.parse(await readFile(path, "utf-8"));
			if (typeof body?.transferId !== "string") continue;
			if (wantAgent !== null && sanitize(body.agentId ?? "main") !== wantAgent) continue;
			const { mtimeMs } = await stat(path);
			held.push({
				path,
				transferId: body.transferId,
				toolUseId: body.toolUseId ?? null,
				assignedIds: Array.isArray(body.assignedIds) ? body.assignedIds : [],
				transcript: body.usage === "transcript",
				// Which server and tenant made the hold (`tenantBinding`), as written.
				...(typeof body.serverUrl === "string" ? { serverUrl: body.serverUrl } : {}),
				...(typeof body.keyHash === "string" ? { keyHash: body.keyHash } : {}),
				// How long its settle has been in flight: a claim touches the file first.
				mtimeMs,
			});
		} catch {
			// Corrupt or concurrently removed — skip.
		}
	}
	return held;
}

/**
 * The estimate holds of a session (or of one agent) whose one settle was
 * attempted and never answered: `.settling` files without transcript usage. A
 * transcript hold's `.settling` belongs to the transcript journal instead.
 */
async function settlingEstimates(sessionId, agentId) {
	return (await settlingRecords(sessionId, agentId)).filter((record) => !record.transcript);
}

const COUNT_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

function countOf(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function transcriptHoldFields(entry) {
	const fields = {
		usage: "transcript",
		holdModel: String(entry.holdModel ?? "unknown"),
		assignedIds: Array.isArray(entry.assignedIds)
			? entry.assignedIds.filter((id) => typeof id === "string")
			: [],
	};
	for (const key of COUNT_FIELDS) fields[key] = countOf(entry[key]);
	// A hold authorized under a key also records the key and the agent type its
	// principal named: what a retry of its settle needs (see transcript.mjs).
	if (typeof entry.idempotencyKey === "string") fields.idempotencyKey = entry.idempotencyKey;
	if (typeof entry.agentType === "string") fields.agentType = entry.agentType;
	return fields;
}

/**
 * List pending holds for a session, oldest first (by mtime). When agentId is a
 * string, only that agent's holds are returned; when it is null, holds for
 * EVERY agent in the session are returned (whole-session sweep). Corrupt or
 * concurrently-removed files are skipped — never brick a hook.
 */
export async function listPending(sessionId, agentId) {
	const prefix = `${sanitize(sessionId)}__`;
	const wantAgent = agentId == null ? null : sanitize(agentId);
	let names;
	try {
		names = await readdir(stateDir());
	} catch {
		return [];
	}
	const entries = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
		const path = join(stateDir(), name);
		try {
			const parsed = JSON.parse(await readFile(path, "utf-8"));
			if (!parsed || typeof parsed.transferId !== "string") continue;
			// agentId lives in the body; the filename's "__" split is ambiguous
			// because sanitized ids can themselves contain "__".
			const entryAgent = sanitize(parsed.agentId ?? "main");
			if (wantAgent !== null && entryAgent !== wantAgent) continue;
			const { mtimeMs } = await stat(path);
			entries.push({
				entryKey: sanitize(parsed.toolUseId ?? parsed.transferId),
				// The file as found: every claim, settle and clear of this hold goes
				// through it (a 1.4.0 record keeps its per-call name).
				path,
				agentId: entryAgent,
				toolUseId: parsed.toolUseId ?? null,
				transferId: parsed.transferId,
				...(typeof parsed.estimatedInputTokens === "number"
					? { estimatedInputTokens: parsed.estimatedInputTokens }
					: {}),
				// The mark as written, whatever its value: `isGated` judges it.
				...(Object.hasOwn(parsed, "gate") ? { gate: parsed.gate } : {}),
				...(typeof parsed.serverUrl === "string" ? { serverUrl: parsed.serverUrl } : {}),
				...(typeof parsed.keyHash === "string" ? { keyHash: parsed.keyHash } : {}),
				...(parsed.usage === "transcript" ? transcriptHoldFields(parsed) : {}),
				mtimeMs,
			});
		} catch {
			// Corrupt or vanished entry — skip.
		}
	}
	entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.entryKey < b.entryKey ? -1 : 1));
	return entries.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}

/**
 * Find the pending hold for a tool call within one agent's holds. A non-empty
 * toolUseId matches that row or returns null — it must NOT fall through to
 * another tool's reservation (AUD-005). The oldest-entry fallback is only for
 * hosts that omit tool_use_id (missing/null/empty), and it takes the oldest hold
 * recorded under the settle-attempt gate (`isGated`). An unmarked hold, an
 * earlier release's, may have been charged already, so it is never paired with a
 * call: Stop gives it back. Does NOT delete — the caller clears the file only
 * after a successful settle (clearPending), so a failed settle leaves the hold
 * for Stop cleanup.
 */
export async function takePendingEntry(sessionId, agentId, toolUseId) {
	const entries = await listPending(sessionId, agentId);
	if (typeof toolUseId === "string" && toolUseId !== "") {
		return entries.find((entry) => entry.toolUseId === toolUseId) ?? null;
	}
	return entries.find(isGated) ?? null;
}

/**
 * Delete one pending-hold file, by the path its listing found (`entry.path`), so a
 * hook acting on an earlier listing never deletes another hold's file. Idempotent
 * — a missing file is fine.
 */
export async function clearPending(path) {
	try {
		await unlink(path);
	} catch {
		// Already cleared.
	}
}

/**
 * The governance server this hook talks to (`UT_SERVER_URL`, or a config file's
 * `url`): null when a configured session's file was refused, which sends nothing.
 */
function serverBase() {
	return settings().url;
}

/**
 * Which server and tenant this hook talks to, without the key itself: the server's
 * URL, and the first 16 hex digits of the key's SHA-256 (`UT_SERVER_KEY`). Every
 * pending record carries it, so a tool call resumed under another server or key
 * never takes the earlier hold for one of its own (pre-tool-use.mjs `sameTenant`).
 */
export function tenantBinding() {
	return {
		serverUrl: serverBase(),
		keyHash: createHash("sha256").update(settings().key).digest("hex").slice(0, 16),
	};
}

/**
 * Whether a hold record was made under the server and key this hook talks to
 * (`tenantBinding`). A record without a binding (written before the plugin kept
 * one) is not: its tenant is unknown.
 */
export function sameTenant(entry) {
	const here = tenantBinding();
	return entry.serverUrl === here.serverUrl && entry.keyHash === here.keyHash;
}

/**
 * Whether a hold record NAMES another server or key than this hook's. Every hook
 * is its own process and reads its settings afresh, so the server or key can
 * change between the hook that made a hold and the one that ends it (an edited
 * config file, or environment). Such a hold is never settled, released or given
 * back through this server: it answers 404 for a hold it never made, and the
 * estimate path would then charge the call to this tenant on a fresh hold. A
 * record without a binding names none, and is ended as it always was.
 */
export function boundElsewhere(entry) {
	return (
		typeof entry.serverUrl === "string" && typeof entry.keyHash === "string" && !sameTenant(entry)
	);
}

/**
 * Drop the record of a hold made under ANOTHER server or key, sending this hook's
 * server nothing about it (`boundElsewhere`). The record is claimed first, so only
 * one hook drops it.
 * - A window it carried is then accounted by the journal as unrecorded (assigned
 *   ids whose hold is gone), never posted to this tenant: an under-count of the
 *   other one.
 * - The hold itself is left to its own server's sweep, or the ledger's timeout.
 * Returns false when another hook claimed the record first.
 */
export async function abandonHold(entry, what) {
	const claimed = await claimForSettle(entry.path);
	if (claimed !== null) {
		say(
			`usertrust: ${what} ${entry.transferId} was made under another server or key; nothing about it is sent here, and any usage it carried goes unrecorded`,
		);
		await unlink(claimed).catch(() => {});
	}
	return claimed !== null;
}

/**
 * POST to the governance server. `timeoutMs` bounds the whole exchange (5 s
 * unless the caller passes less); a spent budget throws without a request.
 */
export async function serverRequest(path, body, { timeoutMs = 5000 } = {}) {
	const { refused, key } = settings();
	// A refused config file: no request at all, and its fixed reason is the gap's.
	if (refused !== null) throw new TransportError(refused);
	const base = serverBase();
	if (!(timeoutMs > 0)) throw new TransportError("hook time budget spent");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await response.text();
		let json = null;
		try {
			json = text === "" ? null : JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, json };
	} catch (err) {
		throw new TransportError(err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timeout);
	}
}

// ── What the server honours ──

let capabilitiesRead;

/**
 * What the server honours (`/v1/health` `capabilities`), read once per hook
 * process. Never cached on disk: a cache could still claim keys after the server
 * was downgraded to one that strips them. Resolves to a Set — empty for an older
 * server, which publishes none — or to null when it is UNKNOWN: the probe failed
 * or ran out of time (noted on stderr, once). Unknown is not absent: a caller must
 * not send a key it cannot know is honoured, and must not treat a server that can
 * release as one that cannot (its abort would count as a breaker failure).
 *
 * WHY THIS GATES ANYTHING: an older usertrust-server's schemas STRIP request keys
 * they do not know. It would accept an `idempotencyKey` and drop it in silence —
 * and a settle retried "safely" under that key would then post twice.
 */
export function serverCapabilities() {
	capabilitiesRead ??= (async () => {
		const base = serverBase();
		const timeoutMs = Math.min(2_000, budgetShare(0.2), timeLeft());
		const unknown = (why) => {
			say(
				`usertrust: the server's capabilities are unknown (${why}) — this hook sends no idempotency key or principal`,
			);
			return null;
		};
		const { refused } = settings();
		if (refused !== null) return unknown(refused);
		if (!(timeoutMs > 0)) return unknown("hook time budget spent");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`${base}/v1/health`, { signal: controller.signal });
			if (!response.ok) return unknown(`health returned ${response.status}`);
			const json = await response.json();
			const list = Array.isArray(json?.capabilities) ? json.capabilities : [];
			return new Set(list.filter((c) => typeof c === "string"));
		} catch (err) {
			return unknown(err instanceof Error ? err.message : String(err));
		} finally {
			clearTimeout(timeout);
		}
	})();
	return capabilitiesRead;
}

/** A server's answer that it has no such route at all: an older server, not a refusal. */
export function isUnknownRoute(response) {
	return response.status === 404 && response.json?.reason === "unknown route";
}

/**
 * A server's answer that it holds no such transfer: the hold is gone (expired, or
 * ended by another hook). Only the body says so: a bare 404, an older server's
 * unknown route or a proxy's, does not.
 */
export function isUnknownTransfer(response) {
	return response.status === 404 && response.json?.reason === "unknown transferId";
}

/**
 * The server's answer that a key's charge already stands (usertrust #205): from
 * `/v1/authorize` when an earlier settle under the key landed, and from
 * `/v1/settle` when another hold already charged it.
 */
export function isAlreadySettled(response) {
	return response.status === 409 && response.json?.error === "already_settled";
}

/**
 * Give a hold back WITHOUT calling it a failure: `/v1/release` on a server that
 * has it, so a hold that simply was not needed records no breaker failure and no
 * `llm_call_failed` (usertrust #204). An older server has only `/v1/abort`. With
 * the capabilities unknown, release is tried first: only a server that answers it
 * has no such route gets the abort.
 */
export async function releaseHold(transferId, reason, { timeoutMs = 5000 } = {}) {
	const capabilities = await serverCapabilities();
	if (capabilities === null || capabilities.has("release")) {
		const released = await serverRequest("/v1/release", { transferId, reason }, { timeoutMs });
		if (capabilities !== null || !isUnknownRoute(released))
			return { route: "release", ...released };
	}
	return {
		route: "abort",
		...(await serverRequest("/v1/abort", { transferId, error: reason }, { timeoutMs })),
	};
}

/**
 * Give back a hold whose transferId cannot name a file (`isTransferId`), through a
 * `release` the server advertises and nothing else: never an abort, which counts
 * as a breaker failure. Without `release`, the hold is left to the server's
 * pending-hold sweep. Never throws; never echoes the id, which may be anything.
 */
export async function giveBackInvalid(transferId, timeoutMs) {
	if (typeof transferId !== "string" || transferId === "") return;
	const capabilities = await serverCapabilities();
	if (!capabilities?.has("release")) {
		say(
			"usertrust: a hold whose transferId is not a valid id is left to the server's pending-hold sweep (no release)",
		);
		return;
	}
	try {
		const response = await serverRequest(
			"/v1/release",
			{ transferId, reason: "its transferId is not a valid id" },
			{ timeoutMs },
		);
		if (response.status !== 200) {
			say(
				`usertrust: the release of a hold whose transferId is not a valid id returned ${response.status}; the server's sweep releases it`,
			);
		}
	} catch (err) {
		say(
			`usertrust: a hold whose transferId is not a valid id could not be released (${err instanceof Error ? err.message : String(err)}); the server's sweep releases it`,
		);
	}
}

/**
 * Give back a hold a remediation path cannot keep (its record could not be
 * written), and say only what the server confirmed. `releaseHold` resolves on any
 * answer, so the status decides: a 200 is the one answer that means "given back";
 * any other is reported as refused, with its route, status and reason; a request
 * that throws is reported as thrown. A hold not given back is released by the
 * server's pending-TTL sweep. Never throws. Returns whether the give-back was
 * confirmed.
 */
export async function giveBack(transferId, reason, timeoutMs) {
	try {
		const response = await releaseHold(transferId, reason, { timeoutMs });
		if (response.status === 200) return true;
		const why = response.json?.reason ?? response.json?.error;
		say(
			`usertrust: ${response.route} ${transferId} was refused (${response.status}${typeof why === "string" ? `: ${why}` : ""}); the server's TTL sweep releases the hold`,
		);
	} catch (err) {
		say(
			`usertrust: hold ${transferId} could not be given back (${err instanceof Error ? err.message : String(err)}); the server's TTL sweep releases it`,
		);
	}
	return false;
}

/**
 * Release remaining holds for a session — they are not failures. When agentId is
 * a string, only that agent's holds are released (SubagentStop for one subagent);
 * when it is null, every agent's holds are (Stop — the session really is ending).
 * A hold that carries assigned transcript usage is NOT released here: it is a
 * settlement, and transcript.mjs settles it. Non-200 responses and transport
 * failures are reported to stderr but never thrown. Files are cleared
 * regardless: the session (or subagent) is over, so a hold that could not be
 * released is voided server-side by the pending-TTL sweep, and keeping the file
 * would only leak state-dir entries. A hold the hook budget no longer covers is
 * left for the next Stop and the TTL sweep. An estimate hold left settle-attempted
 * (`.settling`: its one settle went unanswered) is given back the same way and
 * then forgotten — never settled again. A hold made under another server or key
 * is forgotten without a word to this one (`boundElsewhere`).
 */
export async function cleanup(sessionId, agentId) {
	for (const entry of await listPending(sessionId, agentId)) {
		if ((entry.assignedIds?.length ?? 0) > 0) continue;
		if (boundElsewhere(entry)) {
			await abandonHold(entry, "leftover hold");
			continue;
		}
		const timeoutMs = Math.min(5000, timeLeft());
		if (timeoutMs < 100) {
			say(`usertrust: out of time; hold ${entry.transferId} left for Stop/TTL`);
			return;
		}
		try {
			const response = await releaseHold(entry.transferId, "session ended with unsettled hold", {
				timeoutMs,
			});
			if (response.status !== 200) {
				say(`usertrust: ${response.route} ${entry.transferId} returned ${response.status}`);
			}
		} catch (err) {
			say(
				`usertrust: failed to give back ${entry.transferId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await clearPending(entry.path);
	}
	for (const held of await settlingEstimates(sessionId, agentId)) {
		// An estimate hold whose one settle went unanswered: it may have posted, so
		// it is NEVER settled again — only given back (a 404 here means it posted or
		// expired), then forgotten. Another server's or key's is only forgotten.
		if (boundElsewhere(held)) {
			say(
				`usertrust: leftover hold ${held.transferId} was made under another server or key; nothing about it is sent here`,
			);
			await unlink(held.path).catch(() => {});
			continue;
		}
		const timeoutMs = Math.min(5000, timeLeft());
		if (timeoutMs < 100) {
			say(`usertrust: out of time; hold ${held.transferId} left for Stop/TTL`);
			return;
		}
		try {
			const response = await releaseHold(
				held.transferId,
				"session ended after an unanswered settle",
				{
					timeoutMs,
				},
			);
			if (response.status !== 200 && response.status !== 404) {
				say(`usertrust: ${response.route} ${held.transferId} returned ${response.status}`);
			}
		} catch (err) {
			say(
				`usertrust: failed to give back ${held.transferId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await unlink(held.path).catch(() => {});
	}
}
