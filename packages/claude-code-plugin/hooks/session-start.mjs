// SessionStart: tell the USER which mode usertrust runs in — watch-only (the
// default: nothing is blocked) or ENFORCING (UT_CC_MODE=enforce) — so a
// watch-only plugin never looks like it is enforcing, and an enforcing one is
// never a surprise. Claude Code shows a hook's JSON `systemMessage` to the user,
// whereas SessionStart's plain stdout goes to Claude's context instead
// (https://code.claude.com/docs/en/hooks: "To surface a message to the user on
// any platform, return `systemMessage` in JSON output", and SessionStart
// decision control: "Claude Code adds stdout it treats as plain text to
// Claude's context"). The hook must be fast and cannot fail.
//
// Its one request, and only that: a single `/v1/health` probe of at most 1.5 s, asking whether
// the server lists `job-type` (job-log.mjs `jobTypeInstruction`), so the agent is told to type
// its jobs only where a type is recorded. For a configured session it is made by the isolated
// child, as every other hook's request is (launch.mjs `probeInChild`); an environment session
// makes it here. It NEVER counts toward the circuit breaker (a timeout or failure there is not a
// strike), it is skipped while the breaker is open, and any failure leaves the banner below,
// announced once, with no instruction. The banner and the warnings are local.
//
// It also warns of tool calls the server REJECTED for their key since the last session start
// (key-rejected.mjs `rejectedSinceLastStart`): read from watch.jsonl, locally and bounded. Any
// failure to read it is the normal banner, never a thrown error or a wait.
//
// It records the model Claude Code reports for the session (`model`, which Claude Code may
// omit): what a hold names before any response of its agent says one (transcript.mjs
// `holdModelFor`). And it says so when a model is still configured: that is ignored.
import { ignoredModelNote } from "./config.mjs";
import { jobTypeInstruction, writeSessionStart } from "./job-log.mjs";
import { rejectedSinceLastStart, warningText } from "./key-rejected.mjs";
import {
	announce,
	modeAnnouncement,
	RELEASING_SWEEP_MS,
	readStdin,
	requireLaunch,
	say,
	sweepReleasing,
} from "./lib.mjs";
import { takePeerWarning } from "./peer-meter.mjs";
import { recordSessionModel, stampFirstRun } from "./transcript.mjs";

requireLaunch();

let payload = {};
try {
	// Claude Code writes the session id and the start `source` to stdin.
	payload = JSON.parse((await readStdin()) || "{}");
} catch {
	// Nothing to read is fine.
}
// The state's first-run time (transcript.mjs `firstRun`), if it has none, before anything
// else: a transcript entry written before it is never posted, and Claude Code writes a
// response, `usage` and all, BEFORE the PreToolUse its tool_use fires. Stamped first at that
// PreToolUse, a fresh install never posted its first response. SessionStart precedes every
// response of its session, whatever its `source`: a resumed or compacted transcript's
// history is older than the stamp, and is never posted, and a stamp already made never
// moves. Local and bounded, and it never throws; in estimate mode it makes nothing.
await stampFirstRun(payload?.session_id);
// A string, "the active model identifier" (https://code.claude.com/docs/en/hooks#sessionstart-input);
// an object's `id` is taken too, the shape Claude Code gives a status line. Never throws.
const reported = payload?.model;
await recordSessionModel(
	payload?.session_id,
	reported !== null && typeof reported === "object" ? reported.id : reported,
);
// The job log: a NEW session id (startup, clear, fork) gets its `session-start` line;
// resume and compact write nothing, so neither ever ends or invalidates an open job.
// Failing to write it must never fail a session: `usertrust-job` then refuses loudly.
try {
	await writeSessionStart(payload?.session_id, payload?.source);
} catch (err) {
	say(`usertrust: job log not started: ${err instanceof Error ? err.message : String(err)}`);
}
// A `.releasing` record kept for a re-fire (lib.mjs `cleanup`), its gaps written, is dropped once
// it is far older than the ledger's pending timeout (`RELEASING_SWEEP_MS`): its hold is voided by
// then. Local and bounded, and it never throws.
await sweepReleasing(RELEASING_SWEEP_MS);
// The warning first, so the clip at `announce`'s bound can only ever cut the mode line after it.
let warning = null;
try {
	const rejected = await rejectedSinceLastStart();
	if (rejected !== null) warning = warningText(rejected);
} catch {
	// Never a reason to fail the start: the normal banner.
}
// The old plugin's state, when it could not be told (launch.mjs `warnOfPeer`: it looks enabled, or could not be told; this plugin meters either way): first, for the
// same reason as the rejected-key warning.
const peerWarning = takePeerWarning();
if (peerWarning !== null) warning = warning === null ? peerWarning : `${peerWarning} ${warning}`;
// A model still configured is ignored, and said; after the warnings, which matter more.
const modelNote = ignoredModelNote();
if (modelNote !== null) warning = warning === null ? modelNote : `${warning} ${modelNote}`;
// The banner and, for a server that lists `job-type`, the agent's instruction to type its jobs
// (`jobTypeInstruction`: bounded probe, null on any failure): ONE announce, so ONE JSON object.
const typeInstruction = await jobTypeInstruction();
announce(
	warning === null ? modeAnnouncement() : `${warning} ${modeAnnouncement()}`,
	typeInstruction === null ? undefined : { additionalContext: typeInstruction },
);
