// SessionEnd: the session is over, and its transcript "is finalized at session
// end, so you can safely read it" (hooks reference, "SessionEnd input") — unlike
// at Stop, where the final response may not have been written yet. So the scan
// Stop makes is made once more, now that nothing can be missing: leftover holds
// with usage settled, every agent's remainder posted (through the same claims as
// every post, so nothing Stop already posted is posted again), and the rest given
// back (`settleSession` in transcript.mjs). A Stop still finishing holds an
// agent's lock: this waits for it, boundedly. SessionEnd cannot block, and never
// fails a session.
import { readStdin } from "./lib.mjs";
import { SESSION_END_LOCK_WAIT_MS, settleSession } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	await settleSession({ input, hook: "SessionEnd", lockWaitMs: SESSION_END_LOCK_WAIT_MS });
} catch (err) {
	process.stderr.write(
		`usertrust: session-end settle failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
