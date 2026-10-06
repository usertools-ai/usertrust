// PreToolUse: authorize a spend reservation before the tool executes.
//
// The plugin NEVER grants permission: it can only deny. A call it does not block
// gets no permission decision at all (see `proceed`), so Claude Code's own
// permission flow decides it; a hook's `allow` would skip the user's permission
// prompt, a power a budget tool was never given.
//
// Watch-only by default (`guardMode` in lib.mjs): this hook NEVER blocks a tool
// call. A 402/403 denial is written down as a `would_block` record; a call that
// could not be metered (the server is unreachable, or answers with something
// unusable) is written down as a `gap` record. With UT_CC_MODE=enforce it
// blocks: a denial is enforced (`deny`), and a failed authorization fails closed
// (exit 2) unless UT_FAIL_OPEN=1, which lets the call through and records the
// gap. Output contract adapted from the AGT Claude Code plugin's stdin-JSON
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
// authorize, on the transcript path or the estimate path, carries the agent's
// `principal`, which the server records. A key whose charge already stands (409 `already_settled`) means an
// earlier settle of exactly this window landed: it is accounted, and the tool is
// held alone.
import {
	estimateTokens,
	guardMode,
	isAlreadySettled,
	MAX_CONTENT_CHARS,
	MAX_OUTPUT_TOKENS,
	readStdin,
	recordPending,
	recordWatchEvent,
	releaseHold,
	serverCapabilities,
	serverRequest,
	timeLeft,
} from "./lib.mjs";
import { estimatePrincipalFor, holdInputTokens, prepareWindow, safeName } from "./transcript.mjs";

const MAX_REASON_CHARS = 500;

/** Server-provided text goes through here: strip control chars, bound length. */
function sanitizeReason(value, fallback = "unspecified") {
	const text = typeof value === "string" && value !== "" ? value : fallback;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Block the call: the one permission decision this hook ever makes. */
function deny(reason) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason.slice(0, MAX_REASON_CHARS),
			},
		}),
	);
}

const mode = guardMode();

/**
 * Let the call through, in either mode, with NO decision: exit 0 with nothing on
 * stdout, which Claude Code reads as "no decision" — the call goes through the
 * user's normal permission flow. Never `allow`: that skips the permission prompt
 * (https://code.claude.com/docs/en/hooks#pretooluse-decision-control). The reason
 * goes to stderr: on exit 0, Claude Code's debug log, which is where an `allow`
 * reason went too.
 */
function proceed(reason) {
	process.stderr.write(`${reason.slice(0, MAX_REASON_CHARS)}\n`);
}

// Known before anything can fail, so a gap record can always say whose call it was.
let sessionId = "unknown";
let agentId = "main";
let toolName = "unknown";

try {
	const input = JSON.parse((await readStdin()) || "{}");
	sessionId = input.session_id ?? "unknown";
	// session_id is shared across the parent and all subagents; agent_id (absent
	// on older Claude Code) is what scopes a hold to the agent that made it.
	agentId = input.agent_id ?? "main";
	toolName = input.tool_name ?? "unknown";
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
		// Unknown (a failed probe) reads as absent here: a key is sent only to a server
		// known to honour it, and a principal — on either path, in one shape — only to
		// a server that records one.
		const capabilities = await serverCapabilities();
		const keyed = capabilities?.has("idempotency-key") ?? false;
		const principal = !capabilities?.has("principal")
			? undefined
			: transcriptMode
				? prepared.principal
				: estimatePrincipalFor(sessionId, agentId, input.agent_type);
		let window = transcriptMode ? prepared.window : null;
		const fallbackModel = prepared.lastModel ?? process.env.UT_CC_MODEL ?? "claude-sonnet-4-6";
		// Never past the hook's own budget: a hook killed mid-call leaves the tool
		// ungoverned and this agent's lock held.
		const callTimeout = () => Math.min(5_000, timeLeft() - 500);
		const authorize = () =>
			serverRequest(
				"/v1/authorize",
				{
					model: window?.model ?? fallbackModel,
					// Both legs: a 1-token output hold under-debited every large tool result
					// because settle prices the whole response (AUD-004). A window's usage is
					// ADDED, so the pre-call budget check still covers the upcoming tool.
					estimatedInputTokens:
						estimatedInputTokens + (window ? holdInputTokens(window.counts) : 0),
					maxOutputTokens:
						MAX_OUTPUT_TOKENS + (window ? Math.max(1, window.counts.outputTokens) : 0),
					params: window
						? {
								hook: "PreToolUse",
								tool_name: toolName,
								usageOrigin: "transcript",
								agent_id: agentId,
								agent_type: prepared.agentType,
								messages: window.ids.length,
							}
						: { hook: "PreToolUse", tool_name: toolName },
					actor: window
						? `claude-code:${sessionId}:${prepared.agentType}:${safeName(agentId, "main")}`
						: `claude-code:${sessionId}`,
					messages: [{ role: "user", content }],
					...(window && keyed ? { idempotencyKey: prepared.key } : {}),
					...(principal === undefined ? {} : { principal }),
				},
				{ timeoutMs: callTimeout() },
			);
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
			proceed(`usertrust shadow mode: would_deny (${sanitizeReason(json.reason)}) — not enforced`);
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
				await releaseHold(json.transferId, "pending hold could not be recorded", {
					timeoutMs: Math.max(250, callTimeout()),
				}).catch((giveBack) => {
					process.stderr.write(
						`usertrust: hold ${json.transferId} could not be given back (${giveBack instanceof Error ? giveBack.message : String(giveBack)}); the server's TTL sweep releases it\n`,
					);
				});
				throw err;
			}
			await prepared.commit?.(json.transferId);
			proceed(`usertrust: reserved ${json.transferId} (${json.estimatedCost} ut)`);
		} else if (response.status === 402 || response.status === 403) {
			await prepared.abandon?.();
			const error = sanitizeReason(json?.error, "denied");
			const reason = sanitizeReason(json?.reason);
			if (mode === "enforce") {
				deny(`usertrust ${error}: ${reason}`);
			} else {
				await recordWatchEvent({
					kind: "would_block",
					session: sessionId,
					agent: agentId,
					tool: toolName,
					status: response.status,
					error: error.slice(0, MAX_REASON_CHARS),
					reason: reason.slice(0, MAX_REASON_CHARS),
				});
				proceed(`usertrust watch-only: would have blocked (${error}: ${reason}) — not enforced`);
			}
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
	const why = sanitizeReason(err instanceof Error ? err.message : String(err)).slice(
		0,
		MAX_REASON_CHARS,
	);
	if (mode === "watch" || process.env.UT_FAIL_OPEN === "1") {
		// The call proceeds unmetered: say so durably, so the gap is never silent.
		await recordWatchEvent({
			kind: "gap",
			mode,
			session: sessionId,
			agent: agentId,
			tool: toolName,
			reason: why,
		});
		proceed(
			mode === "watch"
				? `usertrust watch-only: this call is not metered (${why}) — recorded as a gap`
				: `usertrust unavailable — proceeding ungoverned (UT_FAIL_OPEN=1): ${why}`,
		);
	} else {
		process.stderr.write(
			`usertrust governance blocked this tool call because authorization failed closed: ${why}\n`,
		);
		process.exit(2);
	}
}
