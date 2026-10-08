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
import { randomBytes } from "node:crypto";
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
import { hostEnv, howToSet, keyHash, refusalNote, settingName, settings } from "./config.mjs";

/** Set by launch.mjs, which runs every hook: the hook's payload and its start. */
let launched = null;

/**
 * launch.mjs starts each hook: it resolves the session's settings (config.mjs
 * `useSession`), then hands over what it read from stdin (null when the hook should
 * read stdin itself, as a child does) and when the hook started.
 */
export function launch({ payload, startedAt }) {
	launched = { payload, startedAt };
	hookStart = startedAt;
}

/**
 * Every hook module's first step: a hook runs only as launch.mjs starts it, never
 * from its own file, so no hook can run without its session's pinned settings.
 */
export function requireLaunch() {
	if (launched === null) throw new Error("usertrust: a hook runs only through launch.mjs");
}

export class TransportError extends Error {
	constructor(message) {
		super(message);
		this.name = "TransportError";
	}
}

export function readStdin() {
	// launch.mjs read it already when it runs the hook in its own process.
	if (typeof launched?.payload === "string") return Promise.resolve(launched.payload);
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
	// `started` is when the EVENT'S OWN CALL began; `at` is when this record was written. EVERY
	// caller must say its own `started` (an ISO time), or `null` when it is not known. There is
	// no default: this hook's start is the call's start only for a PreToolUse event, and a
	// default of it stamped other writers' records with the Stop's time, which could land the
	// event in a later job while the job it belonged to read clean. An omitted `started` is
	// UNKNOWN (null), which counts against every job.
	const line = JSON.stringify({
		at: new Date().toISOString(),
		...event,
		started: event.started === undefined ? null : event.started,
	});
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
// slow server makes a hook give up cleanly instead of being killed mid-write. The
// hook's start is launch.mjs's (`launch`): for a configured session's child, its
// parent's start, so the budget counts the time it took to start the child.
let hookStart = Date.now();
/** Every hook's budget but SessionEnd's: well inside hooks.json's 15 s timeout. */
export const HOOK_BUDGET_MS = 10_000;
let hookBudgetMs = HOOK_BUDGET_MS;

const SESSION_END_DEFAULT_MS = 1_500;
/**
 * What node takes to start the hook before its budget starts, and to exit. A
 * configured session's child starts within the budget: it counts from its parent's start.
 */
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

/**
 * When this hook started (epoch ms): the moment it RECEIVED the call. For a configured
 * session's child, that is its parent's start (`launch`). A job is resolved at this time
 * and no later, so a `usertrust-job` switch that lands while the hook awaits a health
 * probe or a log read cannot move the call to the new job.
 */
export function hookStartedAt() {
	return hookStart;
}

/** Milliseconds left in this hook's budget (negative once it is spent). */
export function timeLeft() {
	return hookStart + hookBudgetMs - Date.now();
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
				// When the CALL was received, kept on EVERY hold whether or not the server honours
				// `job`: a give-back at Stop that has to write a gap places it by this time, never
				// by the Stop's own.
				...(typeof entry.startedAt === "string" ? { startedAt: entry.startedAt } : {}),
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
				// The job labels this hold was authorized with: what its settle names and what
				// a replacement hold must carry (the labels belong to the HOLD, not the clock).
				...jobHoldFields(entry),
			}),
			{ mode: 0o600 },
		);
	} catch (err) {
		if (err?.code === "EEXIST") throw new HoldNameTaken(path);
		throw err;
	}
	return path;
}

/**
 * A give-back of a hold whose call RAN (or may have) without a confirmed charge is a GAP:
 * metered usage the ledger cannot vouch for. `started` is when the call began (the hold's
 * own `usageFrom`), so a job switch that lands later cannot move it to another job.
 */
export async function recordUnconfirmedCall(sessionId, held, releaseClass) {
	await recordWatchEvent({
		kind: "gap",
		mode: guardMode(),
		session: sessionId,
		agent: held.agentId ?? "main",
		tool: "(unconfirmed)",
		reason:
			releaseClass === "call-ran"
				? "the call ran and its charge is unconfirmed (its settle went unanswered)"
				: "the call may have run and was never charged (no PostToolUse settle)",
		releaseClass,
		// The call's own start: the hold's usage start, else the time it was received. With NEITHER
		// (an older hold) the time is UNKNOWN, and a gap with no time counts against every job; it
		// is never stamped with this Stop's time, which could put it in a later job.
		started:
			typeof held.usageFrom === "string"
				? held.usageFrom
				: typeof held.startedAt === "string"
					? held.startedAt
					: null,
	});
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
/**
 * Claim a hold ONLY to end it: a resumed call's earlier hold, whose call was DEFERRED and never
 * ran. It is renamed straight into `.releasing`, a name that carries the intent, so Stop gives
 * it back as `unused` with no gap, and no state between the claim and the intent exists to be
 * caught by a Stop or a kill. (Marking the `.json` first would let a PostToolUse claim inherit
 * the mark.) Returns the claimed path, or null when another hook claimed the hold first.
 */
export async function claimForRelease(live) {
	const now = new Date();
	await utimes(live, now, now).catch(() => {});
	const target = `${live.slice(0, -".json".length)}.releasing`;
	try {
		await rename(live, target);
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
	return target;
}

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
		// `.settling`: its one settle was attempted. `.releasing`: the claim only ENDS a deferred
		// call's hold. The intent is in the NAME the hold was claimed into, so it is atomic with
		// the claim: a Stop or a kill between the two can never read it as a settle attempt.
		const releasing = name.endsWith(".releasing");
		if (!name.startsWith(prefix) || !(releasing || name.endsWith(".settling"))) continue;
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
				agentId: sanitize(body.agentId ?? "main"),
				...jobHoldFields(body),
				...(typeof body.startedAt === "string" ? { startedAt: body.startedAt } : {}),
				// Why the hold was claimed: `release` when its call was deferred and the claim only
				// serves to end the hold (the hold was claimed into `.releasing`), otherwise a settle attempt.
				...(releasing ? { intent: "release" } : {}),
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
	// A `.releasing` hold (claimed only to END a deferred call's earlier hold) is Stop's to give
	// back whatever mode made it: it has no usage by construction, so the transcript/estimate split
	// does not apply, and nothing else (the journal, the sweep) ever reads it.
	return (await settlingRecords(sessionId, agentId)).filter(
		(record) => !record.transcript || record.intent === "release",
	);
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
				...jobHoldFields(parsed),
				...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
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
 * The url of one of the server's routes (`route`, as `/v1/authorize`): the base's
 * origin and path as the URL parser reads them, then the route. The server matches
 * each route exactly, so the base's text will not do: with a trailing `/` it gave
 * `//v1/authorize`, and with a query it put the route inside the query. Both answer
 * 404, so every call went unmetered, or was blocked in enforce mode. A fragment is
 * never sent. Throws on a base that does not parse, as a fetch of it would.
 */
function routeUrl(route) {
	const url = new URL(serverBase());
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${route}`;
	url.search = "";
	return url.href;
}

/**
 * Which server and tenant this hook talks to, without the key itself: the server's
 * URL, and the first 16 hex digits of the key's SHA-256 (`UT_SERVER_KEY`). Every
 * pending record carries it, so a tool call resumed under another server or key
 * never takes the earlier hold for one of its own (pre-tool-use.mjs `sameTenant`).
 * The URL is the base AS WRITTEN, not as requested (`routeUrl`): a hold recorded
 * under any spelling, by this version or an earlier one, is ended under that same
 * spelling exactly as before.
 */
export function tenantBinding() {
	return {
		serverUrl: serverBase(),
		keyHash: keyHash(settings().key),
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

/** The watch record of a hold dropped unended (`boundElsewhere`): its usage goes unrecorded. */
const ABANDONED = "the hold was made under another server or key";

/**
 * Drop the record of a hold made under ANOTHER server or key, sending this hook's
 * server nothing about it (`boundElsewhere`). The record is claimed first, so only
 * one hook drops it, and the drop is recorded as a gap (`session`, the session's
 * id): any usage it carried goes unrecorded.
 * - A window it carried is then accounted by the journal as unrecorded (assigned
 *   ids whose hold is gone), never posted to this tenant: an under-count of the
 *   other one.
 * - The hold itself is left to its own server's sweep, or the ledger's timeout.
 * Returns false when another hook claimed the record first.
 */
export async function abandonHold(entry, what, session) {
	const claimed = await claimForSettle(entry.path);
	if (claimed !== null) {
		const recorded = await recordWatchEvent({
			kind: "gap",
			mode: guardMode(),
			phase: "abandon",
			session,
			agent: entry.agentId,
			transferId: entry.transferId,
			reason: ABANDONED,
		});
		say(
			`usertrust: ${what} ${entry.transferId} was made under another server or key; nothing about it is sent here, and any usage it carried goes unrecorded${recorded ? " (recorded as a gap)" : ""}`,
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
	if (!(timeoutMs > 0)) throw new TransportError("hook time budget spent");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(routeUrl(path), {
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
 * Which job labels a record carries, off a hold's entry or its file: strings only,
 * so a corrupt file can never put a non-string into a request. Absent keys stay
 * absent (a hold authorized without the `job` capability records none).
 */
export function jobHoldFields(entry) {
	const out = {};
	for (const key of ["job", "jobState", "usageFrom", "usageTo"]) {
		if (typeof entry?.[key] === "string" && entry[key] !== "") out[key] = entry[key];
	}
	return out;
}

// Under jobs/, beside the logs: the state dir's top level lists holds, and a server that
// never offered `job` must leave it exactly as it was.
/**
 * Replace `path` with `text` ATOMICALLY: a temp file in the same directory, then rename(2) over
 * the name. A reader sees the old content or the new, never an empty or half-written file
 * (writeFile truncates in place first). `beforeCommit` is a test seam between the two steps.
 */
export async function writeFileAtomic(path, text, { mode = 0o600, beforeCommit } = {}) {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, text, { mode });
		await beforeCommit?.();
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

const JOB_CAPABILITY_FILE = join("jobs", "capability.json");
let jobCapableRead;

/**
 * Whether the server honours the `job` capability (job, jobState, usageFrom, usageTo).
 * An older server's schemas STRIP those keys in silence, so they are sent only to a
 * server known to honour them. Unlike an idempotency key, sending them to a server
 * that does not is HARMLESS (the record is simply untagged, and the coverage check
 * reports the untagged record as a known gap), so this one bit may be remembered per
 * server URL for the case where the health probe fails: losing attribution to a
 * probe timeout is the silent loss this exists to avoid. The idempotency-key and
 * release capabilities are NEVER cached: a stale "honoured" there double-posts.
 * A probe that ANSWERS always overwrites the remembered bit.
 */
export function jobCapable(capabilities) {
	jobCapableRead ??= (async () => {
		const file = join(stateDir(), JOB_CAPABILITY_FILE);
		const url = serverBase();
		let known = {};
		try {
			const parsed = JSON.parse(await readFile(file, "utf-8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) known = parsed;
		} catch {
			// unreadable or absent: nothing remembered
		}
		if (capabilities === null) return known[url] === true;
		const honoured = capabilities.has("job");
		if (known[url] !== honoured && (honoured || known[url] !== undefined)) {
			try {
				await mkdir(join(stateDir(), "jobs"), { recursive: true, mode: 0o700 });
				await writeFileAtomic(file, JSON.stringify({ ...known, [url]: honoured }));
			} catch {
				// the bit is a convenience: a failed write loses only the memory
			}
		}
		return honoured;
	})();
	return jobCapableRead;
}

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
			const response = await fetch(routeUrl("/v1/health"), { signal: controller.signal });
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
export async function releaseHold(transferId, reason, { timeoutMs = 5000, releaseClass } = {}) {
	const capabilities = await serverCapabilities();
	if (capabilities === null || capabilities.has("release")) {
		// WHY the hold is given back, as the closed set the server records
		// (`releaseClass`, capability `job`): the only thing that can prove a released hold
		// spent nothing. Sent only to a server that honours it; a release that states none
		// proves nothing.
		const cls = releaseClass !== undefined && (await jobCapable(capabilities));
		const released = await serverRequest(
			"/v1/release",
			{ transferId, reason, ...(cls ? { releaseClass } : {}) },
			{ timeoutMs },
		);
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
export async function giveBackInvalid(transferId, timeoutMs, releaseClass = "unused") {
	// The default: no call ever ran under a hold whose id came back malformed at PreToolUse.
	// A caller whose call DID run (PostToolUse's replacement hold) says so, `call-ran`.
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
			{
				transferId,
				reason: "its transferId is not a valid id",
				...((await jobCapable(capabilities)) ? { releaseClass } : {}),
			},
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
export async function giveBack(transferId, reason, timeoutMs, releaseClass) {
	try {
		const response = await releaseHold(transferId, reason, { timeoutMs, releaseClass });
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
			await abandonHold(entry, "leftover hold", sessionId);
			continue;
		}
		const timeoutMs = Math.min(5000, timeLeft());
		if (timeoutMs < 100) {
			say(`usertrust: out of time; hold ${entry.transferId} left for Stop/TTL`);
			return;
		}
		// What the client KNOWS about this hold decides its class, never the reason text. A
		// transcript-mode hold with no assigned usage reserved a window of messages that is
		// posted by message, so nothing hides behind it: `unused`. An estimate-mode hold still
		// `.json` at Stop never reached PostToolUse: a failed or interrupted call (#264 A) that
		// MAY have run and was never charged. That is unconfirmed, and it is a gap.
		const ranUnconfirmed = entry.usage !== "transcript";
		if (ranUnconfirmed) await recordUnconfirmedCall(sessionId, entry, "call-unconfirmed");
		try {
			const response = await releaseHold(entry.transferId, "session ended with unsettled hold", {
				timeoutMs,
				releaseClass: ranUnconfirmed ? "call-unconfirmed" : "unused",
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
			// Its one settle went out unanswered under that server: whatever it charged
			// stands there. Nothing more is owed here, so nothing is recorded.
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
		// A claim made only to END a deferred call's hold (`intent: "release"`) is given back as
		// `unused`: that call never ran, so there is nothing to confirm and no gap.
		const releasing = held.intent === "release";
		// Otherwise the call RAN and its one settle went unanswered: the charge is unconfirmed, and a
		// give-back of the hold proves nothing about what was charged. Written down as a gap.
		if (!releasing) await recordUnconfirmedCall(sessionId, held, "call-ran");
		try {
			const response = await releaseHold(
				held.transferId,
				"session ended after an unanswered settle",
				{
					timeoutMs,
					releaseClass: releasing ? "unused" : "call-ran",
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
