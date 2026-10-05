// PostToolUse: close this tool call's reservation. The tool has already
// executed — this hook must NEVER block or fail closed.
//
// Transcript usage mode (the default): the PreToolUse hold is the settlement
// vehicle (see transcript.mjs). A hold with assigned messages is SETTLED exactly
// once, at their counts, and never aborted on the normal path. One with none is
// given back: released on a server that can release, else settled at zero usage
// (that server's 1-unit floor). A failed settle (see transcript.mjs `settleAt`):
// 400 — or an unkeyed 404 — releases its messages for a later settle point
// (nothing was posted). Otherwise the outcome is unknown: a hold authorized under
// its window's key is UNRESOLVED and retried as itself at Stop/SubagentStop (the
// server charges a key at most once); an unkeyed one keeps its messages claimed
// (it may have posted, and a message is posted at most once).
//
// Estimate mode (UT_CC_USAGE=estimate, or an agent whose transcript could not
// be read): the hold settles at the per-call estimate, labelled
// `usageSource: "estimated"`, exactly as the original hook did. The pending
// file is deleted only AFTER a 200; on any failure it is left in place so
// Stop/SubagentStop cleanup gives the hold back (and the server's TTL sweep is
// the final backstop).
import {
	clearPending,
	estimateTokens,
	MAX_CONTENT_CHARS,
	readStdin,
	serverRequest,
	takePendingEntry,
	usageMode,
} from "./lib.mjs";
import { estimateReasonFor, settleTranscriptHold } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	// Settle only this agent's holds; the session bucket is shared with siblings.
	const agentId = input.agent_id ?? "main";
	const entry = await takePendingEntry(sessionId, agentId, input.tool_use_id ?? null);
	if (entry?.usage === "transcript") {
		const result = await settleTranscriptHold(sessionId, entry);
		if (result.outcome !== "settled" && result.outcome !== "returned") {
			process.stderr.write(
				`usertrust: transcript hold ${entry.transferId} ${result.outcome} — ${result.reason ?? ""}\n`,
			);
		}
	} else if (entry) {
		if (usageMode() === "transcript") {
			const reason = await estimateReasonFor({ sessionId, agentId, input });
			process.stderr.write(
				`usertrust: settling at the ESTIMATE — ${reason ?? "the hold was reserved in estimate mode"}\n`,
			);
		}
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
