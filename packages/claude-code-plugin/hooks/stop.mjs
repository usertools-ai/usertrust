// Stop: post the session's remaining transcript usage, then terminate every
// hold left for the session (`settleSession` in transcript.mjs: leftover holds
// with usage settled first, then every agent's remainder, then the rest given
// back).
//
// The transcript is written asynchronously, so the turn's final response may not
// be in it yet: with the input's `last_assistant_message`, Stop first waits —
// boundedly — for it to arrive (`awaitFinalResponse`), and says so when it gives
// up. A response that arrives later still is left for SessionEnd, or the next Stop.
import { readStdin, requireLaunch, say, usageMode } from "./lib.mjs";
import { awaitFinalResponse, settleSession } from "./transcript.mjs";

requireLaunch();

try {
	const input = JSON.parse((await readStdin()) || "{}");
	if (usageMode() === "transcript") {
		const waited = await awaitFinalResponse(input.transcript_path, input.last_assistant_message);
		if (waited === "not flushed") {
			say(
				"usertrust: the turn's final response was not in the transcript by the end of the wait — left for SessionEnd or the next Stop",
			);
		}
	}
	await settleSession({ input, hook: "Stop" });
} catch (err) {
	say(`usertrust: stop cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
}
