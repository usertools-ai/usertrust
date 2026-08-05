// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Budget-aware policy tiers (T3).
 *
 * Two things are pinned here:
 *
 * 1. `budgetFractionRemaining` and `budgetRunwayHours` are declared, typed,
 *    OPTIONAL numbers on PolicyContext, so a tier ladder is expressible with the
 *    operators that already exist (`lt`/`lte`/`gte` + `in`). No new operator.
 *
 * 2. The evaluator does NOT special-case them. A budget field resolves through
 *    the same dot-notation path as any other caller-supplied field, and an
 *    ABSENT budget field inherits the existing indeterminate split unchanged:
 *    hard rules fail CLOSED (the guard still fires), soft rules stay lenient.
 *    Both directions are asserted against the live evaluator rather than
 *    assumed, and a differential case proves the new names get no special
 *    handling.
 *
 * 3. The three SDK call sites treat both fields as trusted-host input: the
 *    caller's request body is spread into the PolicyContext, so a body carrying
 *    `budgetFractionRemaining` must not survive into the evaluator. Each call
 *    site is driven end to end with an attacker-shaped body and the context the
 *    evaluator actually received is inspected.
 *
 * `escalate` is not a PolicyEffect — the union is `deny | warn`. The escalation
 * tier is therefore expressed as `effect: "warn"` + `enforcement: "soft"`, which
 * is the "surface it to a human, do not block" signal the gate already emits.
 *
 * SECURITY (D17): never log a whole PolicyContext in test or debug output.
 * PolicyContext extends `Record<string, unknown>` and upstream callers populate
 * it with request-shaped data — prompt text, tool arguments, actor identifiers.
 * Dumping one into CI output can leak secrets that are hard to unpublish.
 * Assert on individual fields; never `console.log(ctx)` or snapshot a context.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCostCenter } from "../../src/budget/attribution.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { DEFAULT_RULES } from "../../src/policy/default-rules.js";
import {
	derivePolicyHint,
	evaluatePolicy,
	type GateRule,
	type PolicyContext,
} from "../../src/policy/gate.js";
import type { PolicyEnforcement } from "../../src/shared/types.js";

// tigerbeetle-node is a native module and is never loaded in tests.
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// The evaluator itself is REAL — this only records the context each call site
// hands it, so the trust-boundary tests can assert on what the gate actually
// saw rather than on a decision that could be right for the wrong reason.
vi.mock("../../src/policy/gate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/policy/gate.js")>();
	return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

// ---------------------------------------------------------------------------
// The tier ladder under test
// ---------------------------------------------------------------------------

/** Tier 1 — hard stop: no frontier model once the allocation is nearly gone. */
const DENY_FRONTIER_BELOW_30: GateRule = {
	id: "budget-tier-frontier",
	name: "frontier-model-below-30pct",
	description: "Frontier models are blocked below 30% of the cost center's allocation",
	effect: "deny",
	enforcement: "hard",
	severity: "high",
	conditions: [
		{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
		{ field: "model", operator: "in", value: ["claude-opus-4-6"] },
	],
};

/** Tier 2 — escalate: warn a human when less than half a day of runway is left. */
const ESCALATE_BELOW_12H: GateRule = {
	id: "budget-tier-runway",
	name: "runway-below-12h",
	description: "Under 12h of projected runway — escalate before continuing",
	effect: "warn",
	enforcement: "soft",
	severity: "medium",
	conditions: [{ field: "budgetRunwayHours", operator: "lt", value: 12 }],
};

/** A rule that touches no budget field at all — the "behaves as today" control. */
const DENY_PII: GateRule = {
	id: "pii-block",
	name: "pii-block",
	effect: "deny",
	enforcement: "hard",
	conditions: [{ field: "containsPii", operator: "eq", value: true }],
};

// ---------------------------------------------------------------------------
// Tier 1 — budgetFractionRemaining gates a model class
// ---------------------------------------------------------------------------

describe("budgetFractionRemaining tier", () => {
	it("denies a frontier call at 0.2 remaining", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.2,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
		expect(result.hardViolations.map((v) => v.name)).toEqual(["frontier-model-below-30pct"]);
		expect(result.reasons).toEqual([
			"[budget-tier-frontier] Frontier models are blocked below 30% of the cost center's allocation",
		]);
	});

	it("does not match at 0.9 remaining", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.9,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
		expect(result.reasons).toEqual([]);
	});

	it("does not match a cheap model even when the budget is nearly gone", () => {
		// Both conditions are ANDed: the tier gates a model CLASS, not all spend.
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.05,
			model: "claude-haiku-4-5",
		});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
	});

	it("treats the threshold as strict — exactly 0.3 does not match", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.3,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
	});

	it("denies at an exhausted budget (0 remaining)", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
	});
});

// ---------------------------------------------------------------------------
// Tier 2 — budgetRunwayHours escalates
// ---------------------------------------------------------------------------

describe("budgetRunwayHours tier", () => {
	it("escalates below 12h of runway without blocking the call", () => {
		const result = evaluatePolicy([ESCALATE_BELOW_12H], { budgetRunwayHours: 6 });

		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(true);
		expect(result.softViolations.map((v) => v.name)).toEqual(["runway-below-12h"]);
		expect(result.hardViolations).toEqual([]);
		expect(result.reasons).toEqual([
			"[WARN] [budget-tier-runway] Under 12h of projected runway — escalate before continuing",
		]);
	});

	it("stays quiet with plenty of runway", () => {
		const result = evaluatePolicy([ESCALATE_BELOW_12H], { budgetRunwayHours: 48 });

		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(false);
		expect(result.matched).toHaveLength(0);
	});

	it("escalates and denies independently on the same context", () => {
		// The full ladder: a frontier call at 5% budget with 2h of runway trips
		// both tiers — deny wins the decision, the warning still surfaces.
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30, ESCALATE_BELOW_12H], {
			budgetFractionRemaining: 0.05,
			budgetRunwayHours: 2,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
		expect(result.hasWarnings).toBe(true);
		expect(result.matched.map((m) => m.name)).toEqual([
			"frontier-model-below-30pct",
			"runway-below-12h",
		]);
	});
});

// ---------------------------------------------------------------------------
// Absent budget fields — the existing behaviour, pinned rather than assumed
// ---------------------------------------------------------------------------

describe("absent budget fields", () => {
	it("does not match a SOFT budget rule when the field is absent", () => {
		// `lt` on a missing field is indeterminate; soft rules stay lenient.
		const result = evaluatePolicy([ESCALATE_BELOW_12H], { model: "claude-opus-4-6" });

		expect(result.matched).toHaveLength(0);
		expect(result.hasWarnings).toBe(false);
		expect(result.decision).toBe("allow");
	});

	it("MATCHES a HARD budget rule when the field is absent (fail closed)", () => {
		// Pinned, not assumed. `evaluateFieldCondition` returns "indeterminate"
		// for a numeric operator on a missing field, and `ruleMatches` SKIPS an
		// indeterminate condition for hard rules so the guard still fires. A hard
		// budget tier therefore DENIES on a context that never populated budget
		// data — the caller must supply the field or gate the rule with `exists`.
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], { model: "claude-opus-4-6" });

		expect(result.decision).toBe("deny");
		expect(result.hardViolations.map((v) => v.name)).toEqual(["frontier-model-below-30pct"]);
	});

	it("lets an `exists` guard keep a hard tier from firing on a budget-less context", () => {
		// `exists` returns a real boolean (never indeterminate), so it short-
		// circuits the rule before the fail-closed numeric condition is reached.
		// This is the pattern the PolicyContext doc comment points callers at.
		const guarded: GateRule = {
			id: "budget-tier-guarded",
			name: "guarded-frontier-tier",
			effect: "deny",
			enforcement: "hard",
			conditions: [
				{ field: "budgetFractionRemaining", operator: "exists" },
				{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
			],
		};

		expect(evaluatePolicy([guarded], { model: "claude-opus-4-6" }).decision).toBe("allow");
		expect(evaluatePolicy([guarded], { budgetFractionRemaining: 0.2 }).decision).toBe("deny");
		expect(evaluatePolicy([guarded], { budgetFractionRemaining: 0.9 }).decision).toBe("allow");
	});

	it("treats an absent budget field identically to any other absent field", () => {
		// Differential: the same rule shape pointed at a budget field and at a
		// field name the evaluator has never heard of. Identical verdicts under
		// BOTH enforcement levels prove the new names get no special handling —
		// this is what "behaves exactly as today" means for the evaluator.
		const enforcements: PolicyEnforcement[] = ["hard", "soft"];

		for (const enforcement of enforcements) {
			const onBudgetField: GateRule = {
				name: "probe",
				effect: "deny",
				enforcement,
				conditions: [{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 }],
			};
			const onUnknownField: GateRule = {
				name: "probe",
				effect: "deny",
				enforcement,
				conditions: [{ field: "someFieldNobodyDeclared", operator: "lt", value: 0.3 }],
			};

			const budget = evaluatePolicy([onBudgetField], { model: "claude-opus-4-6" });
			const unknown = evaluatePolicy([onUnknownField], { model: "claude-opus-4-6" });

			expect(budget.decision).toBe(unknown.decision);
			expect(budget.matched).toHaveLength(unknown.matched.length);
			expect(budget.reasons).toEqual(unknown.reasons);
		}
	});

	it("leaves non-budget rules working on a context with no budget fields", () => {
		expect(evaluatePolicy([DENY_PII], { containsPii: true }).decision).toBe("deny");
		expect(evaluatePolicy([DENY_PII], { containsPii: false }).decision).toBe("allow");
		expect(evaluatePolicy([DENY_PII], { containsPii: false }).matched).toHaveLength(0);
	});

	it("evaluates a mixed rule set unchanged when no budget data is supplied", () => {
		// A soft budget tier alongside an unrelated hard rule: the budget tier is
		// silent, the unrelated rule decides — exactly as before this change.
		const result = evaluatePolicy([ESCALATE_BELOW_12H, DENY_PII], { containsPii: true });

		expect(result.decision).toBe("deny");
		expect(result.hasWarnings).toBe(false);
		expect(result.matched.map((m) => m.name)).toEqual(["pii-block"]);
	});
});

// ---------------------------------------------------------------------------
// Type surface
// ---------------------------------------------------------------------------

describe("PolicyContext budget fields", () => {
	it("exposes both fields as typed optional numbers", () => {
		const ctx: PolicyContext = { budgetFractionRemaining: 0.42, budgetRunwayHours: 7.5 };

		// These assignments only compile because the fields are DECLARED as
		// `number | undefined`. Without the declaration they fall through the
		// `Record<string, unknown>` index signature and resolve to `unknown`,
		// which is not assignable to `number`.
		const fraction: number = ctx.budgetFractionRemaining ?? 1;
		const runway: number = ctx.budgetRunwayHours ?? Number.POSITIVE_INFINITY;

		expect(fraction).toBeCloseTo(0.42);
		expect(runway).toBeCloseTo(7.5);
	});

	it("keeps both fields optional", () => {
		const ctx: PolicyContext = { scope: ["llm:*"] };

		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Call-site trust boundary — a request body cannot supply budget telemetry
// ---------------------------------------------------------------------------

/**
 * Every call site spreads the caller's request body into the PolicyContext
 * FIRST so trusted governance fields can be re-asserted over it. A budget tier
 * is only a control if its inputs are on the trusted side of that line: a body
 * of `{"model":"claude-opus-4-6","budgetFractionRemaining":0.95}` must not be
 * able to answer the very question the tier asks.
 *
 * The probe is a hard `exists` deny on each field — it fires if and only if the
 * caller's value reached the evaluator, so a bypass shows up as a denial and a
 * regression cannot hide behind a rule that happened not to match.
 */
const PROBE_MARKER = "budget-tier-trust-boundary";

const PROBE_BODY_FIELDS = {
	budgetFractionRemaining: 0.95,
	budgetRunwayHours: 999,
	probe_marker: PROBE_MARKER,
};

const PROBE_RULES = [
	{
		name: "probe-fraction-reached-evaluator",
		effect: "deny",
		enforcement: "hard",
		conditions: [{ field: "budgetFractionRemaining", operator: "exists" }],
	},
	{
		name: "probe-runway-reached-evaluator",
		effect: "deny",
		enforcement: "hard",
		conditions: [{ field: "budgetRunwayHours", operator: "exists" }],
	},
];

function makeProbeVault(): string {
	const base = join(tmpdir(), `budget-tier-${randomUUID()}`);
	const usertrustDir = join(base, ".usertrust");
	mkdirSync(join(usertrustDir, "policies"), { recursive: true });
	writeFileSync(
		join(usertrustDir, "policies", "probe.json"),
		JSON.stringify({ rules: PROBE_RULES }),
	);
	writeFileSync(
		join(usertrustDir, "usertrust.config.json"),
		JSON.stringify({ budget: 100_000, policies: "./policies/probe.json" }),
	);
	return base;
}

function makeAnthropicMock() {
	return {
		messages: {
			create: vi.fn(async (_body: Record<string, unknown>) => ({
				id: "msg_probe",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

/** The single context the evaluator saw for the probe call. */
function probeContext(): PolicyContext {
	const contexts = vi
		.mocked(evaluatePolicy)
		.mock.calls.map(([, ctx]) => ctx)
		.filter((ctx) => ctx.probe_marker === PROBE_MARKER);

	const ctx = contexts[0];
	if (ctx === undefined) {
		throw new Error("the policy evaluator never saw the probe call");
	}
	// More than one would make the assertions below ambiguous about which call
	// site is under test.
	expect(contexts).toHaveLength(1);
	return ctx;
}

describe("budget fields are trusted-host input at every call site", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeProbeVault();
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("strips body-supplied budget fields on the trust() LLM path", async () => {
		const client = makeAnthropicMock();
		const governed = await trust(client, { dryRun: true, vaultBase });

		await governed.messages.create({
			model: "claude-opus-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "hello" }],
			...PROBE_BODY_FIELDS,
		});

		const ctx = probeContext();
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();
		// The rest of the body DID land in the context — proof the probe fields
		// travelled the same spread and were overwritten, not simply dropped by a
		// call that never reached the gate.
		expect(ctx.probe_marker).toBe(PROBE_MARKER);
		expect(ctx.model).toBe("claude-opus-4-6");
		// The `exists` probes did not fire, so the provider call went out.
		expect(client.messages.create).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("strips params-supplied budget fields on the governAction path", async () => {
		const governed = await trust(makeAnthropicMock(), { dryRun: true, vaultBase });
		const execute = vi.fn(async () => "executed");

		await governed.governAction(
			{ kind: "tool_use", name: "probe_tool", cost: 25, params: { ...PROBE_BODY_FIELDS } },
			execute,
		);

		const ctx = probeContext();
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();
		expect(ctx.probe_marker).toBe(PROBE_MARKER);
		expect(ctx.action_name).toBe("probe_tool");
		expect(execute).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("strips params-supplied budget fields on the headless authorize path", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase });

		const auth = await gov.authorize({
			model: "claude-opus-4-6",
			estimatedInputTokens: 10,
			maxOutputTokens: 10,
			params: { ...PROBE_BODY_FIELDS },
		});

		const ctx = probeContext();
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();
		expect(ctx.probe_marker).toBe(PROBE_MARKER);
		expect(ctx.model).toBe("claude-opus-4-6");
		// The `exists` probes did not fire, so authorization was granted.
		expect(auth.transferId).toMatch(/^tx_/);

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// The tier stops shadow-boxing: an ATTRIBUTED call actually fires it
// ---------------------------------------------------------------------------

/**
 * Until envelopes, `budgetFractionRemaining` could not fire on ANY SDK-governed
 * call. Both `trust()` call sites and headless `authorize` asserted it explicitly
 * `undefined` — honestly, because nothing in the repo debited a cost-center wallet
 * — so the `exists` guard the gate's own doc comment recommends never matched, and
 * a tier written exactly as documented was a rule that could only ever be dead
 * code. (Worse for a host that built the context itself: `getBudgetStatus`
 * reported `fractionRemaining: 1` for a genuinely burning agent, so the tier
 * failed OPEN.)
 *
 * A call inside `withCostCenter(cc, fn, { allocated, periodStartMs })` now carries
 * the envelope's LIVE ledger balance into the field. These three pin the whole
 * behaviour change: the tier fires on an attributed call below the threshold,
 * stays quiet on one above it, and — because the `exists` guard is still doing its
 * job — leaves unattributed traffic exactly as it was.
 */
const ENVELOPE_TIER_RULE = {
	id: "envelope-tier-frontier",
	name: "frontier-model-below-30pct",
	effect: "deny",
	enforcement: "hard",
	severity: "high",
	conditions: [
		{ field: "budgetFractionRemaining", operator: "exists" },
		{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
		{ field: "model", operator: "in", value: ["claude-opus-4-6"] },
	],
};

const ENVELOPE_PARENT = "acme";
const ENVELOPE_COST_CENTER = "research";
/** 10_000 allocated: `remaining` below 3_000 is what has to trip the rule. */
const ENVELOPE_SCOPE = { allocated: 10_000, periodStartMs: Date.UTC(2026, 7, 3, 0, 0, 0) };

function makeTierVault(): string {
	const base = join(tmpdir(), `budget-tier-envelope-${randomUUID()}`);
	const usertrustDir = join(base, ".usertrust");
	mkdirSync(join(usertrustDir, "policies"), { recursive: true });
	writeFileSync(
		join(usertrustDir, "policies", "tier.json"),
		JSON.stringify({ rules: [ENVELOPE_TIER_RULE] }),
	);
	writeFileSync(
		join(usertrustDir, "usertrust.config.json"),
		JSON.stringify({ budget: 1_000_000, policies: "./policies/tier.json" }),
	);
	return base;
}

/** An engine whose envelope read answers `remaining` for every account asked for. */
function makeEnvelopeEngine(remaining: number) {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		lookupBalances: vi.fn(async (ids: bigint[]) => new Map(ids.map((id) => [id, remaining]))),
		destroy: vi.fn(),
	};
}

const FRONTIER_CALL = {
	model: "claude-opus-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hello" }],
};

describe("an envelope-scoped tier fires on an attributed call", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTierVault();
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("DENIES a frontier call at 20% of the envelope — the case that could not fire before", async () => {
		const engine = makeEnvelopeEngine(2_000);
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			vaultBase,
			parentUserId: ENVELOPE_PARENT,
			_engine: engine,
		});

		await expect(
			withCostCenter(
				ENVELOPE_COST_CENTER,
				() => governed.messages.create(FRONTIER_CALL),
				ENVELOPE_SCOPE,
			),
		).rejects.toThrow(/Policy denied/);

		// The number came off the ledger, not off the request body.
		const ctx = vi.mocked(evaluatePolicy).mock.calls.at(-1)?.[1];
		expect(ctx?.budgetFractionRemaining).toBeCloseTo(0.2);
		// A hard deny is a PRE-spend deny: no hold, no provider call.
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.messages.create).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("stays quiet on the same call when the envelope is at 90%", async () => {
		const engine = makeEnvelopeEngine(9_000);
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			vaultBase,
			parentUserId: ENVELOPE_PARENT,
			_engine: engine,
		});

		await withCostCenter(
			ENVELOPE_COST_CENTER,
			() => governed.messages.create(FRONTIER_CALL),
			ENVELOPE_SCOPE,
		);

		const ctx = vi.mocked(evaluatePolicy).mock.calls.at(-1)?.[1];
		expect(ctx?.budgetFractionRemaining).toBeCloseTo(0.9);
		expect(client.messages.create).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("leaves UNATTRIBUTED traffic untouched — the `exists` guard still holds it back", async () => {
		const engine = makeEnvelopeEngine(2_000);
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			vaultBase,
			parentUserId: ENVELOPE_PARENT,
			_engine: engine,
		});

		await governed.messages.create(FRONTIER_CALL);

		const ctx = vi.mocked(evaluatePolicy).mock.calls.at(-1)?.[1];
		// No scope, no envelope, no number to gate on — asserted absent, never
		// guessed, and never taken from the request body.
		expect(ctx?.budgetFractionRemaining).toBeUndefined();
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect(client.messages.create).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("an ATTRIBUTED denial's hint prescribes the envelope lever that can actually move it", async () => {
		const engine = makeEnvelopeEngine(2_000);
		const governed = await trust(makeAnthropicMock(), {
			vaultBase,
			parentUserId: ENVELOPE_PARENT,
			_engine: engine,
		});

		const err = await budgetDenialFrom(() =>
			withCostCenter(
				ENVELOPE_COST_CENTER,
				() => governed.messages.create(FRONTIER_CALL),
				ENVELOPE_SCOPE,
			),
		);

		// This hold WOULD have debited the envelope, so funding the envelope is a
		// remedy that exists.
		expect(err.hint).toContain("allocateBudget");

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Denial-hint ATTRIBUTION: the remedy must match the wallet that was gated
// ---------------------------------------------------------------------------

/**
 * An UNATTRIBUTED call places its hold on the SESSION holding wallet — no
 * envelope exists for `allocateBudget` to fund, so the envelope remedy is not
 * merely unhelpful, it is unreachable. These pin that all three gate call sites
 * pass their own local truth about whether an envelope is in scope.
 *
 * The rule under test here is the platform default `block-budget-overshoot`
 * (`budget_remaining_after lt 0`), which is BUDGET-classed and, unlike the tier
 * rules above, needs no envelope to fire — exactly the unattributed case.
 */
const SESSION_HINT =
	"A budget rule denied this call: increase the budget in trust() options or reduce the call's max_tokens, and review your budget_remaining / budget_remaining_after tiers.";

/** Run `fn`, require a PolicyDeniedError, and return it. */
async function budgetDenialFrom(fn: () => Promise<unknown>): Promise<{ hint: string }> {
	try {
		await fn();
	} catch (err) {
		return err as { hint: string };
	}
	throw new Error("expected a budget denial, but the call resolved");
}

describe("budget denial hints follow the wallet that was gated", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `budget-hint-${randomUUID()}`);
		mkdirSync(join(vaultBase, ".usertrust"), { recursive: true });
		// No policies file: the platform DEFAULT_RULES always apply, and
		// `block-budget-overshoot` is the one that fires on a starved session.
		writeFileSync(
			join(vaultBase, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 1 }),
		);
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("trust() LLM path: an unattributed overshoot names the session lever", async () => {
		const governed = await trust(makeAnthropicMock(), { dryRun: true, vaultBase });

		const err = await budgetDenialFrom(() => governed.messages.create(FRONTIER_CALL));

		expect(err.hint).toBe(SESSION_HINT);
		expect(err.hint).not.toContain("allocateBudget");

		await governed.destroy();
	});

	it("governAction path: an unattributed overshoot names the session lever", async () => {
		const governed = await trust(makeAnthropicMock(), { dryRun: true, vaultBase });
		const execute = vi.fn(async () => "executed");

		const err = await budgetDenialFrom(() =>
			governed.governAction(
				{ kind: "tool_use", name: "expensive_tool", cost: 5_000, params: {} },
				execute,
			),
		);

		expect(err.hint).toBe(SESSION_HINT);
		expect(err.hint).not.toContain("allocateBudget");
		expect(execute).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("headless authorize: an unattributed overshoot names the session lever", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase });

		const err = await budgetDenialFrom(() =>
			gov.authorize({
				model: "claude-opus-4-6",
				estimatedInputTokens: 5_000,
				maxOutputTokens: 5_000,
			}),
		);

		expect(err.hint).toBe(SESSION_HINT);
		expect(err.hint).not.toContain("allocateBudget");

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// Class-aware denial hints (D6)
// ---------------------------------------------------------------------------

describe("class-aware denial hints (D6)", () => {
	it("an ATTRIBUTED budget-tier denial derives the envelope remedy hint", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.1,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
		expect(derivePolicyHint(result, true)).toContain("allocateBudget");
	});

	// An unattributed call has no envelope: its hold debits the SESSION holding
	// wallet, which `allocateBudget` cannot fund. Prescribing envelope funding
	// there sends the operator to a lever that provably cannot move this denial.
	it("an UNATTRIBUTED budget denial prescribes the session lever, not allocateBudget", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.1,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
		expect(derivePolicyHint(result, false)).toBe(
			"A budget rule denied this call: increase the budget in trust() options or reduce the call's max_tokens, and review your budget_remaining / budget_remaining_after tiers.",
		);
		expect(derivePolicyHint(result, false)).not.toContain("allocateBudget");
	});

	it("a non-budget denial derives no override on either branch", () => {
		const rule: GateRule = {
			id: "no-frontier",
			name: "no-frontier",
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "model", operator: "eq", value: "claude-opus-4-6" }],
		};
		const result = evaluatePolicy([rule], { model: "claude-opus-4-6" });

		expect(result.decision).toBe("deny");
		expect(derivePolicyHint(result, true)).toBeUndefined();
		expect(derivePolicyHint(result, false)).toBeUndefined();
	});

	it("RuleMatch carries the violated rule's condition fields", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.1,
			model: "claude-opus-4-6",
		});

		expect(result.hardViolations[0]?.fields).toContain("budgetFractionRemaining");
	});

	it("a rule without a description renders its identifier once, not twice", () => {
		const rule = {
			id: "scarcity-brake",
			name: "scarcity-brake",
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 }],
		} as const;
		const result = evaluatePolicy([rule], { budgetFractionRemaining: 0.1 });
		expect(result.reasons[0]).toBe("[scarcity-brake]"); // was "[scarcity-brake] scarcity-brake"
	});

	it("a rule with a description keeps the full label + rationale", () => {
		// DEFAULT_RULES all carry descriptions — pin one stays unchanged.
		const result = evaluatePolicy(DEFAULT_RULES, { budget_remaining_after: -1 });
		expect(result.reasons[0]).toMatch(/^\[block-budget-overshoot\] Deny pre-spend/);
	});
});
