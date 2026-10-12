// SessionStart: tell the USER which mode usertrust runs in — watch-only (the
// default: nothing is blocked) or ENFORCING (UT_CC_MODE=enforce) — so a
// watch-only plugin never looks like it is enforcing, and an enforcing one is
// never a surprise. Claude Code shows a hook's JSON `systemMessage` to the user,
// whereas SessionStart's plain stdout goes to Claude's context instead
// (https://code.claude.com/docs/en/hooks: "To surface a message to the user on
// any platform, return `systemMessage` in JSON output", and SessionStart
// decision control: "Claude Code adds stdout it treats as plain text to
// Claude's context"). No network call: the hook must be fast and cannot fail.
//
// It also warns of tool calls the server REJECTED for their key since the last session start
// (key-rejected.mjs `rejectedSinceLastStart`): read from watch.jsonl, locally and bounded. Any
// failure to read it is the normal banner, never a thrown error or a wait.
import { writeSessionStart } from "./job-log.mjs";
import { rejectedSinceLastStart, warningText } from "./key-rejected.mjs";
import { announce, modeAnnouncement, readStdin, requireLaunch, say } from "./lib.mjs";
import { takePeerWarning } from "./peer-meter.mjs";
import { stampFirstRun } from "./transcript.mjs";

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
await stampFirstRun();
// The job log: a NEW session id (startup, clear, fork) gets its `session-start` line;
// resume and compact write nothing, so neither ever ends or invalidates an open job.
// Failing to write it must never fail a session: `usertrust-job` then refuses loudly.
try {
	await writeSessionStart(payload?.session_id, payload?.source);
} catch (err) {
	say(`usertrust: job log not started: ${err instanceof Error ? err.message : String(err)}`);
}
// The warning first, so the clip at `announce`'s bound can only ever cut the mode line after it.
let warning = null;
try {
	const rejected = await rejectedSinceLastStart();
	if (rejected !== null) warning = warningText(rejected);
} catch {
	// Never a reason to fail the start: the normal banner.
}
// The old plugin's state, when it could not be told (launch.mjs `yieldsToPeer`): first, for the
// same reason as the rejected-key warning.
const peerWarning = takePeerWarning();
if (peerWarning !== null) warning = warning === null ? peerWarning : `${peerWarning} ${warning}`;
announce(warning === null ? modeAnnouncement() : `${warning} ${modeAnnouncement()}`);
