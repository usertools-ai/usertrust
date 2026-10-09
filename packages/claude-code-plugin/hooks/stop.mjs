// Stop: post the session's remaining transcript usage, then terminate every
// hold left for the session (`settleSession` in transcript.mjs: leftover holds
// with usage settled first, then every agent's remainder, then the rest given
// back).
//
// The transcript is written asynchronously, so the turn's final response may not
// be in it yet: with the input's `last_assistant_message`, Stop first waits —
// boundedly — for it to arrive (`awaitFinalResponse`), and says so when it gives
// up. A response that arrives later still is left for SessionEnd, or the next Stop.
//
// While the server's breaker is open (lib.mjs `breakerOpen`, watch mode only), nothing is
// sent and nothing is touched but the state's first-run time (transcript.mjs
// `stampFirstRun`): the holds and the remainder wait for the first hook after it closes, and
// one `deferred` record names the holds (`skipSettlePoint`).
import { breakerOpen, readStdin, requireLaunch, say, skipSettlePoint, usageMode } from "./lib.mjs";
import { awaitFinalResponse, settleSession, stampFirstRun } from "./transcript.mjs";

requireLaunch();

try {
	const input = JSON.parse((await readStdin()) || "{}");
	if (await breakerOpen()) {
		if (usageMode() === "transcript") await stampFirstRun();
		await skipSettlePoint({
			kind: "deferred",
			phase: "stop",
			session: input.session_id ?? "unknown",
			agent: null,
		});
	} else {
		await settle(input);
	}
} catch (err) {
	say(`usertrust: stop cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** The turn's end: wait for its final response, then settle the session (`settleSession`). */
async function settle(input) {
	if (usageMode() === "transcript") {
		const waited = await awaitFinalResponse(input.transcript_path, input.last_assistant_message);
		if (waited === "not flushed") {
			say(
				"usertrust: the turn's final response was not in the transcript by the end of the wait — left for SessionEnd or the next Stop",
			);
		}
	}
	await settleSession({ input, hook: "Stop" });
}
