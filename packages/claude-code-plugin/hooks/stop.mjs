// Stop: post the session's remaining transcript usage, then terminate every
// hold left for the session (`settleSession` in transcript.mjs: leftover holds
// with usage settled first, then every agent's remainder, then the rest given
// back).
//
// The transcript is written asynchronously, so the turn's final response may not
// be in it yet: with the input's `last_assistant_message`, Stop first waits —
// boundedly — for it to arrive (`awaitFinalResponse`). A response that arrives
// later still is posted by SessionEnd, or by the next Stop.
import { readStdin, usageMode } from "./lib.mjs";
import { awaitFinalResponse, settleSession } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	if (usageMode() === "transcript") {
		await awaitFinalResponse(input.transcript_path, input.last_assistant_message);
	}
	await settleSession({ input, hook: "Stop" });
} catch (err) {
	process.stderr.write(
		`usertrust: stop cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
