// SubagentStop: settle the stopping subagent's leftover holds that carry usage,
// post its remaining transcript usage (unresolved settles first), then give back
// its holds that carry none — that subagent's, and ONLY that subagent's.
//
// session_id is shared across the parent and all subagents, so a whole-session
// sweep here would touch the parent's and sibling subagents' in-flight holds.
// We scope both steps to input.agent_id. When agent_id is absent (older Claude
// Code that does not emit it), we do NOTHING rather than touch the shared
// "main" bucket: giving back a still-running agent's hold is worse than an
// orphan, and PostToolUse settles / the Stop sweep (which also posts every
// subagent's remainder) / the server's pending-TTL sweep are the backstops.
// Leftover holds follow Stop's rule and order: settled first if usage was
// assigned (an unresolved one is then retried by the remainder step), else given
// back last. Like Stop, it first waits — boundedly — for the subagent's final
// response (its input's `last_assistant_message`) to reach its transcript.
import { cleanup, readStdin, usageMode } from "./lib.mjs";
import {
	awaitFinalResponse,
	CLEANUP_RESERVE_MS,
	postRemainder,
	settleAssignedHolds,
	transcriptPathFor,
} from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	const agentId = input.agent_id;
	if (typeof agentId === "string" && agentId !== "") {
		await settleAssignedHolds(sessionId, agentId);
		if (usageMode() === "transcript") {
			await awaitFinalResponse(transcriptPathFor(input, agentId), input.last_assistant_message);
			try {
				const result = await postRemainder({
					sessionId,
					agentId,
					agentTypeHint: input.agent_type,
					input,
					hook: "SubagentStop",
					reserveMs: CLEANUP_RESERVE_MS,
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
