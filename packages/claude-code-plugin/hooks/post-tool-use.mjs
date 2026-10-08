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
// Estimate mode (an agent id unsafe in a path, or an agent whose estimate mode
// is recorded — UT_CC_USAGE=estimate, its transcript could not be read, a hook
// named none, or, for a subagent, another agent of its session is in estimate
// mode): the hold
// settles at the per-call estimate, labelled `usageSource: "estimated"`,
// exactly as the original hook did. The hold is marked settle-attempted
// (.json → .settling) BEFORE its one settle, and removed only AFTER a 200; on any
// other outcome it is left .settling, so Stop/SubagentStop cleanup gives it back
// and nothing settles it again (the server's TTL sweep is the final backstop).
// One failure is not ambiguous: a 404 `unknown transferId`
// means the hold is gone unposted — the server voids a pending hold after five
// minutes, and a call can wait that long at Claude Code's permission prompt — so
// the call is charged once on a fresh hold of its own (`settleEstimateHold`). That
// holds only for a hold recorded under the settle-attempt gate (lib.mjs
// `isGated`). One an earlier release recorded is never re-authorized: Stop only
// gives it back.
import { unlink } from "node:fs/promises";
import { resolveJob } from "./job-log.mjs";
import {
	claimForSettle,
	defaultModel,
	estimateTokens,
	giveBack,
	giveBackInvalid,
	isGated,
	isTransferId,
	jobHoldFields,
	MAX_CONTENT_CHARS,
	MAX_OUTPUT_TOKENS,
	readStdin,
	recordPending,
	recordUnconfirmedCall,
	say,
	serverCapabilities,
	serverRequest,
	takePendingEntry,
	timeLeft,
	usageMode,
} from "./lib.mjs";
import {
	authorizeLabels,
	estimatePrincipalFor,
	estimateReasonFor,
	OUTCOME_NOTES,
	settleLabels,
	settleTranscriptHold,
} from "./transcript.mjs";

/**
 * When an estimate hold's usage ended: now, but never past the next job switch. The call that
 * runs `usertrust-job start job-b` bills job-a, and its PostToolUse comes AFTER the switch, so
 * "now" would put job-a's record across the boundary into job-b's interval. Never before the
 * hold's own usageFrom.
 */
async function estimateUsageTo(sessionId, entry) {
	const from = Date.parse(entry.usageFrom);
	let end = Date.now();
	try {
		const boundary = (await resolveJob(sessionId)).boundaryAfter(from);
		if (boundary !== null && boundary < end) end = boundary;
	} catch {
		// no log to read: now
	}
	return new Date(Math.max(end, from)).toISOString();
}

/** One request of the expired-hold chain: 5 s at most, and never past the hook's budget. */
function withinBudget() {
	return { timeoutMs: Math.min(5000, timeLeft()) };
}

/** A settle's answer that its hold does not exist on the server (not an unknown route). */
function holdIsGone(response) {
	return response.status === 404 && response.json?.reason === "unknown transferId";
}

function noteIfAmbiguous(response, transferId) {
	if (response.json?.settled === false) {
		// The server's ledger post was ambiguous: the hold is spent either way.
		say(
			`usertrust: settle ${transferId} — the ledger post is ambiguous (settled: false); the usage may be unrecorded`,
		);
	}
}

/**
 * Settle an estimate hold at `usage`, ONCE. The hold is first marked
 * settle-attempted (`claimForSettle`: its .json becomes .settling), so no later
 * hook can pick it again. Every outcome but one keeps today's at-most-once
 * handling: a 200 retires the hold; no answer, a timeout, a 5xx or any other
 * status may mean the settle POSTED with its answer lost, so the hold is left
 * .settling for Stop, which only gives it back, and it is never re-authorized or
 * settled again.
 *
 * The one exception is a 404 `unknown transferId`, and it is safe only because
 * of an INVARIANT: this plugin settles each transferId AT MOST ONCE. PostToolUse
 * is the only settler of an estimate hold, and settles it once, past its
 * .settling gate. Stop and SubagentStop only release holds, and a transcript hold's
 * settle is gated by the same rename. The server keeps no record of settled ids (a
 * second settle of a posted id would also answer 404), so it is that invariant
 * that makes this 404 mean the hold is gone UNPOSTED: voided by the pending-TTL
 * sweep while the call waited at a permission prompt, or released. The call is
 * then charged once, on a fresh hold of its own — marked .settling from birth and
 * settled once; the old transferId is never settled again.
 *
 * The invariant covers only holds recorded under it: those whose file carries
 * `gate: 1` (lib.mjs `isGated`). An earlier release kept a hold whose settle
 * posted and lost its answer as a pending .json, so an unmarked hold's 404 may
 * mean it was charged already. Such a hold is kept .settling for Stop, which only
 * gives it back. It is never re-authorized.
 *
 * Every request in the chain (the settle, the fresh authorize, the fresh settle)
 * is capped at the time the hook has left (`withinBudget`), so the chain never
 * runs past the hook's budget into Claude Code's kill. A request the budget cuts
 * off leaves its hold .settling, and Stop gives it back.
 */
async function settleEstimateHold({ sessionId, agentId, entry, usage, input }) {
	const claimed = await claimForSettle(entry.path);
	if (claimed === null) {
		say(`usertrust: hold ${entry.transferId} is being settled by another hook`);
		return;
	}
	const response = await serverRequest(
		"/v1/settle",
		{ transferId: entry.transferId, ...usage },
		withinBudget(),
	);
	if (response.status === 200) {
		noteIfAmbiguous(response, entry.transferId);
		await unlink(claimed).catch(() => {});
		return;
	}
	if (!holdIsGone(response)) {
		say(
			`usertrust: settle ${entry.transferId} returned ${response.status}; hold kept for Stop cleanup`,
		);
		return;
	}
	if (!isGated(entry)) {
		say(
			`usertrust: settle ${entry.transferId} returned 404, but the hold was not recorded under the settle-attempt gate, so it may have been charged already; hold kept for Stop cleanup`,
		);
		return;
	}
	const capabilities = await serverCapabilities();
	const principal = capabilities?.has("principal")
		? estimatePrincipalFor(sessionId, agentId, input.agent_type)
		: undefined;
	const auth = await serverRequest(
		"/v1/authorize",
		{
			model: defaultModel(),
			...(typeof usage.inputTokens === "number" ? { estimatedInputTokens: usage.inputTokens } : {}),
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			params: {
				hook: "PostToolUse",
				tool_name: input.tool_name ?? "unknown",
				replaces: entry.transferId,
			},
			actor: `claude-code:${sessionId}`,
			...(principal === undefined ? {} : { principal }),
			// The replacement is the SAME call's charge: it carries the expired hold's job
			// and usage start, not whatever job is open now.
			...authorizeLabels(entry),
		},
		withinBudget(),
	);
	const transferId = auth.json?.transferId;
	if (
		auth.status !== 200 ||
		auth.json?.shadow === true ||
		typeof transferId !== "string" ||
		transferId === ""
	) {
		await unlink(claimed).catch(() => {});
		// The call RAN and nothing will charge it: its usage is unrecorded, which is a gap.
		await recordUnconfirmedCall(sessionId, { ...entry, agentId }, "call-ran");
		say(
			`usertrust: hold ${entry.transferId} expired before its settle, and its fresh hold was not granted (${auth.status}); this call's estimate is not recorded`,
		);
		return;
	}
	if (!isTransferId(transferId)) {
		// It would name the fresh hold's file, as it is (lib.mjs `isTransferId`): the
		// hold is given back, through `release` only, and never recorded.
		// The call RAN and this hold was to charge it: a gap, and the give-back says `call-ran`.
		await recordUnconfirmedCall(sessionId, { ...entry, agentId }, "call-ran");
		await giveBackInvalid(transferId, Math.max(250, Math.min(5000, timeLeft())), "call-ran");
		await unlink(claimed).catch(() => {});
		say(
			`usertrust: hold ${entry.transferId} expired before its settle, and its fresh hold's transferId is not a valid id, so it is not kept; this call's estimate is not recorded`,
		);
		return;
	}
	// The fresh hold is settle-attempted from birth: it replaces the expired one's
	// marker, so a settle of it that goes unanswered leaves it to Stop, never to a
	// second settle.
	let fresh;
	try {
		fresh = await recordPending(
			sessionId,
			agentId,
			{
				toolUseId: entry.toolUseId,
				transferId,
				...(typeof entry.startedAt === "string" ? { startedAt: entry.startedAt } : {}),
				...(typeof entry.estimatedInputTokens === "number"
					? { estimatedInputTokens: entry.estimatedInputTokens }
					: {}),
				// The replacement is the SAME call's charge: it keeps the expired hold's job and usage
				// start, so a Stop that finds it unanswered places its gap by when the call began.
				...jobHoldFields(entry),
			},
			{ settling: true },
		);
	} catch (err) {
		// Unrecorded, the fresh hold could never be settled, and Stop could not find
		// it: give it back now, as PreToolUse does on the same failure, rather than
		// leave its reservation held until the server's TTL sweep. This call's
		// estimate goes unrecorded: an under-count, never a second charge. The expired
		// hold's claim goes too, since its 404 said the server has no such hold.
		// The call RAN and this hold was to charge it: its estimate goes unrecorded, which is a
		// gap, and the give-back says so (`call-ran`).
		await recordUnconfirmedCall(sessionId, { ...entry, agentId }, "call-ran");
		const givenBack = await giveBack(
			transferId,
			"replacement hold could not be recorded",
			Math.max(250, Math.min(5000, timeLeft())),
			"call-ran",
		);
		await unlink(claimed).catch(() => {});
		say(
			`usertrust: hold ${entry.transferId} expired before its settle, and its fresh hold ${transferId} could not be recorded (${err instanceof Error ? err.message : String(err)}); ${givenBack ? `${transferId} was given back` : `${transferId} is left to the server's TTL sweep`}, and this call's estimate is not recorded`,
		);
		return;
	}
	if (fresh !== claimed) await unlink(claimed).catch(() => {});
	say(
		`usertrust: hold ${entry.transferId} expired before its settle (a long permission prompt?); charging this call once on ${transferId}`,
	);
	const settle = await serverRequest("/v1/settle", { transferId, ...usage }, withinBudget());
	if (settle.status === 200) {
		noteIfAmbiguous(settle, transferId);
		await unlink(fresh).catch(() => {});
	} else {
		say(`usertrust: settle ${transferId} returned ${settle.status}; hold kept for Stop cleanup`);
	}
}

try {
	const input = JSON.parse((await readStdin()) || "{}");
	const sessionId = input.session_id ?? "unknown";
	// Settle only this agent's holds; the session bucket is shared with siblings.
	const agentId = input.agent_id ?? "main";
	const entry = await takePendingEntry(sessionId, agentId, input.tool_use_id ?? null);
	if (entry?.usage === "transcript") {
		const result = await settleTranscriptHold(sessionId, entry);
		if (result.outcome !== "settled" && result.outcome !== "returned") {
			say(
				`usertrust: transcript hold ${entry.transferId} ${result.outcome} — ${result.reason ?? ""}${OUTCOME_NOTES.get(result.outcome) ?? ""}`,
			);
		}
	} else if (entry) {
		if (usageMode() === "transcript") {
			const reason = await estimateReasonFor({ sessionId, agentId, input });
			say(
				`usertrust: settling at the ESTIMATE — ${reason ?? "the hold was reserved in estimate mode"}`,
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
		const usage = {
			...(inputTokens != null ? { inputTokens } : {}),
			// Same 16 KiB cap as the output hold so a content-cap result cannot
			// price above the reservation (AUD-004).
			outputTokens: estimateTokens(
				JSON.stringify(input.tool_response ?? "").slice(0, MAX_CONTENT_CHARS),
			),
			usageSource: "estimated",
			// A hold authorized under the `job` capability names its job again, and says when
			// its usage ended (now). The usage START is the authorize capture's alone.
			...(typeof entry.usageFrom === "string"
				? settleLabels({ ...entry, usageTo: await estimateUsageTo(sessionId, entry) })
				: {}),
		};
		await settleEstimateHold({ sessionId, agentId, entry, usage, input });
	}
} catch (err) {
	say(
		`usertrust: settle failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
	);
}
