// Stop: post the session's remaining transcript usage, then terminate every
// hold left for the session.
//
// 1. REMAINDER. For the parent ("main") and every subagent transcript recorded
//    for the session — so an agent whose SubagentStop never fired is still
//    accounted — post the complete messages no hold picked up (another model, a
//    final answer with no tool call), one authorize→settle per model. An agent
//    in estimate mode is skipped: its holds already carried its usage.
// 2. LEFTOVER HOLDS, across all agents (the session really is ending). A hold
//    with assigned transcript usage was billed even if its tool was interrupted,
//    so it is SETTLED with its counts; a hold without is aborted, as before.
// The remainder stops early enough to leave time for step 2.
import { cleanup, readStdin, usageMode } from "./lib.mjs";
import {
	LEFTOVER_RESERVE_MS,
	postRemainder,
	settleAssignedHolds,
	subagentIds,
} from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	if (usageMode() === "transcript") {
		for (const agentId of ["main", ...(await subagentIds(input))]) {
			try {
				const result = await postRemainder({
					sessionId,
					agentId,
					input,
					hook: "Stop",
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
				if (result.serverDown) break;
			} catch (err) {
				process.stderr.write(
					`usertrust: transcript usage failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}
	await settleAssignedHolds(sessionId, null);
	await cleanup(sessionId, null);
} catch (err) {
	process.stderr.write(
		`usertrust: stop cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
