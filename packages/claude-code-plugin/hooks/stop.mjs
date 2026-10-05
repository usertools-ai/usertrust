// Stop: settle the session's real transcript usage, then void every unsettled
// hold for the session.
//
// Transcript settle covers the parent ("main") transcript AND every subagent
// transcript recorded for the session — a subagent whose SubagentStop never
// fired (crash, background agent) is still accounted, and idempotency makes the
// overlap with SubagentStop harmless. Only COMPLETE messages are settled; one
// still streaming waits for the next settle point.
//
// The whole-session hold sweep (agentId null) is correct here — the session
// really is ending, so any hold left by the parent or any subagent is aborted.
import { cleanup, readStdin, usageMode } from "./lib.mjs";
import { settleTranscript, subagentTranscripts } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	if (usageMode() === "transcript") {
		const targets = [
			{ agentId: "main", path: input.transcript_path },
			...(await subagentTranscripts(input)),
		];
		for (const target of targets) {
			try {
				const result = await settleTranscript({
					sessionId,
					agentId: target.agentId,
					transcriptPath: target.path,
					hook: "Stop",
				});
				if (!result.ok) {
					process.stderr.write(
						`usertrust: no transcript usage for ${target.agentId} — ${result.reason}\n`,
					);
				}
				for (const failure of result.failures ?? []) {
					process.stderr.write(`usertrust: transcript settle deferred (${failure})\n`);
				}
			} catch (err) {
				process.stderr.write(
					`usertrust: transcript settle failed for ${target.agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}
	await cleanup(sessionId, null);
} catch (err) {
	process.stderr.write(
		`usertrust: stop cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
