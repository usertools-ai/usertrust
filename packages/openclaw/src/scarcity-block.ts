// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * scarcity-block.ts — pure helpers for the per-turn scarcity injection.
 *
 * Three pure, independently testable steps; `stream-governor.ts` is the only
 * place that sequences them with a real `Governor` and wraps the ledger read
 * in a try/catch (A8 — REPORTING ONLY, so a read failure degrades to no block
 * rather than gating, delaying, or throwing into the money path):
 *
 *   1. {@link envelopeDescriptorsFrom} — the operator's frozen `envelopes` as
 *      `EnvelopeDescriptor[]`, the shape `Governor.budgetContext` reads.
 *   2. {@link formatScarcityBlock} — `EnvelopeStatus[]` (the ledger read's
 *      answer) → the `[usertrust scarcity] …` string, or `null` when there is
 *      nothing to report.
 *   3. {@link injectScarcityBlock} — merges that string onto a COPY of the
 *      caller's `Context.systemPrompt` (contract-notes §4's valid injected-
 *      content shape); the caller's own object is never mutated.
 *   4. {@link estimationMessages} — the array `authorize()` actually receives:
 *      the FULL effective system prompt represented exactly once, since
 *      `authorize()` only ever sees `AuthorizeParams.messages`, never
 *      `Context.systemPrompt` (estimation honesty, contract-notes §4).
 */

import type { EnvelopeDescriptor, EnvelopeStatus } from "usertrust";
import type { Context, FrozenCostCenters } from "./types.js";

/**
 * The operator's frozen `envelopes` as the batch `Governor.budgetContext`
 * reads — every configured envelope, not only the one THIS call is
 * attributed to, so the model sees the whole picture it can plan against.
 */
export function envelopeDescriptorsFrom(costCenters: FrozenCostCenters): EnvelopeDescriptor[] {
	return Object.entries(costCenters.envelopes).map(([costCenter, envelope]) => ({
		costCenter,
		allocated: envelope.allocated,
		periodStartMs: envelope.periodStartMs,
		...(envelope.periodEndMs !== undefined ? { periodEndMs: envelope.periodEndMs } : {}),
	}));
}

/**
 * `EnvelopeStatus[]` → `[usertrust scarcity] research: 34% left (~2.1h
 * runway) · verification: 89% left`, or `null` for an empty batch (nothing to
 * report — e.g. the operator declared no envelopes at all).
 *
 * Format, pinned by tests: percent is `round(fraction · 100)`; the runway
 * clause is present only when `runwayHours` is non-null (`~X.Xh runway`, one
 * decimal); entries join on ` · `.
 */
export function formatScarcityBlock(statuses: EnvelopeStatus[]): string | null {
	if (statuses.length === 0) return null;
	const entries = statuses.map((status) => {
		const percent = Math.round(status.fraction * 100);
		const runway = status.runwayHours != null ? ` (~${status.runwayHours.toFixed(1)}h runway)` : "";
		return `${status.costCenter}: ${percent}% left${runway}`;
	});
	return `[usertrust scarcity] ${entries.join(" · ")}`;
}

/**
 * Merge a scarcity block onto a COPY of `context` — never the caller's own
 * object (contract-notes §4's valid injected-content shape, reproduced
 * verbatim). `block === null` means there is nothing to inject (disabled,
 * empty read, or a read/format failure already degraded upstream), so the
 * original `context` reference is returned untouched — still never mutated,
 * just not copied when there is no reason to.
 */
export function injectScarcityBlock(context: Context, block: string | null): Context {
	if (block === null) return context;
	return {
		...context,
		systemPrompt:
			context.systemPrompt == null || context.systemPrompt === ""
				? block
				: `${context.systemPrompt}\n\n${block}`,
	};
}

/**
 * The array `authorize()` receives for `estimateInputTokens` + `detectPII`
 * (headless.ts) — the ONLY two things that read `AuthorizeParams.messages`.
 * `authorize()` never sees `Context.systemPrompt`, so without this the
 * pre-call hold would under-cover what the stream call actually sends.
 *
 * `context` here is the ALREADY-INJECTED context (`injectScarcityBlock`'s
 * result), so its `systemPrompt` is the full effective value — pre-existing
 * plus the scarcity block when one was injected, or the pre-existing value
 * alone when it was not. Represented as ONE synthetic entry, prepended, so
 * the full effective prompt appears in the array exactly once. Never a
 * `Message` union member — the pinned contract has no system role
 * (contract-notes §4) — so this only ever feeds `AuthorizeParams.messages`
 * (typed `unknown[]`), never `Context.messages` itself.
 */
export function estimationMessages(context: Context): unknown[] {
	const prompt = context.systemPrompt;
	if (prompt == null || prompt === "") return context.messages;
	return [{ role: "system", content: prompt }, ...context.messages];
}
