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
import { rename, unlink } from "node:fs/promises";
import { resolveJob } from "./job-log.mjs";
import {
	claimForRelease,
	claimForSettle,
	defaultModel,
	estimateTokens,
	giveBack,
	giveBackInvalid,
	guardMode,
	HoldNameTaken,
	holdOfCall,
	hookStartedAt,
	isAlreadySettled,
	isTransferId,
	isUnknownTransfer,
	jobCapable,
	MAX_CONTENT_CHARS,
	MAX_OUTPUT_TOKENS,
	readStdin,
	recordPending,
	recordWatchEvent,
	releaseHold,
	sanitizeReason,
	say,
	serverCapabilities,
	serverRequest,
	tenantBinding,
	timeLeft,
} from "./lib.mjs";
import {
	authorizeLabels,
	estimatePrincipalFor,
	holdEstimate,
	isoOf,
	OUTCOME_NOTES,
	prepareWindow,
	reconcileAgent,
	STALE_SETTLING_MS,
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
	// already has its hold. A second authorize alone would leave the first hold live
	// beside it: counting against the budget and, in transcript mode, its window
	// unsettled, until a Stop. A hold is never REUSED either: whether it is still
	// live, and still the current server's and tenant's, cannot be known from here,
	// and a reused hold skips the budget check. So the earlier hold is ended first
	// (`retire`), and the call then reserves afresh, its budget checked again. A hold
	// whose settle is under way or unanswered (`.settling`), or that another hook ends
	// first, gets no fresh hold beside it: the call is refused until that resolves
	// (`unsettled`).
	const held = await holdOfCall(sessionId, agentId, input.tool_use_id);
	if (held === null) {
		await reserve(input);
	} else if (held.state === "settling") {
		// One made under another server or key never reaches this tenant's journal,
		// which would retry a keyed window through this server: this tenant charged
		// for the other's usage.
		if (!sameTenant(held.entry)) {
			if (await abandonSettling(held.entry)) await reserve(input);
			else await unsettled(held.entry);
		} else if (await journalDecides(held.entry, input.tool_use_id)) await reserve(input);
		else await unsettled(held.entry);
	} else {
		// A hold made under another server or key is never touched through this one.
		const ended = sameTenant(held.entry) ? await retire(held.entry) : await abandon(held.entry);
		if (ended) {
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
	}
} catch (err) {
	const why = sanitizeReason(err instanceof Error ? err.message : String(err)).slice(
		0,
		MAX_REASON_CHARS,
	);
	if (err instanceof HoldNameTaken) {
		// A known state, not an outage: `reserve` did not keep the fresh hold, and the
		// call is refused rather than write over another hold's file, UT_FAIL_OPEN or not.
		await unsettled(
			null,
			`${why}: the fresh hold is not kept, and the call is refused rather than write over that file`,
		);
	} else if (mode === "watch" || process.env.UT_FAIL_OPEN === "1") {
		// The call proceeds unmetered: say so durably, so the gap is never silent.
		const recorded = await recordWatchEvent({
			started: new Date(hookStartedAt()).toISOString(),
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
 * Whether a pending record was made under the server and key this hook talks to
 * (lib.mjs `tenantBinding`). A record without a binding (written before the plugin
 * kept one) is not: its tenant is unknown.
 */
function sameTenant(entry) {
	const here = tenantBinding();
	return entry.serverUrl === here.serverUrl && entry.keyHash === here.keyHash;
}

/**
 * End an earlier hold made under ANOTHER server or key, or an unknown one, without
 * sending this hook's server anything about it. That server does not know the hold:
 * a settle there answers 404, and the unkeyed path would hand the old window to the
 * fresh hold, so this tenant would pay for the other's usage. The record is claimed
 * and dropped instead.
 * - A window it carried is then accounted by the journal as unrecorded (assigned ids
 *   whose hold is gone), never carried into the fresh hold: an under-count of the
 *   other tenant.
 * - The hold itself is left to its own server's sweep, or the ledger's timeout.
 * Returns false when another hook claimed the record first.
 */
async function abandon(entry) {
	const claimed = await claimForSettle(entry.path);
	if (claimed !== null) {
		say(
			`usertrust: this tool call's earlier hold ${entry.transferId} was made under another server or key; nothing about it is sent here, and any usage it carried goes unrecorded`,
		);
		await unlink(claimed).catch(() => {});
	}
	return claimed !== null;
}

/**
 * End a `.settling` record made under ANOTHER server or key, or an unknown one,
 * without this tenant's journal ever deciding it. Only a STALE one
 * (`STALE_SETTLING_MS`) is ended: a fresh one's settle may still be in flight, so
 * the call is refused instead. It is abandoned through its own name: claimed by an
 * exclusive rename, then deleted. Nothing about it is sent to this hook's server,
 * and nothing is parked for a retry. Any window it carried is accounted by the
 * journal as unrecorded (assigned ids whose hold is gone): an under-count of the
 * other tenant, never charged to this one. Returns false when the record is fresh,
 * or another hook took it first.
 */
async function abandonSettling(entry) {
	if (!(Date.now() - entry.mtimeMs > STALE_SETTLING_MS)) return false;
	const taken = `${entry.path}.abandoned.${process.pid}.${Math.random().toString(36).slice(2)}`;
	try {
		await rename(entry.path, taken);
	} catch {
		return false;
	}
	say(
		`usertrust: this tool call's earlier hold ${entry.transferId} was made under another server or key, and its settle never resolved; nothing about it is sent here, and any usage it carried goes unrecorded`,
	);
	await unlink(taken).catch(() => {});
	return true;
}

/**
 * Whether THIS hook's reconcile decided this call's `.settling` record, and removed
 * it. Only a transcript hold's record can be decided: the journal reads one as
 * abandoned once it is stale (transcript.mjs `STALE_SETTLING_MS`), parks its window
 * for a retry under its key or accounts its ids (at most once), and deletes its
 * file. A transcript record with no window (a `retire` cut off before its unlink)
 * is decided the same way. An estimate hold's record is not: its settle may have
 * charged the call. A fresh record may still be in flight.
 * True only when this hook's reconcile removed the record AND the call now has none.
 * Two hooks resumed together may both see the same stale record, and only the one
 * whose reconcile removed it reserves afresh: the other is refused.
 */
async function journalDecides(entry, toolUseId) {
	if (!entry.transcript) return false;
	const removed = await reconcileAgent(sessionId, agentId);
	return removed.includes(entry.path) && (await holdOfCall(sessionId, agentId, toolUseId)) === null;
}

/**
 * Refuse a tool call whose hold is not resolved: its earlier hold's settle is under
 * way, or was cut off unanswered (`.settling`), or another hook is ending it; or its
 * fresh hold's file name is another hold's (`HoldNameTaken`), and that hold was not
 * kept. No fresh hold is made beside an earlier one: that settle may already have
 * charged the call. Enforce mode denies, UT_FAIL_OPEN or not: the server is not
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
		started: new Date(hookStartedAt()).toISOString(),
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
 *   key at the next Stop. A settle that fails while the server does not confirm the
 *   hold is gone (`holdEnded`: its release unconfirmed, too) leaves it possibly
 *   live.
 * - Any other hold (an estimate, or an empty window) carries no usage: the call
 *   has not run. Its record is dropped. It is given back only through a `release`
 *   the server advertises; otherwise a hold the server still has is left to the
 *   server's TTL sweep. A release that answers neither 200 nor that the hold is gone
 *   leaves it possibly live: its record is kept settle-attempted, for Stop to give
 *   back.
 * Returns false when another hook claimed the hold first (its record renamed away):
 * that hook is ending it, and this call must not reserve beside it. A hold that
 * cannot be ended now (out of time, its claim fails, or its release is not
 * confirmed) throws: no fresh hold is made beside it, and the call fails as a failed
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
		if (result.holdEnded !== true) {
			// Its window's outcome is journalled as for any settle, but the hold itself
			// may still be live: no fresh hold is made beside it. The server's sweep
			// ends it.
			throw new Error(
				`hold ${entry.transferId} ${result.outcome}, and the server has not confirmed it is gone; no fresh hold is made beside it`,
			);
		}
		return true;
	}
	// This claim only ENDS a deferred call's hold, and says so in the name it claims into.
	const claimed = await claimForRelease(entry.path);
	if (claimed === null) return false;
	const capabilities = await serverCapabilities();
	if (capabilities?.has("release")) {
		const unconfirmed = await releaseUnconfirmed(entry.transferId);
		if (unconfirmed !== null) {
			// The hold may still be live: no fresh hold is made beside it. Its record
			// stays settle-attempted (`.settling`), so Stop gives it back, and the call
			// fails as a failed authorization does.
			throw new Error(
				`${unconfirmed}; the hold may be live, so it is kept for Stop to give back, and no fresh hold is made beside it`,
			);
		}
	}
	await unlink(claimed).catch(() => {});
	return true;
}

/**
 * Give a resumed call's earlier hold back through `release`, and say why the hold
 * may still be live: null once it is GONE, released (200) or no longer held by the
 * server (a 404 `unknown transferId`: it expired, or another hook ended it). Any
 * other answer, or none, leaves it possibly live.
 */
async function releaseUnconfirmed(transferId) {
	let response;
	try {
		response = await releaseHold(transferId, "a resumed tool call's earlier hold", {
			timeoutMs: Math.min(5000, timeLeft()),
			// The earlier hold belonged to a call that was deferred, not run.
			releaseClass: "unused",
		});
	} catch (err) {
		return `release ${transferId} failed (${err instanceof Error ? err.message : String(err)})`;
	}
	if (response.status === 200 || isUnknownTransfer(response)) return null;
	return `release ${transferId} returned ${response.status}`;
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
	// The job open at THIS call, from this session's own log read now (never cached):
	// a switch applies from the next call, so the call that runs `start job-b` still
	// bills job-a. Read only for a server that honours `job` (older servers strip the
	// keys, and an unlabelled hold must stay byte-identical to today's).
	const callMs = hookStartedAt();
	const jobs = (await jobCapable(await serverCapabilities())) ? await resolveJob(sessionId) : null;
	// A log stamped by a clock far AHEAD of this one (since corrected) makes this call's job unknown.
	const suspect = jobs !== null && jobs.suspectAt(callMs);
	const holdLabels = jobs === null ? {} : suspect ? { jobState: "invalid" } : jobs.at(callMs);
	const holdKey = jobs === null ? "none" : suspect ? "invalid" : jobs.keyAt(callMs);
	const prepared = await prepareWindow({
		sessionId,
		agentId,
		agentTypeHint: input.agent_type,
		input,
		jobs,
		holdKey,
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
		// What the hold is authorized with: its job, and when its usage began (the earlier
		// of this call and its first assigned message, so a window never starts after it
		// ends). Fixed here, from the capture the server will keep. Recomputed if the
		// window is dropped below.
		const labelsFor = () =>
			jobs === null
				? {}
				: {
						...holdLabels,
						usageFrom: isoOf(
							Math.min(
								callMs,
								window?.usageFrom === undefined ? callMs : Date.parse(window.usageFrom),
							),
						),
						...(window?.usageTo === undefined ? {} : { usageTo: window.usageTo }),
					};
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
					...authorizeLabels(labelsFor()),
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
			if (!isTransferId(json?.transferId)) {
				// The id would name the hold's file, as it is (lib.mjs `isTransferId`). A hold
				// it names is given back, through `release` only, and the call fails closed.
				await giveBackInvalid(json?.transferId, Math.max(250, callTimeout()));
				throw new Error(
					"malformed authorize response from governance server: its transferId is not a valid id",
				);
			}
			try {
				await recordPending(sessionId, agentId, {
					toolUseId: input.tool_use_id ?? null,
					transferId: json.transferId,
					startedAt: new Date(callMs).toISOString(),
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
					...labelsFor(),
				});
			} catch (err) {
				// Unrecorded, the hold could never be settled: give it back now. `giveBack`
				// reports a refused or failed give-back; the error below says the rest.
				await giveBack(
					json.transferId,
					"pending hold could not be recorded",
					Math.max(250, callTimeout()),
					// No call has run under a hold that was never recorded.
					"unused",
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
					started: new Date(hookStartedAt()).toISOString(),
					kind: "would_block",
					session: sessionId,
					agent: agentId,
					tool: toolName,
					status: response.status,
					error: error.slice(0, MAX_REASON_CHARS),
					reason: reason.slice(0, MAX_REASON_CHARS),
					// With the `job` capability, a refused call names its job (or why it has none).
					...(labelsFor().job === undefined ? {} : { job: labelsFor().job }),
					...(labelsFor().jobState === undefined ? {} : { jobState: labelsFor().jobState }),
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
