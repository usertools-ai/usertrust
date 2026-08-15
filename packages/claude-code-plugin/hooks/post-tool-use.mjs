// PostToolUse: settle the reservation at estimated actual usage. The tool has
// already executed — this hook must NEVER block or fail closed. The pending
// file is deleted only AFTER a 200 settle; on any failure (transport or
// non-200) it is left in place so Stop/SubagentStop cleanup aborts the hold
// (and the server's TTL sweep is the final backstop).
import {
	clearPending,
	estimateTokens,
	MAX_CONTENT_CHARS,
	readStdin,
	serverRequest,
	takePendingEntry,
} from "./lib.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	// Settle only this agent's holds; the session bucket is shared with siblings.
	const agentId = input.agent_id ?? "main";
	const entry = await takePendingEntry(sessionId, agentId, input.tool_use_id ?? null);
	if (entry) {
		// Price both legs. The authorize-time input estimate is persisted on the
		// pending file; if an older file lacks it, re-estimate from tool_input
		// when the host still sends it (AUD-004).
		const inputTokens =
			typeof entry.estimatedInputTokens === "number"
				? entry.estimatedInputTokens
				: input.tool_input != null
					? estimateTokens(JSON.stringify(input.tool_input).slice(0, MAX_CONTENT_CHARS))
					: undefined;
		const response = await serverRequest("/v1/settle", {
			transferId: entry.transferId,
			...(inputTokens != null ? { inputTokens } : {}),
			// Same 16 KiB cap as the output hold so a content-cap result cannot
			// price above the reservation (AUD-004).
			outputTokens: estimateTokens(
				JSON.stringify(input.tool_response ?? "").slice(0, MAX_CONTENT_CHARS),
			),
			usageSource: "estimated",
		});
		if (response.status === 200) {
			await clearPending(sessionId, agentId, entry.entryKey);
		} else {
			process.stderr.write(
				`usertrust: settle ${entry.transferId} returned ${response.status}; hold kept for Stop cleanup\n`,
			);
		}
	}
} catch (err) {
	process.stderr.write(
		`usertrust: settle failed (non-blocking): ${err instanceof Error ? err.message : String(err)}\n`,
	);
}
