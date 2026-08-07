// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * attribution.ts — which operator envelope pays THIS call.
 *
 * One pure function, derived from nothing but the context the caller already
 * handed the wrapper and the operator's frozen config. There is no state here
 * on purpose: attribution is per-conversation by construction, so there is
 * nothing to isolate between callers and nothing to go stale on an error, a
 * consumer `break`, or an abandoned stream.
 *
 * The security model (design spec, "Security model — attribution authority vs.
 * labeling") is enforced by four rules, each one a class of failure:
 *
 *   TRAILING ONLY   — the tool-result run must be the LAST message(s) of the
 *                     context, i.e. the host asking the model to continue right
 *                     after executing tools. Anything after the run (a final
 *                     answer, a new user turn) resets attribution, so a single
 *                     `web_search` early in a conversation cannot silently bill
 *                     every later turn to `research`.
 *   CORRELATED      — each result must match, by `toolCallId` AND `toolName`, a
 *                     `ToolCall` the IMMEDIATELY preceding assistant turn
 *                     actually issued. A result block that correlates to
 *                     nothing is evidence of nothing.
 *   isError EXCLUDED— the host represents validation failures as error results
 *                     without a real execution, so only `isError === false`
 *                     counts. Anything else — `true`, missing, non-boolean — is
 *                     excluded; the conservative direction is to under-attribute
 *                     and fall back to `default`.
 *   STRUCTURED ONLY — every read is a structured field. Prose that says
 *                     "I called web_search" is text in a `content` block and can
 *                     never produce a `role: "toolResult"` message, so it can
 *                     never reach this function's comparisons.
 *
 * And the invariant that bounds all of it: the only strings this function can
 * RETURN are values of the operator's frozen `tools` map or its `default` —
 * both already validated to be `envelopes` keys. A tool name is only ever a
 * lookup key, never a cost center.
 *
 * Field names are CONTRACT-DETERMINED (contract-notes §2) and never guessed.
 */

import type { FrozenCostCenters } from "./types.js";

/**
 * Derive the cost center for a call from its context.
 *
 * `messages` is `unknown[]`, not `Message[]`, deliberately: in programmatic
 * mode the caller supplies the array directly, and a host that drifts from the
 * pinned contract must degrade to `default` rather than throw INTO the money
 * path. The array itself is narrowed first, then every entry in it.
 *
 * @returns the mapped cost center, else the config's `default`, else
 * `undefined` (unattributed — the call bills the session wallet).
 */
export function deriveAttribution(
	messages: unknown[],
	costCenters: FrozenCostCenters,
): string | undefined {
	const fallback = costCenters.default;

	// 0. The ARRAY itself, before any entry. Every entry below is narrowed, but
	//    `messages` is `unknown[]` by declaration only: a host that drops the
	//    field, or a programmatic caller that forwards a context it never built,
	//    hands us `undefined` — and `undefined.length` would throw INTO the
	//    money path, which is exactly what the degrade-to-`default` contract
	//    above exists to prevent. Non-arrays with a `length` (a string, a
	//    hand-rolled array-like) are refused here too, so nothing indexes an
	//    object that only LOOKS iterable.
	if (!Array.isArray(messages)) return fallback;

	// 1. The TRAILING run. Walking backwards from the end is what makes it
	//    trailing: the first entry that is not a tool-result message ends the
	//    run, so a run buried mid-context is never even considered.
	const run: Record<string, unknown>[] = [];
	let runStart = messages.length;
	while (runStart > 0) {
		const candidate = asRecord(messages[runStart - 1]);
		if (candidate?.role !== "toolResult") break;
		run.push(candidate);
		runStart--;
	}
	if (run.length === 0) return fallback;
	run.reverse();

	// 2. The turn that ISSUED those calls. `messages[-1]` is `undefined` for a
	//    run at index 0, which correlates to nothing — exactly right.
	const issued = issuedToolCalls(messages[runStart - 1]);
	if (issued === undefined) return fallback;

	// 3. First correlated, non-error, mapped name wins — in message order.
	for (const result of run) {
		// Only an explicit `false` is a real execution. `isError` is REQUIRED in
		// the pinned contract, so a missing one is malformed, not "not an error".
		if (result.isError !== false) continue;
		const { toolCallId, toolName } = result;
		if (typeof toolCallId !== "string" || typeof toolName !== "string") continue;
		if (issued.get(toolCallId) !== toolName) continue;
		// `Object.hasOwn`, never `in` and never a bare lookup: `tools` is a plain
		// object, so a tool named `toString` would otherwise resolve to
		// Object.prototype's function and be handed to `withCostCenter` as a
		// cost center. Every own value is a validated `envelopes` key.
		if (Object.hasOwn(costCenters.tools, toolName)) return costCenters.tools[toolName];
	}

	return fallback;
}

/** A non-null, non-array object, or `undefined` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * `ToolCall.id` → `ToolCall.name` for the tool calls an assistant turn issued,
 * or `undefined` when `message` is not an assistant turn at all (in which case
 * nothing in the run can correlate). Malformed blocks are skipped, so a single
 * bad entry cannot suppress the rest of the turn.
 */
function issuedToolCalls(message: unknown): Map<string, string> | undefined {
	const record = asRecord(message);
	if (record?.role !== "assistant" || !Array.isArray(record.content)) return undefined;

	const issued = new Map<string, string>();
	for (const block of record.content) {
		const call = asRecord(block);
		if (call?.type !== "toolCall") continue;
		if (typeof call.id !== "string" || typeof call.name !== "string") continue;
		issued.set(call.id, call.name);
	}
	return issued;
}
