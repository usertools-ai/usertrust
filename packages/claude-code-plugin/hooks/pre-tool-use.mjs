// PreToolUse: authorize a spend reservation before the tool executes.
// Fail-closed: if governance cannot be reached (or answers with a malformed
// body), the tool call is blocked (exit 2) unless UT_FAIL_OPEN=1. Output
// contract adapted from the AGT Claude Code plugin's stdin-JSON
// permissionDecision convention (MIT — see repository NOTICE).
//
// Content minimization: tool_input is truncated at 16 KiB before it is sent
// (both message content and token estimation); UT_CC_SEND_CONTENT=0 replaces
// the content with {"redacted":true} while keeping the size-based estimate.
// The output hold uses that same 16 KiB bound so a large tool_response cannot
// price above the reservation (AUD-004).
//
// Transcript usage mode (the default): this hold is also the SETTLEMENT VEHICLE
// for the agent's new complete transcript messages — one model's worth, the
// "window" (see transcript.mjs). They are marked "authorizing" in the cursor
// before the authorize, the hold is sized to cover them PLUS the upcoming tool,
// and on a 200 they are assigned to this hold's transferId for PostToolUse to
// settle. On any other answer they are released: nothing was posted. With no
// window (nothing new, or another hook holds the agent's lock) the hold is the
// tool estimate alone, and PostToolUse gives it back.
//
// On a server that honours them (its /v1/health `capabilities`), a window's
// authorize carries the window's idempotency key — so the server charges those
// messages at most once, however often a settle of them is retried — and every
// transcript-mode authorize carries the agent's `principal`, which the server
// records. A key whose charge already stands (409 `already_settled`) means an
// earlier settle of exactly this window landed: it is accounted, and the tool is
// held alone.
import {
	estimateTokens,
	isAlreadySettled,
	MAX_CONTENT_CHARS,
	MAX_OUTPUT_TOKENS,
	readStdin,
	recordPending,
	releaseHold,
	serverCapabilities,
	serverRequest,
} from "./lib.mjs";
import { holdInputTokens, prepareWindow, safeName } from "./transcript.mjs";

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
	const estimatedInputTokens = estimateTokens(toolInput);
	const prepared = await prepareWindow({
		sessionId,
		agentId,
		agentTypeHint: input.agent_type,
		input,
	});
	if (prepared.becameSticky) {
		process.stderr.write(
			`usertrust: ${prepared.reason}; this agent now settles at the ESTIMATE for the rest of the session\n`,
		);
	}
	try {
		const transcriptMode = prepared.mode === "transcript";
		// What the server honours decides what this hold may carry (see lib.mjs).
		const capabilities = transcriptMode ? await serverCapabilities() : new Set();
		const keyed = capabilities.has("idempotency-key");
		const principal =
			transcriptMode && capabilities.has("principal") ? prepared.principal : undefined;
		let window = transcriptMode ? prepared.window : null;
		const fallbackModel = prepared.lastModel ?? process.env.UT_CC_MODEL ?? "claude-sonnet-4-6";
		const authorize = () =>
			serverRequest("/v1/authorize", {
				model: window?.model ?? fallbackModel,
				// Both legs: a 1-token output hold under-debited every large tool result
				// because settle prices the whole response (AUD-004). A window's usage is
				// ADDED, so the pre-call budget check still covers the upcoming tool.
				estimatedInputTokens: estimatedInputTokens + (window ? holdInputTokens(window.counts) : 0),
				maxOutputTokens: MAX_OUTPUT_TOKENS + (window ? Math.max(1, window.counts.outputTokens) : 0),
				params: window
					? {
							hook: "PreToolUse",
							tool_name: input.tool_name ?? "unknown",
							usageOrigin: "transcript",
							agent_id: agentId,
							agent_type: prepared.agentType,
							messages: window.ids.length,
						}
					: { hook: "PreToolUse", tool_name: input.tool_name ?? "unknown" },
				actor: window
					? `claude-code:${sessionId}:${prepared.agentType}:${safeName(agentId, "main")}`
					: `claude-code:${sessionId}`,
				messages: [{ role: "user", content }],
				...(window && keyed ? { idempotencyKey: prepared.key } : {}),
				...(principal === undefined ? {} : { principal }),
			});
		let response = await authorize();
		if (window && keyed && isAlreadySettled(response)) {
			// An earlier settle of exactly this window landed, though the cursor never
			// heard: account it, and hold the tool alone.
			await prepared.settledElsewhere();
			window = null;
			response = await authorize();
		}
		const json =
			response.json && typeof response.json === "object" && !Array.isArray(response.json)
				? response.json
				: null;
		if (response.status === 200 && json?.shadow === true) {
			await prepared.abandon?.();
			emit(
				"allow",
				`usertrust shadow mode: would_deny (${sanitizeReason(json.reason)}) — not enforced`,
			);
		} else if (response.status === 200) {
			if (typeof json?.transferId !== "string" || json.transferId === "") {
				throw new Error("malformed authorize response from governance server");
			}
			try {
				await recordPending(sessionId, agentId, {
					toolUseId: input.tool_use_id ?? null,
					transferId: json.transferId,
					estimatedInputTokens,
					...(transcriptMode
						? {
								usage: "transcript",
								holdModel: window?.model ?? fallbackModel,
								assignedIds: window?.ids ?? [],
								...(window?.counts ?? {}),
								...(window && keyed
									? { idempotencyKey: prepared.key, agentType: prepared.agentTypeRaw }
									: {}),
							}
						: {}),
				});
			} catch (err) {
				// Unrecorded, the hold could never be settled: give it back now.
				await releaseHold(json.transferId, "pending hold could not be recorded").catch(() => {});
				throw err;
			}
			await prepared.commit?.(json.transferId);
			emit("allow", `usertrust: reserved ${json.transferId} (${json.estimatedCost} ut)`);
		} else if (response.status === 402 || response.status === 403) {
			await prepared.abandon?.();
			emit(
				"deny",
				`usertrust ${sanitizeReason(json?.error, "denied")}: ${sanitizeReason(json?.reason)}`,
			);
		} else {
			throw new Error(`unexpected governance response ${response.status}`);
		}
	} catch (err) {
		// Nothing was posted for the window: release it before failing closed (or open).
		await prepared.abandon?.();
		throw err;
	} finally {
		await prepared.release?.();
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
