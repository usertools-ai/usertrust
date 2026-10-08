// SessionStart: tell the USER which mode usertrust runs in — watch-only (the
// default: nothing is blocked) or ENFORCING (UT_CC_MODE=enforce) — so a
// watch-only plugin never looks like it is enforcing, and an enforcing one is
// never a surprise. Claude Code shows a hook's JSON `systemMessage` to the user,
// whereas SessionStart's plain stdout goes to Claude's context instead
// (https://code.claude.com/docs/en/hooks: "To surface a message to the user on
// any platform, return `systemMessage` in JSON output", and SessionStart
// decision control: "Claude Code adds stdout it treats as plain text to
// Claude's context"). No network call: the hook must be fast and cannot fail.
import { writeSessionStart } from "./job-log.mjs";
import { announce, modeAnnouncement, readStdin, requireLaunch, say } from "./lib.mjs";

requireLaunch();

let payload = {};
try {
	// Claude Code writes the session id and the start `source` to stdin.
	payload = JSON.parse((await readStdin()) || "{}");
} catch {
	// Nothing to read is fine.
}
// The job log: a NEW session id (startup, clear, fork) gets its `session-start` line;
// resume and compact write nothing, so neither ever ends or invalidates an open job.
// Failing to write it must never fail a session: `usertrust-job` then refuses loudly.
try {
	await writeSessionStart(payload?.session_id, payload?.source);
} catch (err) {
	say(`usertrust: job log not started: ${err instanceof Error ? err.message : String(err)}`);
}
announce(modeAnnouncement());
