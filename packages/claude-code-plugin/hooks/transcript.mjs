// Real usage from Claude Code's own session transcripts. Zero dependencies.
//
// WHAT THE TRANSCRIPT HOLDS (measured, shape only):
//  - One JSONL file per agent. The parent ("main") agent writes
//    <projectDir>/<sessionId>.jsonl — the hook's `transcript_path`. Every
//    subagent writes <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl,
//    beside agent-<agentId>.meta.json (which carries `agentType`). Each
//    subagent entry repeats the same `agentId` and has `isSidechain: true`; the
//    parent file carries no subagent usage, so the files never overlap.
//  - Assistant entries carry `message.{id, model, usage, stop_reason}`. ONE API
//    response is written as SEVERAL entries sharing `message.id` (one per
//    content block, and progressively while streaming). Their input and cache
//    counts are identical; `output_tokens` only grows. A message is complete
//    once an entry has a non-null `stop_reason`, and one id can have several
//    complete entries. So an id's usage is the per-field MAX over its entries
//    (a later entry can never lower it), and an incomplete id waits.
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
// INVARIANTS:
//  1. Every hold is terminated EXACTLY ONCE. On the normal path by a SETTLE,
//     never an abort; an abort happens only for a hold no usage was ever
//     assigned to that is being cleaned up (an interrupted tool, session end),
//     or for hygiene after a failed settle.
//  2. Every transcript message id is posted AT MOST ONCE: it is assigned to one
//     hold (and settled with it), posted by one remainder settle, or marked
//     `denied`. An id is CLAIMED in the cursor before anything that could post
//     it, and released only when the server proved nothing was posted
//     (authorize failed, or settle answered 400/404). Any ambiguity — a settle
//     5xx, a transport error, a crash — keeps it claimed: usage can be lost to
//     an outage, never posted twice.
//  3. The estimate is used only in estimate mode (UT_CC_USAGE=estimate, or an
//     agent whose transcript could not be read: sticky, recorded in its cursor),
//     and never together with real usage for the same agent.
//
// STATE, per (session, agent), in <state>/transcripts (private: 0700, ours):
//   { v: 1, byteOffset, partial, accounted, denied, assigned, estimateMode, lastModel }
//  - byteOffset: the transcript is read incrementally, only up to the last
//    newline; a file shorter than the offset is re-read from 0 (the id sets
//    still prevent re-posting).
//  - partial: every id seen but not yet accounted or denied, with its counts.
//  - accounted / denied: the most recent 10 000 ids each.
//  - assigned: id → transferId, "remainder" (an in-flight remainder claim) or
//    "authorizing" (written BEFORE PreToolUse's authorize, with a timestamp in
//    authorizingAt). An "authorizing" entry older than 5 minutes is treated as
//    unassigned: its authorize never completed. The one residual window is a
//    crash between authorize 200 and the pending-hold write: nothing records
//    that hold's transferId, so nothing can settle it — the server's TTL sweep
//    voids it — and the ids are posted once, later, by another hold. That is a
//    second RESERVATION for up to the TTL, never a second post.
// A hold's outcome is journalled beside its pending file (<hold>.settling while
// in flight, <hold>.done after) so the cursor can be brought up to date by the
// next hook that gets the lock, even when the settling hook could not.
import { randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	clearPending,
	listPending,
	sanitize,
	serverRequest,
	stateFilePath,
	stateRoot,
	timeLeft,
	usageMode,
} from "./lib.mjs";

/** Never priced when its usage is all zero: Claude Code's local placeholder. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Holds sized from transcript usage count cache writes twice: they are priced
 * above fresh input (up to 2x for the 1-hour tier), and a hold below the real
 * cost would cap the posted amount (shortfall) instead of recording it.
 */
const CACHE_WRITE_HOLD_FACTOR = 2;

const CURSOR_VERSION = 1;
/** A lock older than this is a crashed holder, not a live one. */
const STALE_LOCK_MS = 60_000;
/** An "authorizing" assignment older than this never completed. */
const AUTHORIZING_TTL_MS = 5 * 60_000;
/** A hold left "settling" this long belongs to a crashed hook. */
const STALE_SETTLING_MS = 10 * 60_000;
const ID_HISTORY = 10_000;
const MAX_ID_CHARS = 256;
const CALL_TIMEOUT_MS = 3_000;
const MIN_CALL_MS = 250;
/** Stop/SubagentStop keep this much of the budget for settling leftover holds. */
export const LEFTOVER_RESERVE_MS = 3_000;

const AUTHORIZING = "authorizing";
const REMAINDER = "remainder";
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COUNT_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

/** Untrusted strings (model, agent type/id) → [A-Za-z0-9._-], at most 128 chars. */
export function safeName(value, fallback) {
	const text =
		typeof value === "string" ? value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) : "";
	return text === "" ? fallback : text;
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

/** Per-call timeout for a transcript request: at most 3 s, and never past the budget. */
function callTimeout(reserveMs = 0) {
	return Math.min(CALL_TIMEOUT_MS, timeLeft() - reserveMs);
}

function sumCounts(messages) {
	const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	for (const m of messages) for (const key of COUNT_KEYS) sum[key] += m[key];
	return sum;
}

function describeCounts(c) {
	return `input ${c.inputTokens}, output ${c.outputTokens}, cache read ${c.cacheReadTokens}, cache write ${c.cacheWriteTokens}`;
}

/** The hold that covers `counts` at their real cost (see CACHE_WRITE_HOLD_FACTOR). */
export function holdInputTokens(counts) {
	return (
		counts.inputTokens + counts.cacheReadTokens + CACHE_WRITE_HOLD_FACTOR * counts.cacheWriteTokens
	);
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

/** `agentType` from the subagent's meta file, else the hook's, else "subagent". */
async function agentTypeFor(transcriptPath, agentId, hinted) {
	if (agentId === "main") return "main";
	try {
		const meta = JSON.parse(
			await readFile(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf-8"),
		);
		if (typeof meta?.agentType === "string" && meta.agentType !== "") {
			return safeName(meta.agentType, "subagent");
		}
	} catch {
		// No meta file — use the hint.
	}
	return safeName(hinted, "subagent");
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
		authorizingAt: new Map(),
		estimateMode: false,
		estimateReason: null,
		lastModel: null,
	};
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A v1 cursor, or null if any field is not what this code wrote. */
function parseCursor(raw) {
	if (!isObject(raw) || raw.v !== CURSOR_VERSION) return null;
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
			model: safeName(m.model, "unknown"),
			synthetic: m.synthetic === true,
			complete: m.complete === true,
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
	for (const [id, at] of Object.entries(isObject(raw.authorizingAt) ? raw.authorizingAt : {})) {
		if (Number.isFinite(at)) cursor.authorizingAt.set(id, at);
	}
	cursor.accounted = new Set(raw.accounted);
	cursor.denied = new Set(raw.denied);
	cursor.estimateMode = raw.estimateMode;
	cursor.estimateReason = typeof raw.estimateReason === "string" ? raw.estimateReason : null;
	cursor.lastModel = typeof raw.lastModel === "string" ? safeName(raw.lastModel, "unknown") : null;
	const seqs = [...cursor.partial.values()].map((m) => m.n + 1);
	cursor.nextSeq = Math.max(Number.isSafeInteger(raw.nextSeq) ? raw.nextSeq : 0, 0, ...seqs);
	return cursor;
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
			authorizingAt: Object.fromEntries(cursor.authorizingAt),
			estimateMode: cursor.estimateMode,
			estimateReason: cursor.estimateReason,
			lastModel: cursor.lastModel,
		}),
	);
}

function accountIds(cursor, ids) {
	for (const id of ids) {
		cursor.assigned.delete(id);
		cursor.authorizingAt.delete(id);
		cursor.partial.delete(id);
		cursor.accounted.add(id);
	}
}

function releaseIds(cursor, ids) {
	for (const id of ids) {
		cursor.assigned.delete(id);
		cursor.authorizingAt.delete(id);
	}
}

function denyIds(cursor, ids) {
	for (const id of ids) {
		cursor.assigned.delete(id);
		cursor.authorizingAt.delete(id);
		cursor.partial.delete(id);
		cursor.denied.add(id);
	}
}

/**
 * Exclusive per-(session, agent) lock: an atomic mkdir holding an ownership
 * token. A lock older than STALE_LOCK_MS is reclaimed by renaming it aside —
 * only one rename can win — and released only by the holder whose token is
 * still inside. Any failure reads as busy. Returns a release fn or null.
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
			const aside = `${lock}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
			await rename(lock, aside);
			// Between our stat and our rename another reclaimer may have replaced
			// the stale lock with a live one; if we moved a live lock, put it back.
			if (Date.now() - (await stat(aside)).mtimeMs < STALE_LOCK_MS) {
				await rename(aside, lock).catch(() => {});
				return false;
			}
			await rm(aside, { recursive: true, force: true });
			await mkdir(lock);
		} catch {
			return false;
		}
	}
	try {
		await writeFile(join(lock, "owner"), token, { flag: "wx", mode: 0o600 });
		return true;
	} catch {
		await rm(lock, { recursive: true, force: true }).catch(() => {});
		return false;
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
			records.push({ kind, path, ids, outcome: body.outcome, mtimeMs });
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
			else accountIds(cursor, record.ids);
			finished.push(record.path);
		} else if (record.kind === "settling" && now - record.mtimeMs > STALE_SETTLING_MS) {
			// Its hook died mid-settle: the outcome is unknown, so the ids stay claimed.
			accountIds(cursor, record.ids);
			finished.push(record.path);
		} else {
			for (const id of record.ids) live.add(id);
		}
	}
	for (const [id, value] of cursor.assigned) {
		if (value === AUTHORIZING) {
			if (now - (cursor.authorizingAt.get(id) ?? 0) > AUTHORIZING_TTL_MS) releaseIds(cursor, [id]);
		} else if (!live.has(id)) {
			// Its hold is gone without a journalled outcome (a crash after posting
			// could look exactly like this): at most once, so it stays claimed.
			accountIds(cursor, [id]);
		}
	}
	return { live, finished };
}

async function removeFiles(paths) {
	for (const path of paths.splice(0)) await unlink(path).catch(() => {});
}

/**
 * Read the transcript from the cursor's byte offset to its last complete line,
 * folding each message id's entries into `cursor.partial` (per-field max; the
 * model of the first entry seen). Only an I/O failure is "unreadable".
 */
async function ingest(cursor, path) {
	let handle;
	try {
		handle = await open(path, "r");
	} catch (err) {
		return { ok: false, reason: `transcript unreadable (${err?.code ?? "error"})` };
	}
	let text = "";
	try {
		const { size } = await handle.stat();
		let offset = cursor.byteOffset;
		if (size < offset) offset = 0; // truncated or replaced: start over
		const length = size - offset;
		const buffer = Buffer.alloc(length);
		let filled = 0;
		while (filled < length) {
			const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		const end = filled === 0 ? -1 : buffer.lastIndexOf(0x0a, filled - 1);
		cursor.byteOffset = offset + end + 1;
		if (end >= 0) text = buffer.toString("utf-8", 0, end + 1);
	} catch (err) {
		return { ok: false, reason: `transcript unreadable (${err?.code ?? "error"})` };
	} finally {
		await handle.close().catch(() => {});
	}
	let badLines = 0;
	for (const line of text.split("\n")) {
		if (!line.includes('"usage"')) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			badLines += 1;
			continue;
		}
		const message = entry?.message;
		const usage = message?.usage;
		const id = message?.id;
		if (typeof id !== "string" || id === "" || id.length > MAX_ID_CHARS) continue;
		if (!isObject(usage)) continue;
		if (cursor.accounted.has(id) || cursor.denied.has(id)) continue;
		const rawModel = typeof message.model === "string" ? message.model : "";
		let m = cursor.partial.get(id);
		if (m === undefined) {
			m = {
				n: cursor.nextSeq,
				model: safeName(rawModel, "unknown"),
				synthetic: rawModel === SYNTHETIC_MODEL,
				complete: false,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			};
			cursor.nextSeq += 1;
			cursor.partial.set(id, m);
		}
		m.inputTokens = Math.max(m.inputTokens, count(usage.input_tokens));
		m.outputTokens = Math.max(m.outputTokens, count(usage.output_tokens));
		m.cacheReadTokens = Math.max(m.cacheReadTokens, count(usage.cache_read_input_tokens));
		m.cacheWriteTokens = Math.max(m.cacheWriteTokens, count(usage.cache_creation_input_tokens));
		if (message.stop_reason != null) m.complete = true;
		if (rawModel !== "" && rawModel !== SYNTHETIC_MODEL) cursor.lastModel = safeName(rawModel);
	}
	return { ok: true, badLines };
}

/**
 * The agent's NEW complete messages — not accounted, assigned, denied, or held
 * by a live hold — oldest first. A `<synthetic>` placeholder whose usage is all
 * zero is accounted on the spot: it was never billed.
 */
function selectNew(cursor, live) {
	const fresh = [];
	const free = [];
	for (const [id, m] of cursor.partial) {
		if (!m.complete || cursor.assigned.has(id) || live.has(id)) continue;
		const total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
		if (m.synthetic && total === 0) free.push(id);
		else fresh.push({ id, ...m });
	}
	accountIds(cursor, free);
	return fresh.sort((a, b) => a.n - b.n);
}

/** Where an agent's transcript and cursor live, or why it has none this run. */
async function locate({ sessionId, agentId, input }) {
	if (usageMode() === "estimate") return { ok: false, reason: "UT_CC_USAGE=estimate" };
	if (!isAgentId(agentId)) return { ok: false, reason: "agent id is not safe in a path" };
	const transcriptPath = transcriptPathFor(input, agentId);
	if (transcriptPath === undefined) return { ok: false, reason: "no transcript path" };
	const where = await cursorLocation(sessionId, agentId);
	return where.ok ? { ...where, transcriptPath } : where;
}

/** The agent's cursor file inside the private state dir. */
async function cursorLocation(sessionId, agentId) {
	if (!isAgentId(agentId)) return { ok: false, reason: "agent id is not safe in a path" };
	const dir = await privateStateDir();
	if (!dir.ok) return { ok: false, reason: dir.reason };
	return { ok: true, cursorPath: join(dir.dir, `${sanitize(sessionId)}__${agentId}.json`) };
}

/**
 * Why an agent is in estimate mode right now, or null if it is not. Read
 * without the lock (cursor writes are atomic).
 */
export async function estimateReasonFor({ sessionId, agentId, input }) {
	const where = await locate({ sessionId, agentId, input });
	if (!where.ok) return where.reason;
	const read = await readCursor(where.cursorPath);
	if (!read.ok) return read.reason;
	return read.cursor.estimateMode ? (read.cursor.estimateReason ?? "transcript unreadable") : null;
}

/**
 * Open an agent's transcript state: lock, cursor, journal reconcile, then an
 * incremental read. Returns `{ kind: "estimate", reason }` (no transcript
 * accounting for this agent now — sticky when its transcript was unreadable),
 * `{ kind: "busy", lastModel }`, or `{ kind: "ready", ... }` holding the lock.
 */
async function openAgent({ sessionId, agentId, input, waitMs = 0 }) {
	const where = await locate({ sessionId, agentId, input });
	if (!where.ok) return { kind: "estimate", reason: where.reason };
	const { cursorPath, transcriptPath } = where;
	const release = await acquireLock(cursorPath, { waitMs });
	if (release === null) {
		const peek = await readCursor(cursorPath);
		if (!peek.ok) return { kind: "estimate", reason: peek.reason };
		if (peek.cursor.estimateMode) {
			return { kind: "estimate", reason: peek.cursor.estimateReason ?? "transcript unreadable" };
		}
		return { kind: "busy", lastModel: peek.cursor.lastModel };
	}
	try {
		const read = await readCursor(cursorPath);
		if (!read.ok) {
			// DEGRADED: post nothing, leave the cursor exactly as it is.
			await release();
			return { kind: "estimate", reason: read.reason, degraded: true };
		}
		const { cursor } = read;
		if (cursor.estimateMode) {
			await release();
			return { kind: "estimate", reason: cursor.estimateReason ?? "transcript unreadable" };
		}
		const { live, finished } = await reconcile(cursor, sessionId, agentId);
		const ingested = await ingest(cursor, transcriptPath);
		if (!ingested.ok) {
			cursor.estimateMode = true;
			cursor.estimateReason = ingested.reason;
			await writeCursor(cursorPath, cursor);
			await removeFiles(finished);
			await release();
			return { kind: "estimate", reason: ingested.reason, becameSticky: true };
		}
		if (ingested.badLines > 0) {
			process.stderr.write(
				`usertrust: skipped ${ingested.badLines} unparseable transcript line(s)\n`,
			);
		}
		return {
			kind: "ready",
			cursor,
			live,
			transcriptPath,
			release,
			async save() {
				await writeCursor(cursorPath, cursor);
				await removeFiles(finished);
			},
		};
	} catch (err) {
		await release();
		return { kind: "estimate", reason: `transcript state unavailable (${errText(err)})` };
	}
}

/** Apply journalled hold outcomes to one agent's cursor, if its lock is free soon. */
async function reconcileAgent(sessionId, agentId) {
	const where = await cursorLocation(sessionId, agentId);
	if (!where.ok) return;
	const release = await acquireLock(where.cursorPath, { waitMs: 300 });
	if (release === null) return; // the next lock holder reconciles
	try {
		const read = await readCursor(where.cursorPath);
		if (!read.ok) return;
		const { finished } = await reconcile(read.cursor, sessionId, agentId);
		await writeCursor(where.cursorPath, read.cursor);
		await removeFiles(finished);
	} catch {
		// Left for the next lock holder.
	} finally {
		await release();
	}
}

/**
 * Pick this tool call's window and mark it "authorizing" BEFORE the authorize.
 * Returns `{ mode: "estimate", reason, becameSticky }` or `{ mode: "transcript",
 * window: null | { model, ids, counts }, agentType, lastModel, commit,
 * abandon, release }`. With the lock busy, the window is empty.
 */
export async function prepareWindow({ sessionId, agentId, agentTypeHint, input }) {
	const opened = await openAgent({ sessionId, agentId, input });
	if (opened.kind === "estimate") {
		return { mode: "estimate", reason: opened.reason, becameSticky: opened.becameSticky === true };
	}
	const none = async () => {};
	const empty = (lastModel) => ({
		mode: "transcript",
		window: null,
		lastModel,
		commit: none,
		abandon: none,
		release: none,
	});
	if (opened.kind === "busy") return empty(opened.lastModel);
	const { cursor } = opened;
	let window = null;
	try {
		const fresh = selectNew(cursor, opened.live);
		if (fresh.length > 0) {
			const model = fresh[0].model;
			const messages = fresh.filter((m) => m.model === model);
			const now = Date.now();
			for (const m of messages) {
				cursor.assigned.set(m.id, AUTHORIZING);
				cursor.authorizingAt.set(m.id, now);
			}
			window = { model, ids: messages.map((m) => m.id), counts: sumCounts(messages) };
		}
		await opened.save();
	} catch (err) {
		await opened.release();
		process.stderr.write(`usertrust: transcript window skipped — ${errText(err)}\n`);
		return empty(cursor.lastModel);
	}
	const agentType = await agentTypeFor(opened.transcriptPath, agentId, agentTypeHint);
	let decided = false;
	return {
		mode: "transcript",
		window,
		agentType,
		lastModel: cursor.lastModel,
		async commit(transferId) {
			if (window === null || decided) return;
			decided = true;
			for (const id of window.ids) {
				cursor.assigned.set(id, transferId);
				cursor.authorizingAt.delete(id);
			}
			// If this write fails the pending file still names the ids, and the
			// journal keeps them out of every other window until the hold ends.
			await opened.save().catch((err) => {
				process.stderr.write(`usertrust: cursor not updated — ${errText(err)}\n`);
			});
		},
		async abandon() {
			// Once committed the ids belong to a recorded hold: never release them.
			if (window === null || decided) return;
			decided = true;
			releaseIds(cursor, window.ids);
			await opened.save().catch((err) => {
				process.stderr.write(`usertrust: cursor not updated — ${errText(err)}\n`);
			});
		},
		release: opened.release,
	};
}

async function hygieneAbort(transferId, why) {
	const timeoutMs = callTimeout();
	if (timeoutMs < MIN_CALL_MS) return;
	try {
		await serverRequest("/v1/abort", { transferId, error: why }, { timeoutMs });
	} catch {
		// The server's pending-TTL sweep voids it.
	}
}

/**
 * Settle a hold at `counts`. Outcomes: `settled`; `released` (400/404 — the
 * server proved nothing posted); `claimed` (5xx or no answer — it may have
 * posted, so its ids are never retried). Every non-settle is aborted for
 * hygiene, since the server re-queues a hold after a failed settle.
 */
async function settleAt(transferId, counts) {
	let settle;
	try {
		settle = await serverRequest(
			"/v1/settle",
			{ transferId, ...counts, usageSource: "provider" },
			{ timeoutMs: callTimeout() },
		);
	} catch (err) {
		await hygieneAbort(transferId, "transcript settle unanswered");
		return { outcome: "claimed", reason: `settle unreachable: ${errText(err)}` };
	}
	if (settle.status === 200) return { outcome: "settled" };
	await hygieneAbort(transferId, "transcript settle failed");
	const outcome = settle.status === 400 || settle.status === 404 ? "released" : "claimed";
	return { outcome, reason: `settle returned ${settle.status}` };
}

/**
 * Terminate a transcript-mode hold by SETTLING it: at its assigned counts, or
 * at zero (the server's 1-unit floor) when nothing was assigned to it. A hold
 * with ids is first claimed by renaming its file, so it is settled at most once
 * even if two hooks reach it; its outcome is journalled and applied to the
 * cursor. Returns `{ outcome, reason? }`; `deferred` means out of time, hold
 * untouched.
 */
export async function settleTranscriptHold(sessionId, entry) {
	if (callTimeout() < MIN_CALL_MS) return { outcome: "deferred", reason: "out of time" };
	const ids = entry.assignedIds ?? [];
	const counts = {};
	for (const key of COUNT_KEYS) counts[key] = ids.length > 0 ? count(entry[key]) : 0;
	if (ids.length === 0) {
		const result = await settleAt(entry.transferId, counts);
		await clearPending(sessionId, entry.agentId, entry.entryKey);
		return result;
	}
	const livePath = stateFilePath(sessionId, entry.agentId, entry.entryKey);
	const base = livePath.slice(0, -".json".length);
	try {
		await rename(livePath, `${base}.settling`);
	} catch {
		return { outcome: "skipped", reason: "another hook is settling this hold" };
	}
	const result = await settleAt(entry.transferId, counts);
	try {
		await writeAtomic(
			`${base}.done`,
			JSON.stringify({
				agentId: entry.agentId,
				transferId: entry.transferId,
				assignedIds: ids,
				outcome: result.outcome,
			}),
		);
		await unlink(`${base}.settling`).catch(() => {});
	} catch {
		// The .settling file stays; once stale, its ids are accounted (claimed).
	}
	await reconcileAgent(sessionId, entry.agentId);
	return result;
}

/** Stop/SubagentStop: SETTLE every leftover hold that carries assigned usage. */
export async function settleAssignedHolds(sessionId, agentId) {
	for (const entry of await listPending(sessionId, agentId)) {
		if ((entry.assignedIds?.length ?? 0) === 0) continue;
		const result = await settleTranscriptHold(sessionId, entry);
		if (result.outcome !== "settled") {
			process.stderr.write(
				`usertrust: leftover hold ${entry.transferId} ${result.outcome} — ${result.reason ?? ""}\n`,
			);
		}
	}
}

/**
 * Post one agent's unassigned complete messages, one authorize→settle per
 * model. A group starts only if the budget (less `reserveMs`) still covers
 * authorize + settle + abort. Returns `{ skipped }` or `{ posted, notes,
 * serverDown }`.
 */
export async function postRemainder({ sessionId, agentId, agentTypeHint, input, hook, reserveMs }) {
	const opened = await openAgent({ sessionId, agentId, input });
	if (opened.kind === "estimate") return { skipped: opened.reason };
	if (opened.kind === "busy") return { skipped: "a concurrent hook holds this agent's lock" };
	const { cursor } = opened;
	const summary = { posted: 0, notes: [], serverDown: false };
	try {
		const fresh = selectNew(cursor, opened.live);
		await opened.save();
		if (fresh.length === 0) return summary;
		const agentType = await agentTypeFor(opened.transcriptPath, agentId, agentTypeHint);
		const groups = new Map();
		for (const m of fresh) groups.set(m.model, [...(groups.get(m.model) ?? []), m]);
		for (const [model, messages] of groups) {
			const timeoutMs = Math.min(CALL_TIMEOUT_MS, Math.floor((timeLeft() - reserveMs) / 3));
			if (timeoutMs < MIN_CALL_MS) {
				summary.notes.push(`${model}: deferred to the next settle point (out of time)`);
				break;
			}
			const ids = messages.map((m) => m.id);
			// CLAIM first: from here on a crash can only lose this usage, never repeat it.
			for (const id of ids) cursor.assigned.set(id, REMAINDER);
			await opened.save();
			const counts = sumCounts(messages);
			const result = await postGroup({
				sessionId,
				agentId,
				agentType,
				hook,
				model,
				ids,
				counts,
				timeoutMs,
			});
			if (result.outcome === "settled" || result.outcome === "claimed") accountIds(cursor, ids);
			else if (result.outcome === "denied") denyIds(cursor, ids);
			else releaseIds(cursor, ids);
			await opened.save();
			if (result.outcome === "settled") summary.posted += ids.length;
			else if (result.outcome === "denied") {
				process.stderr.write(
					`usertrust: ${agentType}:${agentId} usage NOT recorded — ${result.reason}; ${ids.length} ${model} message(s) (${describeCounts(counts)} tokens) are marked denied and never retried\n`,
				);
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

/**
 * One authorize→settle for a remainder group. Release ONLY when nothing was
 * posted for certain: authorize failed, or settle answered 400/404.
 */
async function postGroup({ sessionId, agentId, agentType, hook, model, ids, counts, timeoutMs }) {
	let auth;
	try {
		auth = await serverRequest(
			"/v1/authorize",
			{
				model,
				estimatedInputTokens: holdInputTokens(counts),
				maxOutputTokens: Math.max(1, counts.outputTokens),
				params: {
					hook,
					usageOrigin: "transcript",
					agent_id: agentId,
					agent_type: agentType,
					messages: ids.length,
				},
				actor: `claude-code:${sessionId}:${agentType}:${agentId}`,
			},
			{ timeoutMs },
		);
	} catch (err) {
		// No answer: a hold may exist server-side, but nothing settled it; the TTL
		// sweep voids it. Safe to retry — and pointless to try the next group now.
		return {
			outcome: "released",
			reason: `authorize unreachable: ${errText(err)}`,
			serverDown: true,
		};
	}
	if (auth.status === 402 || auth.status === 403 || auth.status === 429) {
		return {
			outcome: "denied",
			reason: `authorize ${auth.status} (${safeName(auth.json?.error, "denied")})`,
		};
	}
	const transferId = auth.json?.transferId;
	if (auth.status !== 200 || typeof transferId !== "string" || transferId === "") {
		const reason =
			auth.json?.shadow === true
				? "shadow mode (not recorded)"
				: `authorize returned ${auth.status}`;
		return { outcome: "released", reason };
	}
	let settle;
	try {
		settle = await serverRequest(
			"/v1/settle",
			{ transferId, ...counts, usageSource: "provider" },
			{ timeoutMs },
		);
	} catch (err) {
		await hygieneAbort(transferId, "transcript settle unanswered");
		return { outcome: "claimed", reason: `settle unreachable: ${errText(err)}` };
	}
	if (settle.status === 200) return { outcome: "settled" };
	await hygieneAbort(transferId, "transcript settle failed");
	const outcome = settle.status === 400 || settle.status === 404 ? "released" : "claimed";
	return { outcome, reason: `settle returned ${settle.status}` };
}
