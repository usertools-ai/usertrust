// SubagentStop: settle the stopping subagent's real transcript usage, then void
// the unsettled holds belonging to that subagent — and ONLY that subagent's.
//
// session_id is shared across the parent and all subagents, so a whole-session
// sweep here would abort the parent's and sibling subagents' in-flight holds.
// We scope both steps to input.agent_id. When agent_id is absent (older Claude
// Code that does not emit it), we do NOTHING rather than touch the shared
// "main" bucket: a false abort of a still-running agent's hold is worse than an
// orphan, and PostToolUse settles / the Stop sweep (which also settles every
// subagent transcript) / the server's pending-TTL sweep are the backstops.
import { cleanup, readStdin, usageMode } from "./lib.mjs";
import { settleTranscript, transcriptPathFor } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	const agentId = input.agent_id;
	if (typeof agentId === "string" && agentId !== "") {
		if (usageMode() === "transcript") {
			try {
				const result = await settleTranscript({
					sessionId,
					agentId,
					agentTypeHint: input.agent_type,
					transcriptPath: transcriptPathFor(input, agentId),
					hook: "SubagentStop",
				});
				if (!result.ok) {
					process.stderr.write(
						`usertrust: no transcript usage for ${agentId} — ${result.reason}\n`,
					);
				}
				for (const failure of result.failures ?? []) {
					process.stderr.write(`usertrust: transcript settle deferred (${failure})\n`);
				}
			} catch (err) {
				process.stderr.write(
					`usertrust: transcript settle failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
		await cleanup(sessionId, agentId);
	} else {
		process.stderr.write(
			"usertrust: subagent-stop without agent_id — leaving holds for PostToolUse/Stop/server TTL to reconcile\n",
		);
	}
} catch (err) {
	process.stderr.write(
		`usertrust: subagent-stop cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
