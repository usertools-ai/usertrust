// SubagentStop: post the stopping subagent's remaining transcript usage, then
// terminate the holds belonging to that subagent — and ONLY that subagent's.
//
// session_id is shared across the parent and all subagents, so a whole-session
// sweep here would touch the parent's and sibling subagents' in-flight holds.
// We scope both steps to input.agent_id. When agent_id is absent (older Claude
// Code that does not emit it), we do NOTHING rather than touch the shared
// "main" bucket: a false abort of a still-running agent's hold is worse than an
// orphan, and PostToolUse settles / the Stop sweep (which also posts every
// subagent's remainder) / the server's pending-TTL sweep are the backstops.
// Leftover holds follow Stop's rule: settled if usage was assigned, else aborted.
import { cleanup, readStdin, usageMode } from "./lib.mjs";
import { LEFTOVER_RESERVE_MS, postRemainder, settleAssignedHolds } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	const agentId = input.agent_id;
	if (typeof agentId === "string" && agentId !== "") {
		if (usageMode() === "transcript") {
			try {
				const result = await postRemainder({
					sessionId,
					agentId,
					agentTypeHint: input.agent_type,
					input,
					hook: "SubagentStop",
					reserveMs: LEFTOVER_RESERVE_MS,
				});
				if (result.skipped !== undefined) {
					process.stderr.write(
						`usertrust: no transcript usage for ${agentId} — ${result.skipped}\n`,
					);
				}
				for (const note of result.notes ?? []) {
					process.stderr.write(`usertrust: transcript usage for ${agentId}: ${note}\n`);
				}
			} catch (err) {
				process.stderr.write(
					`usertrust: transcript usage failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
		await settleAssignedHolds(sessionId, agentId);
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
