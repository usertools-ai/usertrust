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
	safeName,
	settleTranscriptHold,
} from "./transcript.mjs";

const MAX_REASON_CHARS = 500;

/**
 * How long after its reservation a tool call fired again may REUSE its hold. The
 * hold may be gone after the server's pending TTL (`pendingTtlMs`, 300 s by
 * default) or the ledger's pending timeout (300 s in core). Neither reaches the
 * plugin: the authorize answer carries no expiry, and `/v1/health` names none. So
 * the bound is the plugin's own, a fifth of those defaults, counted from the
 * record's `reservedAt`: this machine's clock just BEFORE the authorize was sent,
 * so no later than the hold's own start. On the defaults, at least 240 s of the
 * TTL is left for the tool to run before PostToolUse settles. Reusing a hold that
 * may be gone would skip the budget check the resumed call needs: in enforce mode,
 * a call over budget would run, and then go uncharged when PostToolUse's
 * re-authorize is refused.
 */
const REUSE_WITHIN_MS = 60_000;

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
	// written off. So a hold young enough to be live is reused; an older one is ended
	// first (`retire`), and the call then reserves afresh, its budget checked again.
	// A hold whose settle is under way or unanswered (`.settling`) gets no second
	// hold: the call could be charged twice.
	const held = await holdOfCall(sessionId, agentId, input.tool_use_id);
	if (held === null) {
		await reserve(input);
	} else if (held.state === "settling") {
		proceed(
			`usertrust: this tool call's hold ${held.entry.transferId} is being settled; no second hold`,
		);
	} else if (mayReuse(held.entry)) {
		proceed(
			`usertrust: this tool call already holds ${held.entry.transferId}; reusing it, no second hold`,
		);
	} else {
		await retire(held.entry);
		await reserve(input);
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
 * Whether a pending hold is young enough to reuse: reserved less than
 * `REUSE_WITHIN_MS` ago by this machine's clock. A record without that time
 * (written before the plugin recorded it) is not, and nor is one that reads as
 * reserved in the future: the clock was set back, so its age is unknown.
 */
function mayReuse(entry) {
	const age = Date.now() - (entry.reservedAt ?? Number.NaN);
	return age >= 0 && age < REUSE_WITHIN_MS;
}

/**
 * End a pending hold too old to reuse (`mayReuse`) before the call reserves
 * afresh. The hold may be gone, or still live. It is ended once, by a path that
 * adds no abort (the server counts an abort as a breaker failure):
 * - A hold with a transcript window carries real usage. It gets the one settle
 *   PostToolUse would have given it (`settleTranscriptHold`), failure handling
 *   included. Live, it is charged once, at the window's counts. Gone (a 404), its
 *   window is released for the fresh hold to carry (no key), or retried under its
 *   key at the next Stop.
 * - Any other hold (an estimate, or an empty window) carries no usage: the call
 *   has not run. Its record is dropped. It is given back only through a `release`
 *   the server advertises; otherwise a hold the server still has is left to the
 *   server's TTL sweep.
 * A hold that cannot be ended now (out of time, or its record cannot be claimed)
 * stops the fresh reserve, which would overwrite its record: the call then fails
 * as a failed authorization does.
 */
async function retire(entry) {
	say(
		`usertrust: this tool call's hold ${entry.transferId} is too old to reuse (it may have expired); ending it and reserving afresh`,
	);
	if ((entry.assignedIds?.length ?? 0) > 0) {
		const result = await settleTranscriptHold(sessionId, entry);
		if (result.outcome === "deferred") {
			throw new Error(`hold ${entry.transferId} could not be ended (${result.reason})`);
		}
		if (result.outcome !== "settled") {
			say(
				`usertrust: hold ${entry.transferId} ${result.outcome} — ${result.reason ?? ""}${OUTCOME_NOTES.get(result.outcome) ?? ""}`,
			);
		}
		return;
	}
	const claimed = await claimForSettle(sessionId, agentId, entry.entryKey);
	if (claimed === null) return; // Another hook took it first.
	const capabilities = await serverCapabilities();
	if (capabilities?.has("release")) {
		await giveBack(
			entry.transferId,
			"a resumed tool call's hold, too old to reuse",
			Math.min(5000, timeLeft()),
		);
	}
	await unlink(claimed).catch(() => {});
}

/**
 * Reserve this tool call's hold: the window (transcript mode), the authorize, and
 * the record PostToolUse settles. A call that already has a hold reuses it while
 * it is young enough (`mayReuse`), and otherwise ends it first (`retire`).
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
		// Taken before the authorize, so never later than the hold's own start.
		const reservedAt = Date.now();
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
					reservedAt,
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
