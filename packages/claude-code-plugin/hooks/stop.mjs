// Stop: post the session's remaining transcript usage, then terminate every
// hold left for the session.
//
// 1. LEFTOVER HOLDS, across all agents (the session really is ending). A hold
//    with assigned transcript usage was billed even if its tool was interrupted,
//    so it is SETTLED with its counts — first, so that one whose settle is
//    UNRESOLVED (see transcript.mjs) is retried by step 2 of this same Stop.
// 2. REMAINDER. For the parent ("main") and every subagent transcript recorded
//    for the session — so an agent whose SubagentStop never fired is still
//    accounted — first retry each unresolved settle as itself, then post the
//    complete messages no hold picked up (another model, a final answer with no
//    tool call), one authorize→settle per model. An agent in estimate mode is
//    skipped: its holds already carried its usage.
// 3. What is left holds no usage: it is given back — released, or aborted on a
//    server that cannot release.
// The remainder stops early enough to leave time for step 3.
import { cleanup, readStdin, usageMode } from "./lib.mjs";
import {
	CLEANUP_RESERVE_MS,
	postRemainder,
	settleAssignedHolds,
	subagentIds,
} from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	await settleAssignedHolds(sessionId, null);
	if (usageMode() === "transcript") {
		const agents = ["main", ...(await subagentIds(input))];
		for (const [index, agentId] of agents.entries()) {
			try {
				const result = await postRemainder({
					sessionId,
					agentId,
					input,
					hook: "Stop",
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
				if (result.serverDown) {
					const rest = agents.slice(index + 1);
					if (rest.length > 0) {
						process.stderr.write(
							`usertrust: server unreachable — transcript usage of ${rest.join(", ")} left for the next settle point\n`,
						);
					}
					break;
				}
			} catch (err) {
				process.stderr.write(
					`usertrust: transcript usage failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
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
