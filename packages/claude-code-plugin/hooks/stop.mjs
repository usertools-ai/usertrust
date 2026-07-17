// Stop: void every unsettled hold for this session. The whole-session sweep
// (agentId null) is correct here — the session really is ending, so any hold
// left by the parent or any subagent should be aborted.
import { cleanup, readStdin } from "./lib.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	await cleanup(input.session_id ?? "unknown", null);
} catch (err) {
	process.stderr.write(
		`usertrust: stop cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
