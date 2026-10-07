// PreToolUse: authorize a spend reservation before the tool executes.
//
// The plugin NEVER grants permission: it can only deny. A call it does not block
// gets no permission decision at all (see `proceed`), so Claude Code's own
// permission flow decides it; a hook's `allow` would skip the user's permission
// prompt, a power a budget tool was never given.
//
// Watch-only by default (`guardMode` in lib.mjs): this hook NEVER blocks a tool
// call. A 402/403/429 refusal is written down as a `would_block` record; a call
// that could not be metered (the server is unreachable, or answers with
// something unusable) is written down as a `gap` record. With UT_CC_MODE=enforce
// it blocks: a denial is enforced (`deny`), and a failed authorization fails closed
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
// tool estimate alone, and PostToolUse gives it back. So it is, too, while the
// agent's transcript state cannot be used (the state dir, a corrupt cursor):
// that usage stays in the transcript for a later settle point, and a hold
// settled at the estimate would charge it twice.
//
// On a server that honours them (its /v1/health `capabilities`), a window's
// authorize carries the window's idempotency key — so the server charges those
// messages at most once, however often a settle of them is retried — and every
// authorize carries the agent's `principal`, which the server records: built
// from the transcript on the transcript path, and from the hook's own input
// (`estimatePrincipalFor`) when no transcript is read — the estimate path, or
// while transcript state is unavailable. A key whose charge already stands (409
// `already_settled`) means an earlier settle of exactly this window landed: it
// is accounted, and the tool is held alone.
import { unlink } from "node:fs/promises";
import {
	claimForSettle,
	defaultModel,
	estimateTokens,
	giveBack,
	guardMode,
	holdOfCall,
	isAlreadySettled,
	MAX_CONTENT_CHARS,
	MAX_OUTPUT_TOKENS,
	readStdin,
	recordPending,
	recordWatchEvent,
	sanitizeReason,
	say,
	serverCapabilities,
	serverRequest,
	timeLeft,
} from "./lib.mjs";
import {
	estimatePrincipalFor,
	holdEstimate,
	OUTCOME_NOTES,
	prepareWindow,
	reconcileAgent,
	safeName,
	settleTranscriptHold,
} from "./transcript.mjs";

const MAX_REASON_CHARS = 500;

/** Block the call: the one permission decision this hook ever makes. */
function deny(reason) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: sanitizeReason(reason).slice(0, MAX_REASON_CHARS),
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
	say(reason, MAX_REASON_CHARS);
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
	// A deferred call's resume fires PreToolUse again for the SAME tool call (hooks
	// reference, "Defer a tool call for later"), and so might any repeat. That call
	// already has its hold. A second authorize alone would reserve a second hold, and
	// its record, keyed by the same tool_use_id, would overwrite the first's: the
	// first hold stranded until the server's TTL and, in transcript mode, its window
	// written off. A hold is never REUSED either: whether it is still live, and still
	// the current server's and tenant's, cannot be known from here, and a reused hold
	// skips the budget check. So the earlier hold is ended first (`retire`), and the
	// call then reserves afresh, its budget checked again. A hold whose settle is under
	// way or unanswered (`.settling`), or that another hook ends first, gets no fresh
	// hold beside it: the call is refused until that resolves (`unsettled`).
	const held = await holdOfCall(sessionId, agentId, input.tool_use_id);
	if (held === null) {
		await reserve(input);
	} else if (held.state === "settling") {
		if (await journalDecides(held.entry, input.tool_use_id)) await reserve(input);
		else await unsettled(held.entry);
	} else if (await retire(held.entry)) {
		say(
			`usertrust: this tool call's earlier hold ${held.entry.transferId} is ended: a resumed call never reuses a hold, so it reserves afresh`,
		);
		await reserve(input);
	} else {
		await unsettled(
			held.entry,
			`another hook is ending this tool call's earlier hold ${held.entry.transferId}; it is refused until that hold is resolved`,
		);
	}
} catch (err) {
	const why = sanitizeReason(err instanceof Error ? err.message : String(err)).slice(
		0,
		MAX_REASON_CHARS,
	);
	if (mode === "watch" || process.env.UT_FAIL_OPEN === "1") {
		// The call proceeds unmetered: say so durably, so the gap is never silent.
		const recorded = await recordWatchEvent({
			kind: "gap",
			mode,
			session: sessionId,
			agent: agentId,
			tool: toolName,
			reason: why,
		});
		proceed(
			mode === "watch"
				? `usertrust watch-only: this call is not metered (${why}) — ${recorded ? "recorded as a gap" : "and its gap record could not be written (see above)"}`
				: `usertrust unavailable — proceeding ungoverned (UT_FAIL_OPEN=1): ${why}`,
		);
	} else {
		say(`usertrust governance blocked this tool call because authorization failed closed: ${why}`);
		process.exit(2);
	}
}

/**
 * Whether the journal has decided this call's `.settling` record, and removed it.
 * Only a record that carries a transcript window can be decided: the journal reads
 * one as abandoned once it is stale (transcript.mjs `STALE_SETTLING_MS`), parks it
 * for a retry under its key or accounts its ids (at most once), and deletes its file.
 * A fresh one may still be in flight, and a record without a window has nothing the
 * journal could settle. True only once the file is GONE: a fresh hold's record would
 * share its path.
 */
async function journalDecides(entry, toolUseId) {
	if (entry.assignedIds.length === 0) return false;
	await reconcileAgent(sessionId, agentId);
	return (await holdOfCall(sessionId, agentId, toolUseId)) === null;
}

/**
 * Refuse a tool call whose earlier hold is not resolved: its settle is under way, or
 * was cut off unanswered (`.settling`), or another hook is ending it. No fresh hold is
 * made beside it: the two would share one record path, and that settle may already
 * have charged the call. Enforce mode denies, UT_FAIL_OPEN or not: the server is not
 * unreachable, the state is known. A later call (a new `tool_use_id`) reserves as
 * usual. Watch mode lets the call through unmetered, and records the gap.
 */
async function unsettled(
	entry,
	why = `this tool call's earlier hold ${entry.transferId} has a settle that is not resolved yet; it is refused until that settle resolves`,
) {
	if (mode === "enforce") {
		deny(`usertrust: ${why}`);
		return;
	}
	const recorded = await recordWatchEvent({
		kind: "gap",
		mode,
		session: sessionId,
		agent: agentId,
		tool: toolName,
		reason: why,
	});
	proceed(
		`usertrust watch-only: this call is not metered (${why}) — ${recorded ? "recorded as a gap" : "and its gap record could not be written (see above)"}`,
	);
}

/**
 * End this tool call's earlier pending hold before the call reserves afresh, and say
 * whether THIS hook ended it. The hold may be gone, or still live, and is ended once,
 * by a path that adds no abort (the server counts an abort as a breaker failure):
 * - A hold with a transcript window carries real usage. It gets the one settle
 *   PostToolUse would have given it (`settleTranscriptHold`), failure handling
 *   included. Live, it is charged once, at the window's counts. Gone (a 404), its
 *   window is released for the fresh hold to carry (no key), or retried under its
 *   key at the next Stop.
 * - Any other hold (an estimate, or an empty window) carries no usage: the call
 *   has not run. Its record is dropped. It is given back only through a `release`
 *   the server advertises; otherwise a hold the server still has is left to the
 *   server's TTL sweep.
 * Returns false when another hook claimed the hold first (its record renamed away):
 * that hook is ending it, and this call must not reserve beside it. A hold that
 * cannot be ended now (out of time, or its claim fails) throws: the fresh reserve,
 * which would overwrite its record, is not made, and the call fails as a failed
 * authorization does.
 */
async function retire(entry) {
	if ((entry.assignedIds?.length ?? 0) > 0) {
		const result = await settleTranscriptHold(sessionId, entry);
		if (result.outcome === "deferred") {
			throw new Error(`hold ${entry.transferId} could not be ended (${result.reason})`);
		}
		if (result.outcome === "skipped") return false;
		if (result.outcome !== "settled") {
			say(
				`usertrust: hold ${entry.transferId} ${result.outcome} — ${result.reason ?? ""}${OUTCOME_NOTES.get(result.outcome) ?? ""}`,
			);
		}
		return true;
	}
	const claimed = await claimForSettle(sessionId, agentId, entry.entryKey);
	if (claimed === null) return false;
	const capabilities = await serverCapabilities();
	if (capabilities?.has("release")) {
		await giveBack(
			entry.transferId,
			"a resumed tool call's earlier hold",
			Math.min(5000, timeLeft()),
		);
	}
	await unlink(claimed).catch(() => {});
	return true;
}

/**
 * Reserve this tool call's hold: the window (transcript mode), the authorize, and
 * the record PostToolUse settles. A call that already has a hold ends it first
 * (`retire`): a hold is never reused.
 */
async function reserve(input) {
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
		say(
			`usertrust: ${prepared.reason}; this agent now settles at the ESTIMATE for the rest of the session`,
		);
	}
	if (prepared.mode === "unavailable") {
		say(
			`usertrust: transcript usage unavailable for now (${prepared.reason}); this tool's hold will be given back, not settled at the estimate — the usage stays in the transcript for a later settle point`,
		);
	}
	try {
		const transcriptMode = prepared.mode === "transcript";
		// Only an estimate-mode hold settles at the estimate. Every other one is a
		// transcript hold: settled at its window's counts, or given back.
		const settlesAtEstimate = prepared.mode === "estimate";
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
		const fallbackModel = prepared.lastModel ?? defaultModel();
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
					...(window
						? holdEstimate(window.counts, capabilities, {
								toolInput: estimatedInputTokens,
								toolOutput: MAX_OUTPUT_TOKENS,
							})
						: { estimatedInputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS }),
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
					...(settlesAtEstimate
						? {}
						: {
								usage: "transcript",
								holdModel: window?.model ?? fallbackModel,
								assignedIds: window?.ids ?? [],
								...(window?.counts ?? {}),
								...(window && keyed
									? { idempotencyKey: prepared.key, agentType: prepared.agentTypeRaw }
									: {}),
							}),
				});
			} catch (err) {
				// Unrecorded, the hold could never be settled: give it back now. `giveBack`
				// reports a refused or failed give-back; the error below says the rest.
				await giveBack(
					json.transferId,
					"pending hold could not be recorded",
					Math.max(250, callTimeout()),
				);
				throw err;
			}
			await prepared.commit?.(json.transferId);
			// Server text, raw here: `proceed` writes it only through `say`, which
			// sanitizes it.
			proceed(`usertrust: reserved ${json.transferId} (${json.estimatedCost} ut)`);
		} else if (response.status === 402 || response.status === 403 || response.status === 429) {
			// A refusal — budget (402), policy (403) or an anomaly cutoff (429) — is a
			// governance decision, not an outage: enforce denies it whatever UT_FAIL_OPEN
			// says, and watch records what it would have blocked.
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
}
