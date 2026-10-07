// SessionStart: tell the USER which mode usertrust runs in — watch-only (the
// default: nothing is blocked) or ENFORCING (UT_CC_MODE=enforce) — so a
// watch-only plugin never looks like it is enforcing, and an enforcing one is
// never a surprise. Claude Code shows a hook's JSON `systemMessage` to the user,
// whereas SessionStart's plain stdout goes to Claude's context instead
// (https://code.claude.com/docs/en/hooks: "To surface a message to the user on
// any platform, return `systemMessage` in JSON output", and SessionStart
// decision control: "Claude Code adds stdout it treats as plain text to
// Claude's context"). No network call: the hook must be fast and cannot fail.
import { announce, modeAnnouncement, readStdin } from "./lib.mjs";

try {
	// The payload is not needed; reading it lets Claude Code finish writing stdin.
	await readStdin();
} catch {
	// Nothing to read is fine.
}
announce(modeAnnouncement());
