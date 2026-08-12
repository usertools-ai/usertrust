// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P1-PARAM-SHADOW, extended to the gate's CLOCK — a request body must never be
 * able to choose which time a policy rule is evaluated at.
 *
 * `PolicyContext.timestamp` is a governance input like any other: `ruleMatches`
 * reads `context.timestamp ?? new Date().toISOString()` and feeds it to
 * `isWithinTimeWindow`, so whoever writes that field decides whether a
 * `timeWindows` rule fires. Every `evaluatePolicy` call site spreads the
 * caller's params FIRST precisely so trusted fields can be re-asserted after it
 * (AGENTS.md, "Trusted policy-context fields are re-asserted AFTER the
 * request-body spread"), and `timestamp` must be re-asserted `undefined` there
 * for the same reason the budget-tier fields are: absent is the honest value,
 * and absent means the gate falls back to the REAL clock.
 *
 * The two directions are both tested at all three sites, because they fail
 * differently:
 *
 *  - **Escaping a live window** (the security case): a hard deny scoped to a
 *    window the real clock is INSIDE must still fire when the body claims a
 *    time outside it.
 *  - **Inflicting a dormant window**: a hard deny scoped to a window the real
 *    clock is OUTSIDE must NOT fire just because the body claims a time inside
 *    it. This is the direction that proves the real clock actually wins rather
 *    than the caller's field merely being ignored in one direction.
 *
 * TIME WINDOWS ARE LOCAL TIME BY CONTRACT — `isWithinTimeWindow` uses
 * `getDay()`/`getHours()`, not their UTC counterparts. These fixtures therefore
 * derive their windows from the LOCAL day of a real `Date`, never from a
 * hard-coded UTC weekday, and read the forged timestamp's local day back off
 * the `Date` object instead of assuming `(today + 3) % 7` (a DST transition can
 * move a near-midnight instant onto a different local day).
 *
 * SECURITY (mirrors cost-center-spoof.test.ts): never log or snapshot a whole
 * PolicyContext — it carries request-shaped data. Assert on individual fields.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { evaluatePolicy, type PolicyContext } from "../../src/policy/gate.js";

// tigerbeetle-node is a native module and is never loaded in unit tests.
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// The evaluator itself stays REAL — this only records the context each call
// site hands it, so the assertions are about what the gate actually saw.
vi.mock("../../src/policy/gate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/policy/gate.js")>();
	return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

const VAULT_DIR = ".usertrust";
const POLICY_REL = "policies/default.yml";

// ── Time fixtures (LOCAL time, per the contract above) ──

const NOW = new Date();
/** The local weekday the real clock is on right now. */
const TODAY = NOW.getDay();
/**
 * Included in the "live" window alongside TODAY so a run that crosses local
 * midnight mid-test still has the real clock inside the window it is supposed
 * to be inside.
 */
const TOMORROW = (TODAY + 1) % 7;
/** What a forged body claims instead: three days out, so never TODAY/TOMORROW. */
const FORGED_DATE = new Date(NOW.getTime() + 3 * 86_400_000);
const FORGED_TS = FORGED_DATE.toISOString();
/** Read back off the Date rather than computed, so DST cannot desynchronise it. */
const FORGED_DAY = FORGED_DATE.getDay();

/** A hard deny that fires whenever it matches, restricted to `days`. */
function denyDuring(days: number[]): Record<string, unknown> {
	return {
		id: "window-deny",
		name: "window-deny",
		effect: "deny",
		enforcement: "hard",
		// `tier` is re-asserted at every call site, so this condition is true on
		// every governed call and the time window is the only thing gating the rule.
		conditions: [{ field: "tier", operator: "exists" }],
		timeWindows: [{ daysOfWeek: days }],
	};
}

/** Window the real clock is INSIDE — the body tries to escape it. */
const LIVE_WINDOW = [TODAY, TOMORROW];
/** Window the real clock is OUTSIDE — the body tries to walk into it. */
const DORMANT_WINDOW = [FORGED_DAY];

function makeTmpVault(rules: unknown[]): string {
	const base = join(tmpdir(), `harden-clock-${randomUUID()}`);
	const dir = join(base, VAULT_DIR);
	mkdirSync(join(dir, "policies"), { recursive: true });
	writeFileSync(
		join(dir, "usertrust.config.json"),
		JSON.stringify({ budget: 1_000_000, tier: "pro", policies: `./${POLICY_REL}` }),
	);
	writeFileSync(join(dir, POLICY_REL), JSON.stringify({ rules }));
	return base;
}

/** The context the (real) evaluator saw for the most recent gate call. */
function lastPolicyContext(): PolicyContext {
	const calls = vi.mocked(evaluatePolicy).mock.calls;
	const last = calls[calls.length - 1];
	if (last === undefined) throw new Error("the policy evaluator was never called");
	return last[1];
}

const PARAMS = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hi" }],
};

const vaults: string[] = [];
function vault(rules: unknown[]): string {
	const base = makeTmpVault(rules);
	vaults.push(base);
	return base;
}

beforeEach(() => {
	vi.mocked(evaluatePolicy).mockClear();
});

afterEach(() => {
	for (const base of vaults.splice(0)) {
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

// A VACUITY GUARD, not a hole detector — it is the one case in this file that
// passes with or without the fix, deliberately. If the forged day ever collided
// with the live window, the forged timestamp and the real clock would agree and
// every "escape"/"inflict" assertion below would pass for the wrong reason.
it("vacuity guard (passes pre- and post-fix): the forged local day is outside the live window", () => {
	expect(LIVE_WINDOW).not.toContain(FORGED_DAY);
});

// ---------------------------------------------------------------------------
// Site 1 — govern.ts's LLM path (interceptCall)
// ---------------------------------------------------------------------------

describe("LLM path (trust()) — request-body clock forgery", () => {
	it("a caller-supplied timestamp cannot escape a deny window the REAL clock is inside", async () => {
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: vault([denyDuring(LIVE_WINDOW)]) },
		);

		await expect(
			governed.messages.create({ ...PARAMS, timestamp: FORGED_TS } as Record<string, unknown>),
			// The rule ID, not just "Policy denied" — this must be THE window rule
			// firing, not some unrelated default deny standing in for it.
		).rejects.toThrow(/\[window-deny\]/);
		expect(createSpy).not.toHaveBeenCalled();
		// The gate never saw the caller's clock; it fell back to the real one.
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await governed.destroy();
	});

	it("a caller-supplied timestamp cannot inflict a deny window the REAL clock is outside", async () => {
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: vault([denyDuring(DORMANT_WINDOW)]) },
		);

		await expect(
			governed.messages.create({ ...PARAMS, timestamp: FORGED_TS } as Record<string, unknown>),
		).resolves.toBeDefined();
		// The call really was forwarded — an "allow" that quietly swallowed the
		// request would satisfy a rejects-free assertion just as well.
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Site 2 — govern.ts's governAction
// ---------------------------------------------------------------------------

describe("governAction — action.params clock forgery", () => {
	const ACTION = { kind: "tool_use" as const, name: "search", cost: 25 };

	it("action.params cannot escape a deny window the REAL clock is inside", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault([denyDuring(LIVE_WINDOW)]) },
		);
		const run = vi.fn(async () => "ok");

		await expect(
			governed.governAction({ ...ACTION, params: { timestamp: FORGED_TS } }, run),
		).rejects.toThrow(/\[window-deny\]/);
		expect(run).not.toHaveBeenCalled();
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await governed.destroy();
	});

	it("action.params cannot inflict a deny window the REAL clock is outside", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault([denyDuring(DORMANT_WINDOW)]) },
		);
		const run = vi.fn(async () => "ok");

		await expect(
			governed.governAction({ ...ACTION, params: { timestamp: FORGED_TS } }, run),
		).resolves.toBeDefined();
		expect(run).toHaveBeenCalled();
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Site 3 — headless.ts's authorize (the third re-assertion site, AGENTS.md)
// ---------------------------------------------------------------------------

describe("headless authorize — params.params clock forgery", () => {
	const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };

	it("params.params cannot escape a deny window the REAL clock is inside", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: vault([denyDuring(LIVE_WINDOW)]) });

		await expect(gov.authorize({ ...AUTHORIZE, params: { timestamp: FORGED_TS } })).rejects.toThrow(
			/\[window-deny\]/,
		);
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await gov.destroy();
	});

	it("params.params cannot inflict a deny window the REAL clock is outside", async () => {
		const gov = await createGovernor({
			dryRun: true,
			vaultBase: vault([denyDuring(DORMANT_WINDOW)]),
		});

		const auth = await gov.authorize({ ...AUTHORIZE, params: { timestamp: FORGED_TS } });
		expect(auth.transferId).toEqual(expect.any(String));
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// The HOUR half of the window predicate, on a DETERMINISTIC clock
//
// The three site pairs above move the `daysOfWeek` half of `isWithinTimeWindow`
// and take the real clock as they find it. This pair pins the OTHER half —
// `startHour`/`endHour`, the shape a real after-hours freeze is written in —
// and fakes only `Date` (`toFake: ["Date"]`, so the governor's real timers and
// async plumbing are untouched) to put the machine clock on a chosen side of
// the window. Both instants are built from LOCAL components, so the fixture
// means the same thing in every timezone.
//
// It runs on `headless.authorize` because that is the highest-blast-radius
// site: `packages/server` hands `governor.authorize(parsed.data)` a request
// body straight off the wire, so the "caller" there is a REMOTE tenant.
// ---------------------------------------------------------------------------

describe("headless authorize — hour-window freeze on a faked machine clock", () => {
	const FREEZE = {
		id: "after-hours-freeze",
		name: "after-hours-freeze",
		effect: "deny",
		enforcement: "hard",
		severity: "high",
		conditions: [{ field: "estimated_cost", operator: "exists" }],
		timeWindows: [{ startHour: 9, endHour: 12 }],
	};
	const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };
	const INSIDE = new Date(2026, 7, 12, 10, 30, 0); // local 10:30 → inside 9–12
	const OUTSIDE = new Date(2026, 7, 12, 3, 30, 0); // local 03:30 → outside 9–12

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a body claiming 03:30 cannot dodge the freeze while the machine clock says 10:30", async () => {
		vi.setSystemTime(INSIDE);
		const gov = await createGovernor({ dryRun: true, vaultBase: vault([FREEZE]) });

		await expect(
			gov.authorize({ ...AUTHORIZE, params: { timestamp: OUTSIDE.toISOString() } }),
		).rejects.toThrow(/\[after-hours-freeze\]/);
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await gov.destroy();
	});

	it("a body claiming 10:30 cannot manufacture the freeze while the machine clock says 03:30", async () => {
		vi.setSystemTime(OUTSIDE);
		const gov = await createGovernor({ dryRun: true, vaultBase: vault([FREEZE]) });

		const auth = await gov.authorize({
			...AUTHORIZE,
			params: { timestamp: INSIDE.toISOString() },
		});
		expect(auth.transferId).toEqual(expect.any(String));
		expect(lastPolicyContext().timestamp).toBeUndefined();

		await gov.destroy();
	});
});
