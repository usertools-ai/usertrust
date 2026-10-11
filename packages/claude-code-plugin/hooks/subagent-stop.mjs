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
// response (its input's `last_assistant_message`) to reach its transcript, and
// says so when it gives up.
//
// While the server's breaker is open (lib.mjs `breakerOpen`, watch mode only), nothing is
// sent and nothing is touched but the state's first-run time (transcript.mjs
// `stampFirstRun`): the subagent's holds and remainder wait for the first hook after it
// closes (Stop's sweep settles every subagent's), and one `deferred` record names the holds
// (`skipSettlePoint`).
import {
	breakerOpen,
	cleanup,
	readStdin,
	requireLaunch,
	say,
	skipSettlePoint,
	usageMode,
} from "./lib.mjs";
import {
	awaitFinalResponse,
	cleanupReserve,
	postRemainder,
	settleAssignedHolds,
	stampFirstRun,
	transcriptPathFor,
} from "./transcript.mjs";

requireLaunch();

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	const agentId = input.agent_id;
	if (typeof agentId === "string" && agentId !== "" && (await breakerOpen())) {
		if (usageMode() === "transcript") await stampFirstRun();
		await skipSettlePoint({
			kind: "deferred",
			phase: "subagent-stop",
			session: sessionId,
			agent: agentId,
		});
	} else if (typeof agentId === "string" && agentId !== "") {
		await settleAssignedHolds(sessionId, agentId);
		if (usageMode() === "transcript") {
			const waited = await awaitFinalResponse(
				transcriptPathFor(input, agentId),
				input.last_assistant_message,
			);
			if (waited === "not flushed") {
				say(
					`usertrust: ${agentId}'s final response was not in its transcript by the end of the wait — left for Stop`,
				);
			}
			try {
				const result = await postRemainder({
					sessionId,
					agentId,
					agentTypeHint: input.agent_type,
					input,
					hook: "SubagentStop",
					reserveMs: cleanupReserve(),
				});
				if (result.skipped !== undefined) {
					say(`usertrust: no transcript usage for ${agentId} — ${result.skipped}`);
				}
				for (const note of result.notes ?? []) {
					say(`usertrust: transcript usage for ${agentId}: ${note}`);
				}
			} catch (err) {
				say(
					`usertrust: transcript usage failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		await cleanup(sessionId, agentId);
	} else {
		say(
			"usertrust: subagent-stop without agent_id — leaving holds for PostToolUse/Stop/server TTL to reconcile",
		);
	}
} catch (err) {
	say(
		`usertrust: subagent-stop cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
	);
}
