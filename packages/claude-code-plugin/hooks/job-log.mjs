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
// ORDER IS POSITION, not the clock: lines are applied in file order, and a line's effective
// time is the running maximum of the stamps so far, so a stamp that runs backwards (concurrent
// appenders can differ by a few ms) can never place a `start` before a line that precedes it.
//
// VALID means: every line's `sid` is the session's; the first line is `session-start` and
// no other is; every `op` is known; `start` names a valid job id. A line that is not JSON, or
// a last line with no newline (a torn line), makes the log INVALID: `jobState: "invalid"` on
// the records and a named gap in coverage, never a guess. NOTHING here repairs, truncates or
// reorders a log: the reader is the authority and it only reads.
//
// NO LOCK: every writer appends ONE complete line with ONE write to a file opened O_APPEND
// (see "Writing" below).
//
// Zero dependencies; reads and writes only the state dir.
import { constants } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitize, stateRoot } from "./lib.mjs";

/** 1-128 of `[A-Za-z0-9._:-]`: usertrust core's `PRINCIPAL_FIELD_PATTERN`, pinned by a test. */
export const JOB_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A stamp this far behind the line before it is a clock step, not two appenders racing. */
export const CLOCK_STEP_MS = 1_000;
/** The reason of a log whose last line was cut short. */
export const TORN_REASON = "the last line is torn (it has no newline)";
/** How long a hook waits before it reads a torn log once more. */
export const TORN_RECHECK_MS = 40;
const OPS = new Set(["session-start", "start", "stop"]);
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
	if (text === "") return { state: "none" };
	// Every writer appends ONE complete line in one write, so a final fragment with no newline
	// is not a write in progress: it is a line that was cut short (a crash, a full disk). The
	// reader never repairs a log, and never ignores such a line: the log is INVALID.
	if (!text.endsWith("\n")) {
		return { state: "invalid", reason: TORN_REASON };
	}
	const lines = text.split("\n").slice(0, -1);
	const events = [];
	// Order is POSITION. A line's effective time is the running maximum of the stamps so far,
	// so a stamp that runs backwards (a clock step, a late writer) cannot place a `start` before
	// a line that precedes it in the file.
	let effectiveMs = Number.NEGATIVE_INFINITY;
	// Lines whose stamp ran BACKWARDS by more than a benign inversion between concurrent
	// appenders: the clock stepped, and attribution around them is uncertain.
	const clockSteps = [];
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
		const rawMs = Date.parse(rec.ts);
		if (effectiveMs - rawMs > CLOCK_STEP_MS) {
			clockSteps.push({
				line: i + 1,
				rawMs,
				effectiveMs,
				bySeconds: Math.round((effectiveMs - rawMs) / 1000),
			});
		}
		const tsMs = Math.max(rawMs, effectiveMs);
		if (rec.op === "start" && !(typeof rec.job === "string" && JOB_ID.test(rec.job))) {
			return { state: "invalid", reason: `line ${i + 1} has a bad job id` };
		}
		effectiveMs = tsMs;
		events.push({
			index: i,
			tsMs,
			ts: rec.ts,
			op: rec.op,
			job: rec.op === "start" ? rec.job : null,
		});
	}
	return { state: "ok", events, last: events[events.length - 1], clockSteps };
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
		if (e.op === "start") open = { job: e.job, since: e.index };
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
	const read = async () => {
		try {
			return parseJobLog(await readFile(jobLogPath(sessionId), "utf-8"), sessionId);
		} catch (err) {
			return err?.code === "ENOENT"
				? { state: "none" }
				: { state: "invalid", reason: "unreadable" };
		}
	};
	let parsed = await read();
	// A torn last line may be an append in flight on a filesystem that does not make a write
	// atomic for readers: look once more after a short pause. If it is still torn, THIS call's
	// job is unknown (`jobState: "invalid"`, a gap downstream). The file is never touched, and
	// the next call reads it afresh, so a transient tear cannot poison the session.
	if (parsed.state === "invalid" && parsed.reason === TORN_REASON) {
		await sleep(TORN_RECHECK_MS);
		parsed = await read();
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
			// Keyed by POSITION (the opening line's index), not its stamp: after a clock step two
			// intervals of one job can carry the same raw stamp.
			if (open !== null) return `job:${open.job}#${open.since}`;
			// Unlabelled time is keyed by the line that began it: the stretch before `start a`
			// and the one after `stop` are two stretches, and a window spanning both would span
			// job a.
			const began = parsed.events.filter((e) => e.tsMs < tMs).at(-1);
			return `none#${began?.index ?? ""}`;
		},
	};
}

// ── Writing: ONE append of ONE complete line, no lock ──
//
// Every writer appends a single small line with one `write` to a file opened O_APPEND: POSIX
// places each such write at the end of the file atomically on a local filesystem, so two
// concurrent writers interleave WHOLE lines and never bytes. There is no lock, no sentinel and
// no age rule to get wrong. Order is the line's POSITION in the file (see `parseJobLog`), not
// its clock. The reader is the authority on validity, and nothing here repairs a log.
// (Declared residual: a non-local filesystem, e.g. NFS, where O_APPEND is not atomic.)

async function readParsed(log, sessionId) {
	try {
		const text = await readFile(log, "utf-8");
		return { ...parseJobLog(text, sessionId), text };
	} catch (err) {
		if (err?.code === "ENOENT") return { state: "none", absent: true };
		throw err;
	}
}

/** Append `rec` as one complete line, in one write (no fsync: only SessionStart's line is synced). */
async function appendLine(log, rec) {
	await appendFile(log, `${JSON.stringify(rec)}\n`, { flag: "a", mode: 0o600 });
}

/**
 * SessionStart's write. `startup`, `clear` and `fork` mint a NEW session id, so the log is
 * absent and gets its `session-start`: created O_EXCL, so exactly one creator wins, and the
 * line is written by that creator in one write. `resume` and `compact` keep an existing id:
 * they write NOTHING, so neither ever ends or invalidates an open job. Returns what it did.
 */
export async function writeSessionStart(sessionId, source) {
	if (!["startup", "clear", "fork"].includes(source)) return "skipped";
	if (typeof sessionId !== "string" || sessionId === "") return "skipped";
	const log = jobLogPath(sessionId);
	await mkdir(jobsDir(), { recursive: true, mode: 0o700 });
	let handle;
	try {
		handle = await open(
			log,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND,
			0o600,
		);
	} catch (err) {
		// A new id has no log. One that does (impossible for a new id) is left alone.
		if (err?.code === "EEXIST") return "present";
		throw err;
	}
	try {
		await handle.write(
			`${JSON.stringify({
				sid: sessionId,
				ts: new Date(Date.now()).toISOString(),
				op: "session-start",
				job: null,
			})}\n`,
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return "written";
}

/**
 * The CLI's write. The log must ALREADY exist with the plugin's `session-start` for this
 * session id: the CLI never mints one, because a log minted for an id the plugin never
 * started is exactly the resume-without-id file this refuses. It polls for that line (a
 * friendly refusal; nothing correct depends on it), then appends ONE line. Returns
 * { ok: true, ts } or { ok: false, reason }.
 */
export async function appendJobOp(sessionId, op, job, { waitMs = DEFAULT_WAIT_MS } = {}) {
	const log = jobLogPath(sessionId);
	const deadline = Date.now() + waitMs;
	let seen;
	let rechecked = false;
	for (;;) {
		seen = await readParsed(log, sessionId).catch(() => ({ state: "none" }));
		if (seen.state === "ok") break;
		if (seen.state === "invalid" && seen.reason === TORN_REASON && !rechecked) {
			// Possibly another writer's append in flight: look once more before refusing.
			rechecked = true;
			await sleep(TORN_RECHECK_MS);
			continue;
		}
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
	const open = jobAtEvents(seen.events, Number.POSITIVE_INFINITY);
	if (op === "stop" && open === null) return { ok: true, noop: true, ts: seen.last.ts };
	const ts = new Date(Date.now()).toISOString();
	await appendLine(log, { sid: sessionId, ts, op, job: op === "start" ? job : null });
	return { ok: true, ts, replaced: op === "start" && open !== null ? open : null };
}

// ── Coverage: what the evidence does NOT cover ──
//
// A DIAGNOSTIC, not a certification. It reports the job's tagged cost and a list of KNOWN GAPS:
// named reasons the figure may be incomplete, each with the evidence behind it. An empty list
// means only that none of the checks below found anything; it does not mean the figure is
// complete, and nothing here may be read, printed or relabelled as such. A certified per-job
// cost needs a scope decision (which sessions could hold the job?) that is not made here.

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

/** Records that stand for spend or a refusal of it, so they matter even with no session. */
const SPEND_LIKE = new Set([
	"settlement_ambiguous",
	"settlement_shortfall",
	"llm_call_failed",
	"policy_denied",
	"ledger_rejected",
]);

const BENIGN_KINDS = new Set(["hold_released", "settlement_ambiguous", "settlement_shortfall"]);

const ms = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/**
 * The job's tagged cost, and the KNOWN GAPS in the evidence behind it.
 *
 *   jobCoverage({ job, logs: { <sid>: <log text> }, records: [<audit event>, ...],
 *                 watch: [<watch record>, ...], unreadable: { audit, watch } })
 *     → { job, diagnostic: true, note, taggedCostUt: <integer string>, transferIds: [...],
 *         knownGaps: [{ gap, evidence }] }
 *
 * This is NOT a certification. Every check below is a known-gap GENERATOR, a way the figure
 * can be seen to be incomplete; finding none proves nothing about what no check was written
 * for. The generators fall into three groups, reconciled against the job's intervals (from
 * the `start` to the `stop`, an implicit stop, or none yet) in each session's own validated
 * log; an interval is (start, stop]:
 *  1. every record TAGGED with the job lies inside an interval of the job in a valid log of
 *     its own session, with a complete usage window (a session with no interval of the job,
 *     or no usable log, puts all its tagged records outside);
 *  2. every gap, `would_block`, untagged call or unrecognised record whose time could fall in
 *     an interval is positively placed elsewhere through a valid log of its own session
 *     (an unresolvable event is a gap for every job: the set it could belong to is unbounded);
 *  3. every transfer is joined to exactly one `llm_call`, and a hold given back without a
 *     structured `releaseClass: "unused"` is a released hold whose usage is unconfirmed.
 * Plus: an interval with no stop yet (the job is still running), an evidence line that could
 * not be parsed, a missing or invalid log, a denied request of the job.
 * A record's APPEND time is never read.
 */
export function jobCoverage({ job, logs, records, watch = [], unreadable = {} }) {
	const knownGaps = [];
	const why = (text, evidence = {}) => knownGaps.push({ gap: text, evidence });

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
			why(`session ${sid}: the job log is invalid (${parsed.reason})`, { session: sid });
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
		const seen = byTransfer.get(id) ?? { calls: 0, spendish: 0, released: [] };
		byTransfer.set(id, seen);
		if (SPEND_METADATA.has(rec.kind)) seen.spendish += 1;
		if (rec.kind === "hold_released") seen.released.push(rec.data.releaseClass);
		if (rec.kind !== "llm_call") continue;
		seen.calls += 1;
		const cost = rec.data.cost;
		if (Number.isSafeInteger(cost) && cost >= 0) transferCost.set(id, BigInt(cost));
		else why(`the llm_call of a record of ${job} has no integer cost`);
	}
	// Clause 3: every transfer seen through spend METADATA (a shortfall, an ambiguous
	// settlement, a failed call) is joined to EXACTLY ONE llm_call. Costing a transfer that has
	// none as zero would let a posted-but-unrecorded spend certify at 0. A transfer that was
	// only given back (hold_released) needs no llm_call ONLY with POSITIVE proof that no usage
	// happened: a structured `releaseClass: "unused"` the client derived from its own hold
	// state. The free-text reason never proves it, and neither does a release that states no
	// class (a TTL expiry, a shutdown, an older client): the call may have run and gone
	// uncharged.
	for (const [id, seen] of byTransfer) {
		if (seen.calls > 1)
			why(`transfer ${id} of ${job} has ${seen.calls} llm_calls: one charge, one record`, {
				transferId: id,
				llmCalls: seen.calls,
			});
		else if (seen.calls === 0 && seen.spendish > 0) {
			why(
				`transfer ${id} of ${job} is known only through its settlement metadata: its cost is unrecorded`,
				{ transferId: id },
			);
		} else if (seen.calls === 0) {
			for (const cls of seen.released) {
				if (cls !== "unused") {
					why(
						`transfer ${id} of ${job} was released without proof that no usage happened (releaseClass ${cls ?? "none"})`,
						{ transferId: id, releaseClass: cls ?? null },
					);
				}
			}
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

	// A transfer is ONE charge. If llm_calls name it under two jobs (or twice), it sits in each
	// job's total: a gap for every job that names it, found across ALL records before any
	// filtering by job.
	const callsByTransfer = new Map();
	for (const r of records) {
		if (r?.kind !== "llm_call" || typeof r?.data?.transferId !== "string") continue;
		const entry = callsByTransfer.get(r.data.transferId) ?? { n: 0, jobs: new Set() };
		entry.n += 1;
		entry.jobs.add(r.data.job ?? null);
		callsByTransfer.set(r.data.transferId, entry);
	}
	for (const [id, entry] of callsByTransfer) {
		if (entry.jobs.size > 1 && entry.jobs.has(job)) {
			why(`transfer ${id} is attributed to multiple jobs: its cost sits in more than one total`, {
				transferId: id,
				jobs: [...entry.jobs].map((j) => j ?? null),
			});
		}
	}

	// ── Clause 1: EVERY record tagged with the job lies inside an interval of the job in a
	// valid log of its own session. A session with no interval of the job puts all of its
	// tagged records outside; so does a session with no usable log. ──
	for (const rec of records) {
		if (rec?.data?.job !== job) continue;
		if (["policy_denied", "ledger_rejected"].includes(rec.kind)) {
			// A REFUSED request leaves no spend record: the usage it asked to post is NOT in
			// the total, and the denial carries the job, which is all that is known.
			why(`a request of ${job} was denied: its usage may be unrecorded`, {
				kind: rec.kind,
				transferId: rec.data.transferId,
			});
			continue;
		}
		if (rec.kind !== "llm_call" && !BENIGN_KINDS.has(rec.kind) && !SPEND_METADATA.has(rec.kind)) {
			// A kind this check cannot read as spend or as a give-back, naming the job: it may be
			// usage that is not in the total.
			why(`an unrecognised ${rec.kind} record names ${job}`, {
				kind: rec.kind,
				transferId: rec.data.transferId,
			});
			continue;
		}
		const sid = sessionOfRecord(rec);
		if (sid === null) {
			why(`a record of ${job} names no session`);
			continue;
		}
		if (!usable(sid)) {
			why(`session ${sid}: a record of ${job} has no usable job log to be placed by`, {
				session: sid,
				kind: rec.kind,
				transferId: rec.data.transferId,
			});
			continue;
		}
		const intervals = intervalsBySession.get(sid) ?? [];
		if (intervals.length === 0) {
			why(
				`session ${sid}: a ${rec.kind} of ${job} lies outside its intervals (the session has none)`,
				{ session: sid, kind: rec.kind, transferId: rec.data.transferId },
			);
			continue;
		}
		const w = rec.kind === "llm_call" ? window(rec.data) : null;
		const point = ms(rec.data.usageFrom);
		const placed =
			rec.kind === "llm_call"
				? w !== null && insideAny(w, intervals)
				: Number.isFinite(point) && insideAny([point, point], intervals);
		if (!placed)
			why(`session ${sid}: a ${rec.kind} of ${job} lies outside its intervals`, {
				session: sid,
				kind: rec.kind,
				transferId: rec.data.transferId,
			});
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
			if (!tagged)
				why(`session ${sid}: no record of ${job} inside [${from}, ${to}]`, {
					session: sid,
					interval: [from, to],
				});
		}
	}
	if (intervalsSeen === 0) why(`no session log has an interval of ${job}`);

	// Transfers that have an llm_call anywhere in the evidence: settlement metadata beside one
	// is bookkeeping; without one it is spend the total does not hold.
	const callTransfers = new Set(
		records.filter((r) => r?.kind === "llm_call").map((r) => r?.data?.transferId),
	);
	// Spend-like records that name NO session cannot be placed by any log: if their time could
	// fall in an interval of the job (or is unreadable), they may be the job's.
	for (const r of records) {
		if (r?.data?.job === job || sessionOfRecord(r) !== null) continue;
		if (r?.kind !== "llm_call" && !SPEND_LIKE.has(r?.kind)) continue;
		const w = r.kind === "llm_call" ? window(r.data) : null;
		const point = ms(r?.data?.usageFrom);
		const span = r.kind === "llm_call" ? w : Number.isFinite(point) ? [point, point] : null;
		if (span === null || overlapsAny(span, allIntervals)) {
			why(`a ${r.kind} record names no session: it may belong to ${job}`, {
				kind: r.kind,
				transferId: r?.data?.transferId,
			});
		}
	}

	// ── Clause 2: every event whose time could fall in the job's intervals is POSITIVELY
	// attributed elsewhere, through a valid log of its own session. One that cannot be
	// resolved could belong to the job, so it is a known gap. ──
	for (const [sid, mine] of bySession) {
		const capable = mine.some((r) => typeof r?.data?.usageFrom === "string");
		const intervals = intervalsBySession.get(sid) ?? [];
		for (const r of mine) {
			if (r?.data?.job === job) continue; // clause 1 judged it
			// A give-back that states no proof of no usage and is not attributed to ANOTHER job could
			// be this job's: with no usable log, or starting inside an interval, it is a gap.
			if (
				r?.kind === "hold_released" &&
				r.data?.releaseClass !== "unused" &&
				r.data?.job === undefined
			) {
				const at = ms(r.data?.usageFrom);
				if (!usable(sid) || (Number.isFinite(at) ? insideAny([at, at], intervals) : capable)) {
					why(
						`session ${sid}: a released hold of no known job, usage unconfirmed, may belong to ${job}`,
						{
							session: sid,
							transferId: r.data?.transferId,
						},
					);
				}
				continue;
			}
			if (
				BENIGN_KINDS.has(r?.kind) &&
				!(SPEND_METADATA.has(r?.kind) && !callTransfers.has(r?.data?.transferId))
			) {
				continue;
			}
			const isCall = r?.kind === "llm_call";
			const w = isCall ? window(r.data) : null;
			const point = ms(r?.data?.usageFrom);
			if (!usable(sid)) {
				why(
					`session ${sid}: a ${r?.kind} cannot be placed (no usable job log): it may belong to ${job}`,
					{ session: sid, kind: r?.kind, transferId: r?.data?.transferId },
				);
				continue;
			}
			if (!isCall) {
				// DENY BY DEFAULT: a record of a kind this check cannot read as spend or as a
				// harmless give-back (a denial, a failure, anything new) inside an interval may
				// stand for usage that is not in the total, whatever labels it carries or lacks.
				if (!Number.isFinite(point) ? capable : insideAny([point, point], intervals)) {
					why(`session ${sid}: a ${r?.kind} record lies in an interval of ${job}`, {
						session: sid,
						kind: r?.kind,
					});
				}
				continue;
			}
			if (w === null) {
				if (capable)
					why(`session ${sid}: an llm_call has no complete usage window`, {
						session: sid,
						transferId: r?.data?.transferId,
					});
				continue;
			}
			if (!overlapsAny(w, intervals)) continue; // positively attributed elsewhere
			if (r.data?.jobState === "invalid") {
				why(`session ${sid}: an llm_call in the interval has an invalid job state`, {
					session: sid,
					transferId: r?.data?.transferId,
				});
			} else if (r.data?.job === undefined) {
				why(`session ${sid}: an llm_call in the interval carries no job`, {
					session: sid,
					transferId: r?.data?.transferId,
				});
			} else {
				why(`session ${sid}: an llm_call in the interval carries another job`, {
					session: sid,
					transferId: r?.data?.transferId,
					job: r?.data?.job,
				});
			}
		}
	}

	// The plugin's own watch records (`watch.jsonl`), when supplied: a `would_block` is usage
	// that was refused and a `gap` is a call that ran UNMETERED, so neither is in the total.
	// Such an event stops being a problem for the job ONLY when positively attributed to
	// something else through a valid log of its own session (the job open when its call
	// STARTED is not this one, or none is). One that cannot be resolved (no session, an
	// unreadable time, no usable log) could belong to ANY job, so it is a known gap for every job;
	// its own label proves nothing, and neither does its lack of one.
	for (const w of watch) {
		if (w?.kind === "unreadable") {
			why("the watch records are unreadable: gaps and refusals cannot be ruled out");
			continue;
		}
		if (w?.kind !== "gap" && w?.kind !== "would_block") continue;
		if (w.kind === "would_block" && w.job === job) {
			why(`a request of ${job} was refused (would_block): its usage is unrecorded`, {
				kind: w.kind,
				session: w.session,
			});
			continue;
		}
		// A refusal that NAMES another job is positively attributed to it: its hook time (a Stop
		// that ran during this job) is not its usage time.
		if (w.kind === "would_block" && typeof w.job === "string" && JOB_ID.test(w.job)) continue;
		const sid = typeof w.session === "string" ? w.session : null;
		// An explicit null is a start nobody knows: unresolved, never the time it was written.
		const t = w.started === null ? Number.NaN : ms(w.started ?? w.at);
		let unresolved = null;
		if (sid === null) unresolved = "it names no session";
		else if (!Number.isFinite(t)) unresolved = "its time is unreadable";
		else if (!Object.hasOwn(logs ?? {}, sid)) unresolved = `session ${sid} has no job log`;
		else if (!usable(sid)) unresolved = `session ${sid} has no usable job log`;
		else if (jobAtEvents(parsedLogs.get(sid).events, t) === job) {
			why(`session ${sid}: a ${w.kind} fell inside an interval of ${job}`, {
				kind: w.kind,
				session: sid,
				started: w.started ?? w.at,
			});
		}
		if (unresolved !== null) {
			why(`a ${w.kind} cannot be attributed to a job (${unresolved}): it may belong to ${job}`, {
				kind: w.kind,
				session: w.session,
				started: w.started ?? w.at,
				why: unresolved,
			});
		}
	}

	// A clock that stepped backwards inside a log: attribution around the stepped lines is
	// uncertain for any job whose interval touches the stretch they were clamped across.
	for (const [sid, parsed] of parsedLogs) {
		if (parsed.state !== "ok") continue;
		const intervals = intervalsBySession.get(sid) ?? [];
		for (const step of parsed.clockSteps ?? []) {
			const touches = intervals.some(([from, to]) => from <= step.effectiveMs && to >= step.rawMs);
			if (touches) {
				why(
					`session ${sid}: the clock moved backwards in the job log (line ${step.line}, by ${step.bySeconds} s): attribution around it is uncertain`,
					{ session: sid, line: step.line, bySeconds: step.bySeconds },
				);
			}
		}
	}

	// Evidence that could not be read is evidence that is missing, never a silent drop.
	for (const [what, n] of Object.entries(unreadable ?? {})) {
		if (n > 0)
			why(`evidence incomplete: ${n} ${what} line(s) could not be parsed`, { what, lines: n });
	}
	// An interval with no stop yet: the job is still running, so holds in flight are not yet
	// settled and the tagged cost is still moving.
	for (const [sid, intervals] of intervalsBySession) {
		if (intervals.some(([, to]) => to === Number.POSITIVE_INFINITY)) {
			why("job still running: in-flight holds are not yet settled", { session: sid });
		}
	}

	const seen = new Set();
	return {
		job,
		diagnostic: true,
		note: "A diagnostic only: knownGaps lists the ways this figure is known to be incomplete. An empty list does not mean it is complete.",
		taggedCostUt: String(costUt),
		transferIds: [...transferCost.keys()],
		knownGaps: knownGaps.filter((g) => {
			const key = `${g.gap}\u0000${JSON.stringify(g.evidence)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
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
