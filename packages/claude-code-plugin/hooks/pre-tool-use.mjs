// PreToolUse: authorize a spend reservation before the tool executes.
// Fail-closed: if governance cannot be reached (or answers with a malformed
// body), the tool call is blocked (exit 2) unless UT_FAIL_OPEN=1. Output
// contract adapted from the AGT Claude Code plugin's stdin-JSON
// permissionDecision convention (MIT — see repository NOTICE).
//
// Content minimization: tool_input is truncated at 16 KiB before it is sent
// (both message content and token estimation); UT_CC_SEND_CONTENT=0 replaces
// the content with {"redacted":true} while keeping the size-based estimate.
import { estimateTokens, readStdin, recordPending, serverRequest } from "./lib.mjs";

const MAX_CONTENT_CHARS = 16 * 1024;
const MAX_REASON_CHARS = 500;

/** Server-provided text goes through here: strip control chars, bound length. */
function sanitizeReason(value, fallback = "unspecified") {
	const text = typeof value === "string" && value !== "" ? value : fallback;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function emit(decision, reason) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: decision,
				permissionDecisionReason: reason.slice(0, MAX_REASON_CHARS),
			},
		}),
	);
}

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	// session_id is shared across the parent and all subagents; agent_id (absent
	// on older Claude Code) is what scopes a hold to the agent that made it.
	const agentId = input.agent_id ?? "main";
	const toolInput = JSON.stringify(input.tool_input ?? {}).slice(0, MAX_CONTENT_CHARS);
	const content = process.env.UT_CC_SEND_CONTENT === "0" ? '{"redacted":true}' : toolInput;
	const response = await serverRequest("/v1/authorize", {
		model: process.env.UT_CC_MODEL ?? "claude-sonnet-4-6",
		estimatedInputTokens: estimateTokens(toolInput),
		maxOutputTokens: 1,
		params: { hook: "PreToolUse", tool_name: input.tool_name ?? "unknown" },
		actor: `claude-code:${sessionId}`,
		messages: [{ role: "user", content }],
	});
	const json =
		response.json && typeof response.json === "object" && !Array.isArray(response.json)
			? response.json
			: null;
	if (response.status === 200 && json?.shadow === true) {
		emit(
			"allow",
			`usertrust shadow mode: would_deny (${sanitizeReason(json.reason)}) — not enforced`,
		);
	} else if (response.status === 200) {
		if (typeof json?.transferId !== "string" || json.transferId === "") {
			throw new Error("malformed authorize response from governance server");
		}
		await recordPending(sessionId, agentId, {
			toolUseId: input.tool_use_id ?? null,
			transferId: json.transferId,
		});
		emit("allow", `usertrust: reserved ${json.transferId} (${json.estimatedCost} ut)`);
	} else if (response.status === 402 || response.status === 403) {
		emit(
			"deny",
			`usertrust ${sanitizeReason(json?.error, "denied")}: ${sanitizeReason(json?.reason)}`,
		);
	} else {
		throw new Error(`unexpected governance response ${response.status}`);
	}
} catch (err) {
	if (process.env.UT_FAIL_OPEN === "1") {
		emit(
			"allow",
			`usertrust unavailable — proceeding ungoverned (UT_FAIL_OPEN=1): ${err instanceof Error ? err.message : String(err)}`,
		);
	} else {
		process.stderr.write(
			`usertrust governance blocked this tool call because authorization failed closed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(2);
	}
}
