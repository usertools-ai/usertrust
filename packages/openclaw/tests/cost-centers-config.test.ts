// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * cost-centers-config.test.ts — `UsertrustPluginConfig.costCenters` validation,
 * normalization, and the module-singleton governor's config-mismatch guard.
 *
 * `normalizeCostCenters` is the construction-time door: it must reuse core's
 * OWN validation doors (`parentUserIdRefusal`, `withCostCenter`'s charset +
 * metadata checks) rather than re-implementing them, so every test that pins
 * a rejection message asserts CORE's wording, not a local paraphrase.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentUserIdRefusal } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tigerbeetle-node so no test touches a real ledger.
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

import {
	createGovernedStreamFn,
	createUsertrustPlugin,
	normalizeCostCenters,
} from "../src/index.js";
import type { CostCentersConfig, StreamFn } from "../src/types.js";
import {
	doneEvent,
	makeContext,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
} from "./host-fixtures.js";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openclaw-cc-config-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The hook context openclaw hands `wrapStreamFn`, with the inner fn on it. */
function wrapCtx(streamFn: StreamFn) {
	return { provider: "anthropic", modelId: "claude-sonnet-4-6", streamFn };
}

const MODEL = makeModel();

function validConfig(overrides: Partial<CostCentersConfig> = {}): CostCentersConfig {
	return {
		parentUserId: "agent-1",
		tools: { web_search: "research" },
		default: "research",
		envelopes: {
			research: { allocated: 500, periodStartMs: 0 },
			verification: { allocated: 200, periodStartMs: 0, periodEndMs: 1_000 },
		},
		...overrides,
	};
}

async function drain(wrapped: StreamFn | undefined) {
	if (wrapped == null) throw new Error("wrapStreamFn returned undefined");
	for await (const _e of await wrapped(MODEL, makeContext())) {
		// drain
	}
}

describe("normalizeCostCenters — construction-time validation", () => {
	it("rejects a missing parentUserId, naming the field", () => {
		const bad = { tools: {}, envelopes: {} } as unknown;
		expect(() => normalizeCostCenters(bad)).toThrow(/parentUserId/);
	});

	it("rejects an invalid parentUserId via core's own parentUserIdRefusal, with core's message", () => {
		const badId = "acme::billing"; // legacy separator — refused by core
		const reason = parentUserIdRefusal(badId);
		expect(reason).not.toBeNull();

		expect(() => normalizeCostCenters(validConfig({ parentUserId: badId }))).toThrowError(
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			new RegExp(reason!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	});

	it("rejects a `tools` value that is not an `envelopes` key", () => {
		expect(() =>
			normalizeCostCenters(validConfig({ tools: { web_search: "not_a_real_envelope" } })),
		).toThrow(/tools\["web_search"\].*envelopes key/);
	});

	it("rejects a `default` that is not an `envelopes` key", () => {
		expect(() => normalizeCostCenters(validConfig({ default: "ghost" }))).toThrow(
			/default.*envelopes key/,
		);
	});

	it("Object.hasOwn semantics — a prototype-inherited envelope key is REJECTED, not silently accepted", () => {
		// `"toString" in envelopes` is true (inherited from Object.prototype) even
		// though `envelopes` never declares it as an OWN key. `tools`/`default`
		// membership must use `Object.hasOwn`, not the `in` operator, or a caller
		// could route spend to a phantom "envelope" that was never configured.
		const cfg = validConfig({ tools: { web_search: "toString" } });
		expect(() => normalizeCostCenters(cfg)).toThrow(/envelopes key/);
	});

	it("Object.hasOwn semantics — envelopes whose keys live only on the prototype chain are treated as empty", () => {
		const proto = { research: { allocated: 500, periodStartMs: 0 } };
		const prototypeBackedEnvelopes = Object.create(proto);
		// `"research" in prototypeBackedEnvelopes` is true; `Object.hasOwn` is false.
		expect(Object.hasOwn(prototypeBackedEnvelopes, "research")).toBe(false);

		expect(() =>
			normalizeCostCenters({
				parentUserId: "agent-1",
				tools: {},
				default: "research",
				envelopes: prototypeBackedEnvelopes,
			}),
		).toThrow(/default.*envelopes key/);
	});

	it("validates every envelopes KEY's charset via core's withCostCenter door, with core's message", () => {
		const cfg = validConfig({
			envelopes: { "bad key!": { allocated: 500, periodStartMs: 0 } },
			tools: {},
			default: undefined,
		});
		expect(() => normalizeCostCenters(cfg)).toThrow(/costCenter must match/);
	});

	it("validates every envelope's metadata via core's withCostCenter door (non-finite allocated), with core's message", () => {
		const cfg = validConfig({
			envelopes: { research: { allocated: Number.NaN, periodStartMs: 0 } },
			tools: {},
			default: undefined,
		});
		expect(() => normalizeCostCenters(cfg)).toThrow(/opts\.allocated must be a finite number/);
	});

	it("validates every envelope's metadata via core's withCostCenter door (non-finite periodStartMs), with core's message", () => {
		const cfg = validConfig({
			envelopes: { research: { allocated: 500, periodStartMs: Number.NaN } },
			tools: {},
			default: undefined,
		});
		expect(() => normalizeCostCenters(cfg)).toThrow(/opts\.periodStartMs must be a finite number/);
	});

	it("rejects more than 128 envelopes", () => {
		const envelopes: CostCentersConfig["envelopes"] = {};
		for (let i = 0; i < 129; i++) {
			envelopes[`cc${i}`] = { allocated: 1, periodStartMs: 0 };
		}
		expect(() =>
			normalizeCostCenters(validConfig({ envelopes, tools: {}, default: undefined })),
		).toThrow(/129.*128|exceeds/);
	});

	it("accepts exactly 128 envelopes", () => {
		const envelopes: CostCentersConfig["envelopes"] = {};
		for (let i = 0; i < 128; i++) {
			envelopes[`cc${i}`] = { allocated: 1, periodStartMs: 0 };
		}
		const frozen = normalizeCostCenters(validConfig({ envelopes, tools: {}, default: undefined }));
		expect(Object.keys(frozen.envelopes)).toHaveLength(128);
	});

	it("rejects malformed non-object shapes", () => {
		expect(() => normalizeCostCenters(null)).toThrow();
		expect(() => normalizeCostCenters("nope")).toThrow();
		expect(() => normalizeCostCenters(42)).toThrow();
		expect(() => normalizeCostCenters([])).toThrow();
	});

	it("rejects a non-object envelope entry", () => {
		expect(() =>
			normalizeCostCenters(
				validConfig({
					envelopes: { research: "not an object" } as unknown as CostCentersConfig["envelopes"],
					tools: {},
					default: undefined,
				}),
			),
		).toThrow();
	});

	it("defaults scarcityContext to true when absent, and normalizes an explicit value", () => {
		const withoutIt = normalizeCostCenters(validConfig({ scarcityContext: undefined }));
		expect(withoutIt.scarcityContext).toBe(true);

		const withFalse = normalizeCostCenters(validConfig({ scarcityContext: false }));
		expect(withFalse.scarcityContext).toBe(false);
	});

	it("returns a deep-frozen copy; later mutation of the caller's raw object does not change routing", () => {
		const raw = validConfig();
		const frozen = normalizeCostCenters(raw);

		// Mutate the CALLER's object after normalization.
		raw.tools.web_search = "verification";
		// biome-ignore lint/style/noNonNullAssertion: `validConfig()` always sets this key
		raw.envelopes.research!.allocated = 999_999;
		(raw as { default?: string }).default = "verification";

		expect(frozen.tools.web_search).toBe("research");
		expect(frozen.envelopes.research?.allocated).toBe(500);
		expect(frozen.default).toBe("research");

		expect(Object.isFrozen(frozen)).toBe(true);
		expect(Object.isFrozen(frozen.tools)).toBe(true);
		expect(Object.isFrozen(frozen.envelopes)).toBe(true);
		expect(Object.isFrozen(frozen.envelopes.research)).toBe(true);
		expect(Object.isFrozen(frozen.envelopes.verification)).toBe(true);
	});
});

describe("construction-time call site — createUsertrustPlugin/register, not lazy init", () => {
	it("createUsertrustPlugin throws SYNCHRONOUSLY on an invalid costCenters config", () => {
		expect(() =>
			createUsertrustPlugin({
				budget: 100_000,
				dryRun: true,
				costCenters: validConfig({ parentUserId: "" }),
			}),
		).toThrow();
	});

	it("a valid costCenters config forwards parentUserId into createGovernor", async () => {
		const vaultBase = makeTmpVault();
		try {
			const { governor } = await createGovernedStreamFn(
				streamOf([startEvent(), doneEvent(makeUsage(1, 1))]),
				{
					budget: 100_000,
					dryRun: true,
					vaultBase,
					costCenters: validConfig({ parentUserId: "agent-parent-forwarded" }),
				},
			);
			// `budgetContext([])` is NOT discriminating: with `dryRun: true` and an
			// EMPTY envelopes array, core's `Governor.budgetContext`
			// (packages/core/src/headless.ts) returns `[]` on every path — the
			// `parentUserId === undefined` early exit fires identically to the
			// isDryRun short-circuit reached after a no-op validation loop over
			// zero envelopes. A forwarding regression would still pass that
			// assertion. A non-empty array with a descriptor whose `costCenter`
			// fails core's charset only reaches (and throws from) core's
			// `assertDistinctValidCostCenters` door if `parentUserId` was actually
			// forwarded into `createGovernor` — with no `parentUserId`, the early
			// exit in headless.ts skips that validation entirely and returns `[]`
			// regardless of the descriptor's shape. This is the cheapest
			// observable proof the id actually reached `createGovernor`.
			await expect(
				governor.budgetContext([
					{ costCenter: "bad cost center!", allocated: 1, periodStartMs: 0 },
				]),
			).rejects.toThrow(/costCenter must match/);
		} finally {
			// `shutdown()`, not `governor.destroy()` — this test's config differs
			// from every other describe block's, so leaving the module-singleton
			// `governor`/`governorFingerprint` set would poison the NEXT test's
			// fingerprint check with a stale claim (destroy() alone only tears
			// down the ledger client; it does not clear index.ts's own state).
			const { shutdown } = await import("../src/index.js");
			await shutdown();
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});
});

describe("governor config-mismatch guard (index.ts module-singleton governor/initPromise)", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		const mod = await import("../src/index.js");
		await mod.shutdown();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("a second plugin instance with a DIFFERENT config rejects loudly instead of silently reusing the first governor", async () => {
		const pluginA = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });
		await drain(
			pluginA.wrapStreamFn?.(wrapCtx(streamOf([startEvent(), doneEvent(makeUsage(1, 1))]))),
		);

		const pluginB = createUsertrustPlugin({ budget: 200_000, dryRun: true, vaultBase });
		await expect(drain(pluginB.wrapStreamFn?.(wrapCtx(streamOf([startEvent()]))))).rejects.toThrow(
			/config/i,
		);
	});

	it("a second plugin instance with the SAME config reuses the singleton governor", async () => {
		const pluginA = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });
		await drain(
			pluginA.wrapStreamFn?.(wrapCtx(streamOf([startEvent(), doneEvent(makeUsage(1, 1))]))),
		);

		const { getGovernor } = await import("../src/index.js");
		const gov1 = getGovernor();

		const pluginB = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });
		await drain(
			pluginB.wrapStreamFn?.(wrapCtx(streamOf([startEvent(), doneEvent(makeUsage(1, 1))]))),
		);

		expect(getGovernor()).toBe(gov1);
	});

	it("claims the fingerprint SYNCHRONOUSLY — two different configs racing in the same tick never both build a governor", async () => {
		const p1 = createGovernedStreamFn(streamOf([startEvent(), doneEvent(makeUsage(1, 1))]), {
			budget: 100_000,
			dryRun: true,
			vaultBase,
		});
		const p2 = createGovernedStreamFn(streamOf([startEvent(), doneEvent(makeUsage(1, 1))]), {
			budget: 200_000,
			dryRun: true,
			vaultBase,
		});

		const results = await Promise.allSettled([p1, p2]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		const rejection = results.find((r) => r.status === "rejected");
		if (rejection?.status === "rejected") {
			expect(String(rejection.reason)).toMatch(/config/i);
		}
	});

	it("clears the claim on shutdown() so a legitimate post-shutdown re-config is accepted", async () => {
		const { governor: gov1 } = await createGovernedStreamFn(streamOf([startEvent()]), {
			budget: 100_000,
			dryRun: true,
			vaultBase,
		});

		const { shutdown } = await import("../src/index.js");
		await shutdown();

		const { governor: gov2 } = await createGovernedStreamFn(streamOf([startEvent()]), {
			budget: 200_000,
			dryRun: true,
			vaultBase,
		});

		expect(gov2).not.toBe(gov1);
		await gov2.destroy();
	});

	it("clears the claim on a FAILED init so a retry (even with a different config) is accepted", async () => {
		// budget must be a positive integer (core's TrustConfigSchema) — this
		// rejects before any ledger I/O, purely from config validation.
		await expect(
			createGovernedStreamFn(streamOf([startEvent()]), {
				budget: -1,
				dryRun: true,
				vaultBase,
			}),
		).rejects.toThrow();

		const { getGovernor } = await import("../src/index.js");
		expect(getGovernor()).toBeNull();

		const { governor } = await createGovernedStreamFn(streamOf([startEvent()]), {
			budget: 200_000,
			dryRun: true,
			vaultBase,
		});
		expect(governor).toBeDefined();
		await governor.destroy();
	});
});

// ── Manifest ⟷ normalizeCostCenters parity (Step 3) ──

/**
 * A minimal JSON Schema interpreter — NOT a general one, only the exact
 * keyword subset `openclaw.plugin.json`'s `costCenters` node uses (`type`,
 * `properties`, `required`, `additionalProperties`, `pattern`, `minimum`,
 * `maxProperties`, `propertyNames`). Standing in for the "ajv dev-dep" option
 * the brief offers: this repo has no ajv anywhere (`grep -r ajv` in
 * `node_modules` and every `package.json` comes up empty), and adding one
 * purely for a single parity test is a heavier footprint than a ~40-line
 * mirror of the four keywords actually in play — the same
 * duplicate-a-small-authoritative-rule tradeoff `shared/ids.ts` documents for
 * `cli/budget.ts`'s `COST_CENTER_PATTERN` copy.
 *
 * Reads the schema node LIVE off the manifest file below — never a
 * hand-copied regex — so an edit to the manifest that this interpreter
 * doesn't understand fails LOUD (the `throw` in the default case), not
 * silently green.
 */
interface JsonSchemaNode {
	type?: string;
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	additionalProperties?: boolean | JsonSchemaNode;
	pattern?: string;
	minimum?: number;
	maxProperties?: number;
	propertyNames?: { pattern?: string };
}

function matchesJsonSchema(schema: JsonSchemaNode, value: unknown): boolean {
	switch (schema.type) {
		case "object": {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
			const obj = value as Record<string, unknown>;
			const keys = Object.keys(obj);
			if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false;
			if (schema.propertyNames?.pattern !== undefined) {
				const re = new RegExp(schema.propertyNames.pattern);
				if (!keys.every((k) => re.test(k))) return false;
			}
			if (schema.required !== undefined && !schema.required.every((r) => Object.hasOwn(obj, r))) {
				return false;
			}
			const declared = schema.properties ?? {};
			for (const key of keys) {
				if (Object.hasOwn(declared, key)) {
					// biome-ignore lint/style/noNonNullAssertion: guarded by hasOwn above
					if (!matchesJsonSchema(declared[key]!, obj[key])) return false;
				} else if (schema.additionalProperties === false) {
					return false;
				} else if (typeof schema.additionalProperties === "object") {
					if (!matchesJsonSchema(schema.additionalProperties, obj[key])) return false;
				}
				// additionalProperties === true / undefined → unrecognized key passes unchecked
			}
			return true;
		}
		case "string":
			return (
				typeof value === "string" &&
				(schema.pattern === undefined || new RegExp(schema.pattern).test(value))
			);
		case "number":
			// NOTE: no Number.isFinite check — a config that reaches this
			// interpreter came from JSON (openclaw.json), which cannot encode
			// NaN/Infinity in the first place. Non-finite `allocated`/`periodStartMs`
			// is a TS-API-only concern, covered separately above — deliberately
			// excluded from this table (see its header comment).
			return typeof value === "number" && (schema.minimum === undefined || value >= schema.minimum);
		case "boolean":
			return typeof value === "boolean";
		default:
			throw new Error(`matchesJsonSchema: unsupported schema node ${JSON.stringify(schema)}`);
	}
}

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
	configSchema: { properties: { costCenters: JsonSchemaNode } };
};
const costCentersSchema = manifest.configSchema.properties.costCenters;

/**
 * The shared valid/invalid table both validators run against. Every entry is
 * JSON-representable (no `NaN`/`Infinity`/`undefined` literals) — a real
 * openclaw.json on disk cannot encode those, so a divergence there would not
 * be a genuine parity bug; `normalizeCostCenters`'s own tests above cover that
 * ground with core's message pinned.
 *
 * DELIBERATELY EXCLUDED: `tools`/`default` values that fail to name an
 * `envelopes` key. Plain JSON Schema (no custom `$data` keyword, not used
 * here) cannot express "this string must equal one of that OTHER property's
 * keys" — that is a genuine, unavoidable expressiveness gap between a static
 * manifest schema and `normalizeCostCenters`'s runtime business rule, not a
 * bug either side should be made to hide. `normalizeCostCenters`'s own tests
 * above cover that rule directly.
 */
const parityTable: { name: string; config: unknown; valid: boolean }[] = [
	{
		name: "valid — minimal (empty tools/envelopes, no default, no scarcityContext)",
		config: { parentUserId: "agent-1", tools: {}, envelopes: {} },
		valid: true,
	},
	{
		name: "valid — full shape",
		config: {
			parentUserId: "agent-1",
			tools: { web_search: "research" },
			default: "research",
			envelopes: {
				research: { allocated: 500, periodStartMs: 0 },
				verification: { allocated: 200, periodStartMs: 0, periodEndMs: 1_000 },
			},
			scarcityContext: false,
		},
		valid: true,
	},
	{
		name: "invalid — missing parentUserId",
		config: { tools: {}, envelopes: {} },
		valid: false,
	},
	{
		name: "invalid — missing tools",
		config: { parentUserId: "agent-1", envelopes: {} },
		valid: false,
	},
	{
		name: "invalid — missing envelopes",
		config: { parentUserId: "agent-1", tools: {} },
		valid: false,
	},
	{
		name: "invalid — unknown top-level field",
		config: { parentUserId: "agent-1", tools: {}, envelopes: {}, extra: "nope" },
		valid: false,
	},
	{
		name: "invalid — unknown field inside an envelope entry",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: { research: { allocated: 100, periodStartMs: 0, bogus: true } },
		},
		valid: false,
	},
	{
		name: "invalid — parentUserId contains the legacy '::' separator",
		config: { parentUserId: "acme::billing", tools: {}, envelopes: {} },
		valid: false,
	},
	{
		name: "invalid — parentUserId fails the charset (space)",
		config: { parentUserId: "has space", tools: {}, envelopes: {} },
		valid: false,
	},
	{
		name: "invalid — envelope key fails the charset",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: { "bad key!": { allocated: 100, periodStartMs: 0 } },
		},
		valid: false,
	},
	{
		name: "invalid — allocated is negative",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: { research: { allocated: -1, periodStartMs: 0 } },
		},
		valid: false,
	},
	{
		name: "invalid — allocated is a string, not a number",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: { research: { allocated: "100", periodStartMs: 0 } },
		},
		valid: false,
	},
	{
		name: "invalid — envelope entry missing periodStartMs",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: { research: { allocated: 100 } },
		},
		valid: false,
	},
	{
		name: "invalid — tools value is a number, not a string",
		config: {
			parentUserId: "agent-1",
			tools: { web_search: 123 },
			envelopes: { research: { allocated: 100, periodStartMs: 0 } },
		},
		valid: false,
	},
	{
		name: "invalid — scarcityContext is a string, not a boolean",
		config: { parentUserId: "agent-1", tools: {}, envelopes: {}, scarcityContext: "yes" },
		valid: false,
	},
	{
		name: "invalid — 129 envelopes exceeds the 128 cap",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: Object.fromEntries(
				Array.from({ length: 129 }, (_, i) => [`cc${i}`, { allocated: 1, periodStartMs: 0 }]),
			),
		},
		valid: false,
	},
	{
		name: "valid — exactly 128 envelopes",
		config: {
			parentUserId: "agent-1",
			tools: {},
			envelopes: Object.fromEntries(
				Array.from({ length: 128 }, (_, i) => [`cc${i}`, { allocated: 1, periodStartMs: 0 }]),
			),
		},
		valid: true,
	},
];

describe("manifest schema ⟷ normalizeCostCenters parity", () => {
	it.each(parityTable)("$name", ({ config, valid }) => {
		const schemaVerdict = matchesJsonSchema(costCentersSchema, config);
		let normalizeVerdict = true;
		try {
			normalizeCostCenters(config);
		} catch {
			normalizeVerdict = false;
		}
		expect(schemaVerdict).toBe(valid);
		expect(normalizeVerdict).toBe(valid);
		expect(schemaVerdict).toBe(normalizeVerdict);
	});
});
