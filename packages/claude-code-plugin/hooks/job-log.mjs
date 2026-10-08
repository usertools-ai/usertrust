// The job log: which job a Claude Code session is working on, and when it changed.
//
// A JOB is a label on spend, never a payer: it selects no wallet and prices
// nothing. It rides the audit records of the calls it labels (`job`, `usageFrom`,
// `usageTo`, `jobState`), so per-job cost is a query over the chain.
//
// THE LOG: <state>/jobs/<session_id>.jsonl (0600), append-only, one newline-
// terminated JSON object per line: { sid, ts, op, job }. `op` is `session-start`
// (written by the SessionStart hook, once, for a NEW session id), `start` or `stop`
// (written by `bin/usertrust-job.mjs`). `ts` is ISO with milliseconds on THIS
// machine's clock, which the hooks, the CLI and the transcript all share.
//
// A hook reads its OWN session's file on every call and resolves the job at the
// moment of the call or message (`resolveJob(...).at(t)`):
//  - never stale: nothing is cached across calls;
//  - no default: no open job means the field is ABSENT;
//  - a switch applies from the NEXT call: the call that runs `start job-b` itself
//    bills job-a, because its hook ran before the CLI wrote the line.
// An equal `ts` resolves to the EARLIER job (a line applies strictly AFTER its ts).
//
// VALID means: every complete line's `sid` is the session's; the first complete line
// is `session-start`; `ts` is non-decreasing; every `op` is known. An unterminated
// FINAL line is a write in progress and is ignored; INTERIOR corruption is invalid,
// and an invalid log is `jobState: "invalid"` on the records, never a guess.
//
// THE LOCK: <log>.lock, created O_CREAT|O_EXCL, holding { pid, ts }. EVERY writer
// (the CLI and the SessionStart hook) holds it only for read-last-validate-append,
// milliseconds, and NEVER while waiting or polling. A lock whose holder is dead, or
// that is older than 10 s, is broken: 10 s is far longer than any legitimate hold, so
// only a dead or wedged holder can be broken.
//
// Zero dependencies; reads and writes only the state dir.
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sanitize, stateRoot } from "./lib.mjs";

/** 1-128 of `[A-Za-z0-9._:-]`: usertrust core's `PRINCIPAL_FIELD_PATTERN`, pinned by a test. */
export const JOB_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const OPS = new Set(["session-start", "start", "stop"]);
/** A lock older than this is broken even if its holder's pid is alive. */
export const LOCK_STALE_MS = 10_000;
/** How long the CLI waits for the SessionStart line to land. */
export const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 250;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function jobsDir() {
	return join(stateRoot(), "jobs");
}

export function jobLogPath(sessionId) {
	return join(jobsDir(), `${sanitize(sessionId)}.jsonl`);
}

/**
 * Parse a log's text for `sessionId`. Returns { state: "none" } (nothing complete is
 * written yet), { state: "invalid", reason }, or { state: "ok", events, last } where
 * each event is { tsMs, ts, op, job }.
 */
export function parseJobLog(text, sessionId) {
	// The final fragment after the last newline is a write in progress: not corruption.
	const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
	const lines = complete.split("\n").slice(0, -1);
	if (lines.length === 0) return { state: "none" };
	const events = [];
	let lastMs = Number.NEGATIVE_INFINITY;
	for (const [i, line] of lines.entries()) {
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			return { state: "invalid", reason: `line ${i + 1} is not JSON` };
		}
		if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
			return { state: "invalid", reason: `line ${i + 1} is not an object` };
		}
		if (rec.sid !== sessionId)
			return { state: "invalid", reason: `line ${i + 1} names another session` };
		if (!OPS.has(rec.op)) return { state: "invalid", reason: `line ${i + 1} has an unknown op` };
		if (i === 0 && rec.op !== "session-start") {
			return { state: "invalid", reason: "the first line is not session-start" };
		}
		if (i > 0 && rec.op === "session-start") {
			return { state: "invalid", reason: `line ${i + 1} repeats session-start` };
		}
		if (
			typeof rec.ts !== "string" ||
			!ISO_UTC.test(rec.ts) ||
			!Number.isFinite(Date.parse(rec.ts)) ||
			// Canonical: Date.parse normalizes an impossible date (Feb 31 is Mar 3), so the
			// instant must print back as the very string the CLI wrote.
			new Date(Date.parse(rec.ts)).toISOString() !== rec.ts
		) {
			return { state: "invalid", reason: `line ${i + 1} has a bad ts` };
		}
		const tsMs = Date.parse(rec.ts);
		if (tsMs < lastMs) return { state: "invalid", reason: `line ${i + 1} is out of order` };
		if (rec.op === "start" && !(typeof rec.job === "string" && JOB_ID.test(rec.job))) {
			return { state: "invalid", reason: `line ${i + 1} has a bad job id` };
		}
		lastMs = tsMs;
		events.push({ tsMs, ts: rec.ts, op: rec.op, job: rec.op === "start" ? rec.job : null });
	}
	return { state: "ok", events, last: events[events.length - 1] };
}

/** The job open at `tMs`: every line applies strictly AFTER its own ts. */
export function jobAtEvents(events, tMs) {
	return openAtEvents(events, tMs)?.job ?? null;
}

/** The open job at `tMs` and the ts of the `start` that opened THIS interval of it, or null. */
export function openAtEvents(events, tMs) {
	let open = null;
	for (const e of events) {
		if (!(e.tsMs < tMs)) break;
		if (e.op === "start") open = { job: e.job, since: e.ts };
		else if (e.op === "stop") open = null;
	}
	return open;
}

/**
 * The labels a record at `tMs` carries, from a parsed log: {} (no log, or no open
 * job), { job }, or { jobState: "invalid" } (a log that cannot be trusted, or a time
 * that cannot be read).
 */
export function labelsAt(parsed, tMs) {
	if (parsed.state === "none") return {};
	if (parsed.state === "invalid") return { jobState: "invalid" };
	if (!Number.isFinite(tMs)) return { jobState: "invalid" };
	const job = jobAtEvents(parsed.events, tMs);
	return job === null ? {} : { job };
}

/** Read this session's log NOW (never cached) and return its resolver. */
export async function resolveJob(sessionId) {
	let parsed;
	try {
		parsed = parseJobLog(await readFile(jobLogPath(sessionId), "utf-8"), sessionId);
	} catch (err) {
		parsed =
			err?.code === "ENOENT" ? { state: "none" } : { state: "invalid", reason: "unreadable" };
	}
	return {
		parsed,
		/** Labels for a call or message at epoch-ms `tMs`. */
		at: (tMs) => labelsAt(parsed, tMs),
		/**
		 * The ts (epoch ms) of the first `start` or `stop` at or after `tMs`, or null: where a job's
		 * call ends. AT, not just after: a line applies strictly after its own ts, so one written in
		 * the very millisecond a call began still leaves that call with the earlier job, and its
		 * window must end there.
		 */
		boundaryAfter: (tMs) => {
			if (parsed.state !== "ok") return null;
			const next = parsed.events.find((e) => e.op !== "session-start" && e.tsMs >= tMs);
			return next === undefined ? null : next.tsMs;
		},
		/**
		 * What may share one settle or one per-call hold: the labels AND the interval. A job
		 * that is stopped and started again (a, b, a) has two intervals, and a window that
		 * spanned both would span the other job's, which no coverage check could place.
		 */
		keyAt: (tMs) => {
			if (parsed.state === "none") return "none";
			if (parsed.state === "invalid" || !Number.isFinite(tMs)) return "invalid";
			const open = openAtEvents(parsed.events, tMs);
			if (open !== null) return `job:${open.job}@${open.since}`;
			// Unlabelled time is keyed by the line that began it: the stretch before `start a`
			// and the one after `stop` are two stretches, and a window spanning both would span
			// job a.
			const began = parsed.events.filter((e) => e.tsMs < tMs).at(-1);
			return `none@${began?.ts ?? ""}`;
		},
	};
}

// ── The lock ──

function pidAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/** How long a lock whose metadata was never completed may exist before it is broken. */
export const UNFINISHED_LOCK_MS = 2_000;

async function breakIfStale(lock) {
	let text;
	let mtimeMs;
	try {
		text = await readFile(lock, "utf-8");
		mtimeMs = (await stat(lock)).mtimeMs;
	} catch {
		return; // gone already: the next attempt takes it
	}
	let holder = null;
	try {
		holder = JSON.parse(text);
	} catch {
		// A writer that died between creating the lock and writing its metadata leaves an
		// empty or partial file. It has no pid or ts to judge, so its AGE decides, after a
		// short grace for a writer that is only now writing it.
	}
	const complete = holder !== null && Number.isFinite(holder.ts) && Number.isFinite(holder.pid);
	const stale = complete
		? !pidAlive(holder.pid) || Date.now() - holder.ts > LOCK_STALE_MS
		: Date.now() - mtimeMs > UNFINISHED_LOCK_MS;
	if (!stale) return;
	// Re-read: break only the lock we judged, never one taken since.
	try {
		if ((await readFile(lock, "utf-8")) === text) await unlink(lock);
	} catch {
		// raced: fine
	}
}

/** Run `fn` holding `<log>.lock`; the lock is for read-validate-append ONLY. */
export async function withLock(log, fn, { maxWaitMs = 5_000 } = {}) {
	const lock = `${log}.lock`;
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		let handle;
		try {
			handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			await breakIfStale(lock);
			if (Date.now() > deadline) throw new Error("the job log's lock is held");
			await sleep(10 + Math.floor(Math.random() * 15));
			continue;
		}
		try {
			await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
		} finally {
			await handle.close();
		}
		try {
			return await fn();
		} finally {
			await unlink(lock).catch(() => {});
		}
	}
}

async function readParsed(log, sessionId) {
	try {
		const text = await readFile(log, "utf-8");
		return { ...parseJobLog(text, sessionId), text };
	} catch (err) {
		if (err?.code === "ENOENT") return { state: "none", absent: true };
		throw err;
	}
}

function appendLine(log, rec) {
	// O_APPEND, 0600, fsync'd: a reader never sees a half-line as a whole one.
	const fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
	try {
		writeSync(fd, `${JSON.stringify(rec)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * SessionStart's write. `startup`, `clear` and `fork` mint a NEW session id, so the
 * log is absent and gets its `session-start`. `resume` and `compact` keep an
 * existing id: they write NOTHING, so neither ever ends or invalidates an open job.
 * Returns what it did.
 */
export async function writeSessionStart(sessionId, source) {
	if (!["startup", "clear", "fork"].includes(source)) return "skipped";
	if (typeof sessionId !== "string" || sessionId === "") return "skipped";
	const log = jobLogPath(sessionId);
	await mkdir(jobsDir(), { recursive: true, mode: 0o700 });
	return withLock(log, async () => {
		const parsed = await readParsed(log, sessionId);
		// A new id has no log. One that does (impossible for a new id) is left alone.
		if (!parsed.absent) return "present";
		appendLine(log, {
			sid: sessionId,
			ts: new Date(Date.now()).toISOString(),
			op: "session-start",
			job: null,
		});
		return "written";
	});
}

/**
 * The CLI's write. The log must ALREADY exist with the plugin's `session-start` for
 * this session id: the CLI never mints one, because a log minted for an id the plugin
 * never started is exactly the resume-without-id file this refuses.
 *
 * It POLLS WITHOUT THE LOCK (the SessionStart writer takes the same lock, so holding
 * it while waiting would block the very writer it waits for), then takes the lock only
 * for the final re-verify and append. Returns { ok: true, ts } or { ok: false, reason }.
 */
export async function appendJobOp(sessionId, op, job, { waitMs = DEFAULT_WAIT_MS } = {}) {
	const log = jobLogPath(sessionId);
	const deadline = Date.now() + waitMs;
	for (;;) {
		const seen = await readParsed(log, sessionId).catch(() => ({ state: "none" }));
		if (seen.state === "ok") break;
		if (seen.state === "invalid")
			return { ok: false, reason: `the job log is invalid (${seen.reason})` };
		if (Date.now() >= deadline) {
			return {
				ok: false,
				reason:
					"no job log for this session id — if this session was resumed without an explicit id, the env id may be the startup id; resume with --resume <id>",
			};
		}
		await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
	}
	return withLock(log, async () => {
		const parsed = await readParsed(log, sessionId);
		if (parsed.state !== "ok") {
			return { ok: false, reason: "the job log changed while it was being written" };
		}
		// An unterminated tail is a fragment a crashed writer left: nothing acknowledged it,
		// and (holding the lock) no live writer is producing it. Cut it off, or this line
		// would be glued onto it into a malformed COMPLETE line that invalidates the session.
		if (!parsed.text.endsWith("\n")) {
			const keep = Buffer.byteLength(parsed.text.slice(0, parsed.text.lastIndexOf("\n") + 1));
			await truncate(log, keep);
		}
		const open = jobAtEvents(parsed.events, Number.POSITIVE_INFINITY);
		if (op === "stop" && open === null) return { ok: true, noop: true, ts: parsed.last.ts };
		const tsMs = Math.max(Date.now(), parsed.last.tsMs);
		const ts = new Date(tsMs).toISOString();
		appendLine(log, { sid: sessionId, ts, op, job: op === "start" ? job : null });
		return { ok: true, ts, replaced: op === "start" && open !== null ? open : null };
	});
}

// ── Coverage: is a job's cost EXACT? ──
//
// ONE answer path for "exact": the lab's aggregator calls this, it does not
// re-implement it. Absence of evidence is never exact.

/** A record's session: from its principal's origin (`claude-code:<sid>`) or its actor. */
export function sessionOfRecord(rec) {
	const data = rec?.data ?? {};
	const origin = data.principal?.origin;
	if (typeof origin === "string" && origin.startsWith("claude-code:")) {
		return origin.slice("claude-code:".length);
	}
	const actor = rec?.actor;
	if (typeof actor === "string" && actor.startsWith("claude-code:")) {
		return actor.split(":")[1] ?? null;
	}
	return null;
}

/** [startMs, endMs] intervals of `job` in a parsed log; an unclosed one ends at +Infinity. */
export function intervalsOf(parsed, job) {
	const out = [];
	let startMs = null;
	for (const e of parsed.events) {
		const closes = e.op === "stop" || (e.op === "start" && e.job !== job);
		if (startMs !== null && (closes || e.op === "start")) {
			out.push([startMs, e.tsMs]);
			startMs = null;
		}
		if (e.op === "start" && e.job === job) startMs = e.tsMs;
	}
	if (startMs !== null) out.push([startMs, Number.POSITIVE_INFINITY]);
	return out;
}

/** Records that are spend's own bookkeeping or a give-back: no usage hides behind them. */
/** Records that say a charge happened or was attempted, and so need their llm_call. */
const SPEND_METADATA = new Set(["settlement_ambiguous", "settlement_shortfall", "llm_call_failed"]);

const BENIGN_KINDS = new Set(["hold_released", "settlement_ambiguous", "settlement_shortfall"]);

const ms = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/**
 * Whether `job`'s recorded cost is EXACT, and why not.
 *
 *   jobCoverage({ job, logs: { <sid>: <log text> }, records: [<audit event>, ...] })
 *     → { exact, reasons: [...], transferIds: [...], costUt: <integer string> }
 *
 * EXACT iff, for EVERY (session, open interval) of the job — taken from THAT
 * session's own validated log, from its `start` to its `stop`, its implicit stop (the
 * next `start`) or the session's end:
 *  - at least ONE record of the session carries `job` with its COMPLETE
 *    [usageFrom, usageTo] inside the interval (an empty interval proves nothing, and a
 *    window with an end missing proves nothing about where it ended);
 *  - EVERY `llm_call` record of the session whose [usageFrom, usageTo] overlaps the
 *    interval carries `job`; none carries `jobState: "invalid"`; and none lacks a
 *    complete usage window (an unknown end could reach into the interval), in a
 *    session that records usage times at all.
 * And every session with a record of the job has a usable log of its own: a session
 * whose log is missing, unreadable or invalid is not exact. A record's APPEND time is
 * never read.
 *
 * The cost counts each TRANSFER once, from its `llm_call`: the job rides every record a
 * hold produces, and a failed ledger POST leaves a `settlement_ambiguous` beside the
 * `llm_call` for the same transfer and cost.
 */
export function jobCoverage({ job, logs, records, watch = [] }) {
	const reasons = [];
	const why = (text) => reasons.push(text);

	// ── Evidence: the logs, the intervals, the cost ──
	// A session's log is USABLE when it was supplied and parses as valid. Everything that
	// places an event in time goes through a usable log of the event's OWN session.
	const parsedLogs = new Map();
	for (const [sid, text] of Object.entries(logs ?? {})) parsedLogs.set(sid, parseJobLog(text, sid));
	const usable = (sid) => parsedLogs.get(sid)?.state === "ok";
	const intervalsBySession = new Map();
	const allIntervals = [];
	for (const [sid, parsed] of parsedLogs) {
		if (parsed.state === "invalid" && logs[sid].includes(`"${job}"`)) {
			why(`session ${sid}: the job log is invalid (${parsed.reason})`);
		}
		if (parsed.state !== "ok") continue;
		const intervals = intervalsOf(parsed, job);
		intervalsBySession.set(sid, intervals);
		for (const interval of intervals) allIntervals.push(interval);
	}

	const transferCost = new Map();
	const byTransfer = new Map();
	for (const rec of records) {
		if (rec?.data?.job !== job) continue;
		const id = rec.data.transferId;
		if (typeof id !== "string") {
			why(`a record of ${job} names no transfer`);
			continue;
		}
		if (!transferCost.has(id)) transferCost.set(id, null);
		const seen = byTransfer.get(id) ?? { calls: 0, spendish: 0 };
		byTransfer.set(id, seen);
		if (SPEND_METADATA.has(rec.kind)) seen.spendish += 1;
		if (rec.kind !== "llm_call") continue;
		seen.calls += 1;
		const cost = rec.data.cost;
		if (Number.isSafeInteger(cost) && cost >= 0) transferCost.set(id, BigInt(cost));
		else why(`the llm_call of a record of ${job} has no integer cost`);
	}
	// Clause 3: every transfer seen through spend METADATA (a shortfall, an ambiguous
	// settlement, a failed call) is joined to EXACTLY ONE llm_call. Costing a transfer that has
	// none as zero would let a posted-but-unrecorded spend certify at 0. A transfer that was
	// only given back (hold_released) spent nothing and needs no llm_call.
	for (const [id, seen] of byTransfer) {
		if (seen.calls > 1)
			why(`transfer ${id} of ${job} has ${seen.calls} llm_calls: one charge, one record`);
		else if (seen.calls === 0 && seen.spendish > 0) {
			why(
				`transfer ${id} of ${job} is known only through its settlement metadata: its cost is unrecorded`,
			);
		}
	}
	let costUt = 0n;
	for (const cost of transferCost.values()) costUt += cost ?? 0n;

	const bySession = new Map();
	for (const rec of records) {
		const sid = sessionOfRecord(rec);
		if (sid === null) continue;
		if (!bySession.has(sid)) bySession.set(sid, []);
		bySession.get(sid).push(rec);
	}
	const window = (data) => {
		const f = ms(data?.usageFrom);
		const t = ms(data?.usageTo);
		return Number.isFinite(f) && Number.isFinite(t) && f <= t ? [f, t] : null;
	};
	// An interval is (start, stop]: a line applies strictly AFTER its own ts, so usage at
	// exactly the start belongs to the earlier job and usage at exactly the stop to this one.
	const insideAny = (w, intervals) => intervals.some(([from, to]) => w[0] > from && w[1] <= to);
	const overlapsAny = (w, intervals) => intervals.some(([from, to]) => w[0] <= to && w[1] > from);

	// ── Clause 1: EVERY record tagged with the job lies inside an interval of the job in a
	// valid log of its own session. A session with no interval of the job puts all of its
	// tagged records outside; so does a session with no usable log. ──
	for (const rec of records) {
		if (rec?.data?.job !== job) continue;
		if (["policy_denied", "ledger_rejected"].includes(rec.kind)) {
			// A REFUSED request leaves no spend record: the usage it asked to post is NOT in
			// the total, and the denial carries the job, which is all that is known.
			why(`a request of ${job} was denied: its usage may be unrecorded`);
			continue;
		}
		const sid = sessionOfRecord(rec);
		if (sid === null) {
			why(`a record of ${job} names no session`);
			continue;
		}
		if (!usable(sid)) {
			why(`session ${sid}: a record of ${job} has no usable job log to be placed by`);
			continue;
		}
		const intervals = intervalsBySession.get(sid) ?? [];
		if (intervals.length === 0) {
			why(
				`session ${sid}: a ${rec.kind} of ${job} lies outside its intervals (the session has none)`,
			);
			continue;
		}
		const w = rec.kind === "llm_call" ? window(rec.data) : null;
		const point = ms(rec.data.usageFrom);
		const placed =
			rec.kind === "llm_call"
				? w !== null && insideAny(w, intervals)
				: Number.isFinite(point) && insideAny([point, point], intervals);
		if (!placed) why(`session ${sid}: a ${rec.kind} of ${job} lies outside its intervals`);
	}

	// Every interval needs POSITIVE evidence: a tagged record with a complete window in it.
	let intervalsSeen = 0;
	for (const [sid, intervals] of intervalsBySession) {
		const mine = bySession.get(sid) ?? [];
		for (const [from, to] of intervals) {
			intervalsSeen += 1;
			const tagged = mine.some((r) => {
				const w = window(r?.data);
				return r?.data?.job === job && w !== null && w[0] > from && w[1] <= to;
			});
			if (!tagged) why(`session ${sid}: no record of ${job} inside [${from}, ${to}]`);
		}
	}
	if (intervalsSeen === 0) why(`no session log has an interval of ${job}`);

	// ── Clause 2: every event whose time could fall in the job's intervals is POSITIVELY
	// attributed elsewhere, through a valid log of its own session. One that cannot be
	// resolved could belong to the job, so it makes the job inexact. ──
	for (const [sid, mine] of bySession) {
		const capable = mine.some((r) => typeof r?.data?.usageFrom === "string");
		const intervals = intervalsBySession.get(sid) ?? [];
		for (const r of mine) {
			if (r?.data?.job === job) continue; // clause 1 judged it
			if (BENIGN_KINDS.has(r?.kind)) continue;
			const isCall = r?.kind === "llm_call";
			const w = isCall ? window(r.data) : null;
			const point = ms(r?.data?.usageFrom);
			if (!usable(sid)) {
				// Nothing can place it: only its own claim, which proves nothing. Whatever it is,
				// if its time could reach the job's intervals, or is unknown, it may be the job's.
				const span = isCall ? w : Number.isFinite(point) ? [point, point] : null;
				if (span === null || overlapsAny(span, allIntervals)) {
					why(
						`session ${sid}: a ${r?.kind} cannot be placed (no usable job log): it may belong to ${job}`,
					);
				}
				continue;
			}
			if (!isCall) {
				// DENY BY DEFAULT: a record of a kind this check cannot read as spend or as a
				// harmless give-back (a denial, a failure, anything new) inside an interval may
				// stand for usage that is not in the total, whatever labels it carries or lacks.
				if (!Number.isFinite(point) ? capable : insideAny([point, point], intervals)) {
					why(`session ${sid}: a ${r?.kind} record lies in an interval of ${job}`);
				}
				continue;
			}
			if (w === null) {
				if (capable) why(`session ${sid}: an llm_call has no complete usage window`);
				continue;
			}
			if (!overlapsAny(w, intervals)) continue; // positively attributed elsewhere
			if (r.data?.jobState === "invalid") {
				why(`session ${sid}: an llm_call in the interval has an invalid job state`);
			} else if (r.data?.job === undefined) {
				why(`session ${sid}: an llm_call in the interval carries no job`);
			} else {
				why(`session ${sid}: an llm_call in the interval carries another job`);
			}
		}
	}

	// The plugin's own watch records (`watch.jsonl`), when supplied: a `would_block` is usage
	// that was refused and a `gap` is a call that ran UNMETERED, so neither is in the total.
	// Such an event stops being a problem for the job ONLY when positively attributed to
	// something else through a valid log of its own session (the job open when its call
	// STARTED is not this one, or none is). One that cannot be resolved (no session, an
	// unreadable time, no usable log) could belong to ANY job, so it makes every job
	// inexact; its own label proves nothing, and neither does its lack of one.
	for (const w of watch) {
		if (w?.kind === "unreadable") {
			why("the watch records are unreadable: gaps and refusals cannot be ruled out");
			continue;
		}
		if (w?.kind !== "gap" && w?.kind !== "would_block") continue;
		if (w.kind === "would_block" && w.job === job) {
			why(`a request of ${job} was refused (would_block): its usage is unrecorded`);
			continue;
		}
		const sid = typeof w.session === "string" ? w.session : null;
		const t = ms(w.started ?? w.at);
		let unresolved = null;
		if (sid === null) unresolved = "it names no session";
		else if (!Number.isFinite(t)) unresolved = "its time is unreadable";
		else if (!Object.hasOwn(logs ?? {}, sid)) unresolved = `session ${sid} has no job log`;
		else if (!usable(sid)) unresolved = `session ${sid} has no usable job log`;
		else if (jobAtEvents(parsedLogs.get(sid).events, t) === job) {
			why(`session ${sid}: a ${w.kind} fell inside an interval of ${job}`);
		}
		if (unresolved !== null) {
			why(`a ${w.kind} cannot be attributed to a job (${unresolved}): it may belong to ${job}`);
		}
	}

	return {
		exact: reasons.length === 0,
		reasons: [...new Set(reasons)],
		transferIds: [...transferCost.keys()],
		costUt: String(costUt),
	};
}

/** Every session log under `dir`, as { sid: text } (read-only). */
export async function readLogs(dir) {
	const out = {};
	for (const name of await readdir(dir).catch(() => [])) {
		if (!name.endsWith(".jsonl")) continue;
		out[name.slice(0, -".jsonl".length)] = await readFile(join(dir, name), "utf-8").catch(() => "");
	}
	return out;
}
