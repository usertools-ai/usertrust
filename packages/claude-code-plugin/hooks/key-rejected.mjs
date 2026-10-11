// A server that REJECTS the session's key is a CONFIGURATION failure, not an outage, and the
// user is told so where Claude Code shows it: a hook's JSON `systemMessage`.
//
// Before this, PreToolUse turned a 401 into one more "unexpected governance response 401"
// gap, and its note went to stderr, which on exit 0 Claude Code keeps in its debug log only.
// The watch-mode breaker counts timeouts, and a 401 is an answer, so nothing escalated: a
// mistyped or rotated key stopped all metering, silently, for as long as nobody read
// watch.jsonl.
//
// What counts as a rejected key (`keyRejection`):
// - a 401, whatever its body: HTTP's own "not authenticated". usertrust-server answers every
//   route but /v1/health with `401 {"error":"unauthorized"}` for a missing or unknown key;
// - a 403 whose `error` is `unauthorized`, the same code, from a server or gateway that answers
//   a rejected key with 403. usertrust-server's own 403 is a POLICY refusal
//   (`{"error":"policy_denied"}`), a governance decision: it, and any other 403, stays a
//   `would_block`, as does a 402.
//
// What PreToolUse does with one, when the call proceeds (watch mode, or enforce with
// failOpen): a `gap` record with `"cause":"key-rejected"`, the HTTP `status`, and a reason of
// its own; the FIRST of a session also carries `detail` (the server, the key's hash, the
// server's answer). Every call still writes its record, compact after the first, so a job's
// coverage (job-log.mjs) still sees every unmetered call. And a notice (`noticeText`) on the
// first call of a session, then at most once per NOTICE_INTERVAL_MS. Enforce mode without
// failOpen blocks the call (exit 2), as it blocks any authorization that failed.
//
// SessionStart reads watch.jsonl, locally and bounded (`rejectedSinceLastStart`), and warns of
// the rejected calls recorded since the last session start.
//
// Deliberately NOT done: skipping the network after a rejection. A key fixed on the SERVER (its
// hash added back) cannot be seen without asking, so any skip strands a fixed key for its whole
// window, and asking costs one fast round trip: a rejection is an answer, never a timeout.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { settingName, settings } from "./config.mjs";
import {
	publishExclusive,
	sanitize,
	sanitizeReason,
	stateRoot,
	tenantBinding,
	watchLogPath,
	writeFileAtomic,
} from "./lib.mjs";

/** The `cause` of a gap whose call the server refused for its key. */
export const KEY_REJECTED = "key-rejected";

/**
 * The least time between two notices of one session: 10 minutes. Time, not a count of calls:
 * a count nags a busy session (hundreds of calls an hour) and goes quiet in a slow one, while a
 * clock gives every session the same cadence. The first notice is immediate; ten minutes is
 * short enough that a user who missed it, or scrolled past it, sees it again within a working
 * stretch, and at most six an hour never bury the session.
 */
export const NOTICE_INTERVAL_MS = 10 * 60_000;

/**
 * The most of watch.jsonl SessionStart reads: its last 1 MiB. A compact rejected-call record is
 * about 260 bytes, so 1 MiB holds about 4,000 of them, more than two days of a busy session;
 * reading and scanning it takes milliseconds, inside SessionStart's 5 s. The file is appended to
 * and never trimmed, so an unbounded read would grow without limit. Past the bound, the warning
 * says "at least".
 */
export const SINCE_READ_BYTES = 1024 * 1024;

/** The longest of the server's own text a detail record keeps. */
const MAX_DETAIL_CHARS = 200;

/** A call the server refused for its key: what PreToolUse throws, and what it records. */
export class KeyRejected extends Error {
	constructor(status, error, answer) {
		super(`the server rejected this key (${status})`);
		this.name = "KeyRejected";
		this.status = status;
		this.error = error;
		this.answer = answer;
	}
}

/**
 * The server's text as a record holds it, or undefined: control characters out first
 * (lib.mjs `sanitizeReason`), clipped after, as a `would_block` record's reason is.
 */
const serverText = (value) =>
	typeof value === "string" && value !== ""
		? sanitizeReason(value).slice(0, MAX_DETAIL_CHARS)
		: undefined;

/**
 * Whether an answer rejects the key: a `KeyRejected` for a 401, and for a 403 whose `error` is
 * `unauthorized`; otherwise null. `json` is the answer's body when it is an object.
 */
export function keyRejection(status, json) {
	if (status === 401 || (status === 403 && json?.error === "unauthorized")) {
		return new KeyRejected(status, serverText(json?.error), serverText(json?.reason));
	}
	return null;
}

/** Where watch.jsonl is, as a message may name it: a configured session's path is never echoed. */
function recordsAt() {
	return settings().configured ? "watch.jsonl in the config file's state dir" : watchLogPath();
}

/** The notice PreToolUse shows the user (through lib.mjs `announce`). */
export function noticeText(status) {
	return `usertrust: the server rejected this session's key (${status}): tool calls are NOT being metered. Check the key (${settingName("key")}); see ${recordsAt()}.`;
}

/** The detail the FIRST record of a session carries. */
export function rejectionDetail(err) {
	const { serverUrl, keyHash } = tenantBinding();
	return {
		server: serverUrl,
		keyHash,
		...(err.error === undefined ? {} : { error: err.error }),
		...(err.answer === undefined ? {} : { answer: err.answer }),
		fix: `the server does not accept this key: check ${settingName("key")}, and that the server holds the key's SHA-256 hash`,
	};
}

const noticeDir = () => join(stateRoot(), "key-rejected");

/** A session's notice state: <stateDir>/key-rejected/<session>.json, 0600, in a 0700 dir. */
export function sessionStatePath(sessionId) {
	return join(noticeDir(), `${sanitize(sessionId)}.json`);
}

/**
 * Note one rejected call of this session, and say whether it is the session's FIRST (its record
 * carries the detail) and whether to NOTIFY the user (the first, then once per
 * NOTICE_INTERVAL_MS). The first is decided by an exclusive create, so two calls at once never
 * both carry the detail; two calls at once just past the window may both notify, which is
 * harmless. State that is another server's or key's, or unreadable, starts afresh. State that
 * cannot be written at all notifies every time: never silent.
 */
export async function noteRejection(sessionId) {
	const path = sessionStatePath(sessionId);
	const now = Date.now();
	const here = tenantBinding();
	const fresh = JSON.stringify({
		v: 1,
		...here,
		firstAt: new Date(now).toISOString(),
		noticeAt: new Date(now).toISOString(),
	});
	try {
		await mkdir(noticeDir(), { recursive: true, mode: 0o700 });
		// Whole under a temp name, then link()ed to its name, which never replaces one (lib.mjs
		// `publishExclusive`): no reader ever finds the state half-written, and only one call of
		// a session wins the create. The temp goes either way.
		await publishExclusive(path, fresh, { mode: 0o600 });
		return { first: true, notify: true };
	} catch (err) {
		if (err?.code !== "EEXIST") return { first: true, notify: true };
	}
	let state = null;
	try {
		state = JSON.parse(await readFile(path, "utf-8"));
	} catch {
		// unreadable: started afresh below
	}
	const ours =
		state !== null &&
		typeof state === "object" &&
		state.serverUrl === here.serverUrl &&
		state.keyHash === here.keyHash;
	if (!ours) {
		await writeFileAtomic(path, fresh).catch(() => {});
		return { first: true, notify: true };
	}
	const last = Date.parse(state.noticeAt);
	// A notice "in the future" (a clock set back) is read as due, never as a reason to be silent.
	const due = !(now - last < NOTICE_INTERVAL_MS && last <= now);
	if (!due) return { first: false, notify: false };
	await writeFileAtomic(
		path,
		JSON.stringify({ ...state, noticeAt: new Date(now).toISOString() }),
	).catch(() => {});
	return { first: false, notify: true };
}

// ---------------------------------------------------------------------------------------------
// SessionStart: local only.

/**
 * What PreToolUse wrote for a 401 before rejected keys had a cause of their own: a `gap` with this
 * reason, no `cause` and no `phase` (other hooks' gaps carry one). Counted too, so the first start
 * after an upgrade warns of the rejections the install already had, and the mark never moves past
 * them unreported. 401 only: before, every 403 was a policy refusal by contract (a `would_block`,
 * never a gap), and a `would_block` was already a visible "would have blocked" record, not a
 * silent loss; reading a base-era refusal as a rejected key would rewrite what that version
 * decided.
 */
const LEGACY_REASON = "unexpected governance response 401";

/** Whether a watch record is a call the server rejected for its key, in either shape. */
function isRejectedCall(record) {
	if (record?.kind !== "gap") return false;
	if (record.cause === KEY_REJECTED) return true;
	return (
		record.cause === undefined && record.phase === undefined && record.reason === LEGACY_REASON
	);
}

/** SessionStart's mark: where watch.jsonl stood at the last session start. */
const markPath = () => join(noticeDir(), "session-start.mark");

/** The most a mark may be: a real one is under 100 bytes. A larger file is no mark. */
const MAX_MARK_BYTES = 4096;

/**
 * The mark, or null when there is none or it is unusable. Read as watch.jsonl is
 * (`readSince`): opened non-blocking, read only when it is a regular file, and only when it is
 * no larger than MAX_MARK_BYTES, so a FIFO, a directory or a huge file in its place can neither
 * hang the start nor slow it. Null reads watch.jsonl from its start: a repeated warning, never a
 * lost one.
 */
function readMark() {
	let fd;
	try {
		fd = openSync(markPath(), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch {
		return null;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_MARK_BYTES) return null;
		const buffer = Buffer.alloc(info.size);
		let read = 0;
		while (read < buffer.length) {
			const n = readSync(fd, buffer, read, buffer.length - read, read);
			if (n === 0) break;
			read += n;
		}
		const mark = JSON.parse(buffer.subarray(0, read).toString("utf-8"));
		return Number.isSafeInteger(mark?.offset) && mark.offset >= 0 ? mark : null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * The rejected calls recorded in watch.jsonl since the last session start, or null when there
 * are none or the file cannot be read. NEVER throws, never waits on anything but a bounded read
 * of a regular file:
 * - "Since the last session start" is the byte offset the last SessionStart read up to, kept in
 *   the mark (`markPath`) with the file's device and inode. A file that is not the one the mark
 *   names (deleted and made again), or is shorter than its offset, is read from its start, as is
 *   a state dir with no mark yet (the first start after an upgrade sees what came before it).
 *   An offset, not a time: immune to clock steps, and exact for concurrent appends.
 * - At most SINCE_READ_BYTES are read: the last ones. A read cut by that bound skips its first,
 *   partial line and reports the count as a lower bound (`atLeast`).
 * - The file is opened non-blocking and read only when it is a regular file, so a FIFO or a
 *   device in its place can never hang the start. Anything that goes wrong is null: the normal
 *   banner.
 * The mark is moved to the end of the last complete line read, so a line being appended now is
 * read whole at the next start.
 */
export async function rejectedSinceLastStart() {
	let found;
	try {
		found = readSince();
	} catch {
		return null;
	}
	if (found === null) return null;
	try {
		await mkdir(noticeDir(), { recursive: true, mode: 0o700 });
		await writeFileAtomic(
			markPath(),
			JSON.stringify({ v: 1, dev: found.dev, ino: found.ino, offset: found.offset }),
		);
	} catch {
		// Unmarked, the next start reads the same lines again: a repeated warning, never a lost one.
	}
	return found.count > 0 ? found : null;
}

function readSince() {
	let fd;
	try {
		fd = openSync(watchLogPath(), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch {
		return null;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) return null;
		const mark = readMark();
		const sameFile =
			mark !== null &&
			String(mark.dev) === String(info.dev) &&
			String(mark.ino) === String(info.ino) &&
			mark.offset <= info.size;
		const since = sameFile ? mark.offset : 0;
		const from = Math.max(since, info.size - SINCE_READ_BYTES);
		const buffer = Buffer.alloc(info.size - from);
		let read = 0;
		while (read < buffer.length) {
			const n = readSync(fd, buffer, read, buffer.length - read, from + read);
			if (n === 0) break;
			read += n;
		}
		const bytes = buffer.subarray(0, read);
		const cut = from > since;
		// Only complete lines, found by their newline BYTES (a cut can split a character): from
		// after the first newline when the bound cut into a line, to the last newline.
		const start = cut ? bytes.indexOf(0x0a) + 1 : 0;
		const end = bytes.lastIndexOf(0x0a) + 1;
		let count = 0;
		let firstMs = Number.POSITIVE_INFINITY;
		if (end > start) {
			for (const line of bytes.subarray(start, end).toString("utf-8").split("\n")) {
				if (!line.includes(KEY_REJECTED) && !line.includes(LEGACY_REASON)) continue;
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				if (!isRejectedCall(record)) continue;
				count += 1;
				const at = Date.parse(record.started ?? record.at);
				if (at < firstMs) firstMs = at;
			}
		}
		return {
			count,
			atLeast: cut,
			first: Number.isFinite(firstMs) ? new Date(firstMs).toISOString().slice(0, 10) : null,
			dev: String(info.dev),
			ino: String(info.ino),
			// The end of the last complete line read; nothing complete, where the read began.
			offset: from + end,
		};
	} finally {
		closeSync(fd);
	}
}

/** SessionStart's warning line for what `rejectedSinceLastStart` found. */
export function warningText(found) {
	const n = found.count.toLocaleString("en-US");
	const calls = found.count === 1 ? "tool call" : "tool calls";
	const verb = found.count === 1 ? "was" : "were";
	const since = found.first === null ? "" : ` since ${found.first}`;
	return `usertrust: WARNING: ${found.atLeast ? "at least " : ""}${n} ${calls}${since} ${verb} NOT metered (the server rejected the key). Check the key (${settingName("key")}); see ${recordsAt()}.`;
}
