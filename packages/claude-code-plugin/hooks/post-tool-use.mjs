// PostToolUse: close this tool call's reservation. The tool has already
// executed — this hook must NEVER block or fail closed.
//
// The PreToolUse hold is an ESTIMATE, sized from tool input/output, and exists
// so budget enforcement happens before the call. What the call really cost —
// the model turns around it, context and cache — is in Claude Code's own
// transcript. So in `transcript` usage mode (the default) this hook first
// settles the agent's new transcript usage at real token counts, then VOIDS the
// estimate hold: the real numbers replace it rather than adding to it. Only
// when the transcript is missing or corrupt does it fall back to settling the
// hold at the estimate, labelled `usageSource: "estimated"`.
//
// The pending file is deleted only AFTER a 200 (settle or abort); on any
// failure it is left in place so Stop/SubagentStop cleanup aborts the hold
// (and the server's TTL sweep is the final backstop).
import {
	clearPending,
	estimateTokens,
	MAX_CONTENT_CHARS,
	readStdin,
	serverRequest,
	takePendingEntry,
	usageMode,
} from "./lib.mjs";
import { settleTranscript, transcriptPathFor } from "./transcript.mjs";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	// Settle only this agent's holds; the session bucket is shared with siblings.
	const agentId = input.agent_id ?? "main";
	let fallbackReason = "UT_CC_USAGE=estimate";
	let reconciled = false;
	if (usageMode() === "transcript") {
		const result = await settleTranscript({
			sessionId,
			agentId,
			agentTypeHint: input.agent_type,
			transcriptPath: transcriptPathFor(input, agentId),
			hook: "PostToolUse",
		});
		if (result.ok) {
			reconciled = true;
			for (const failure of result.failures ?? []) {
				process.stderr.write(`usertrust: transcript settle deferred (${failure})\n`);
			}
		} else {
			fallbackReason = result.reason;
		}
	}
	const entry = await takePendingEntry(sessionId, agentId, input.tool_use_id ?? null);
	if (entry && reconciled) {
		const response = await serverRequest("/v1/abort", {
			transferId: entry.transferId,
			error: "reconciled: real usage settles from the transcript",
		});
		if (response.status === 200) {
			await clearPending(sessionId, agentId, entry.entryKey);
		} else {
			process.stderr.write(
				`usertrust: void ${entry.transferId} returned ${response.status}; hold kept for Stop cleanup\n`,
			);
		}
	} else if (entry) {
		if (usageMode() === "transcript") {
			process.stderr.write(`usertrust: settling at the ESTIMATE — ${fallbackReason}\n`);
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
