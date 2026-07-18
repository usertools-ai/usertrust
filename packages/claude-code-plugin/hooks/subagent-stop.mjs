// SubagentStop: void the unsettled holds belonging to the subagent that just
// stopped — and ONLY that subagent's holds.
//
// session_id is shared across the parent and all subagents, so a whole-session
// sweep here would abort the parent's and sibling subagents' in-flight holds.
// We scope the cleanup to input.agent_id. When agent_id is absent (older Claude
// Code that does not emit it), we abort NOTHING rather than sweep the shared
// "main" bucket: a false abort of a still-running agent's hold is worse than an
// orphan, and PostToolUse settles / the Stop sweep / the server's pending-TTL
// sweep are the backstops that reconcile any leftover hold.
import { cleanup, readStdin } from "./lib.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	const agentId = input.agent_id;
	if (typeof agentId === "string" && agentId !== "") {
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
