// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * WHAT KIND of work a job was: `jobType` and `typeSource`, captured ONCE at authorize beside
 * `job`, validated against a closed list before any I/O, spread onto every record that carries
 * `job`, and never settable by a later settle. A type is a declaration, not evidence, and a
 * label, never a payer.
 *
 * Each group names the mutant it kills.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { listReceipts } from "../../src/audit/rotation.js";
import type { TrustEngine } from "../../src/govern.js";
import * as headless from "../../src/headless.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import * as root from "../../src/index.js";
import { AUDIT_DIR, VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";
import {
	captureJob,
	JOB_TYPES,
	jobTypeRefusal,
	TYPE_SOURCES,
	typeSourceRefusal,
} from "../../src/shared/job.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Fixtures ──

const MODEL = "claude-sonnet-4-6";
const AUTHORIZE = { model: MODEL, estimatedInputTokens: 100, maxOutputTokens: 50 };

interface EngineHandle extends TrustEngine {
	spendPending: Mock<TrustEngine["spendPending"]>;
	postPendingSpend: Mock<TrustEngine["postPendingSpend"]>;
	voidPendingSpend: Mock<TrustEngine["voidPendingSpend"]>;
}

function makeEngine(
	over: { spend?: Error; post?: Error | { posted: number; shortfall: number } } = {},
): EngineHandle {
	return {
		spendPending: vi.fn<TrustEngine["spendPending"]>(async (p) => {
			if (over.spend !== undefined) throw over.spend;
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn<TrustEngine["postPendingSpend"]>(async () => {
			if (over.post instanceof Error) throw over.post;
			return over.post;
		}),
		voidPendingSpend: vi.fn<TrustEngine["voidPendingSpend"]>(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

type AuditHandle = AuditWriter & { events: AppendEventInput[] };

function makeAudit(): AuditHandle {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

function record(audit: AuditHandle, kind: string): AppendEventInput {
	const found = audit.events.find((e) => e.kind === kind);
	if (found === undefined) {
		throw new Error(`no ${kind} record (saw: ${audit.events.map((e) => e.kind).join(", ")})`);
	}
	return found;
}

const JOB = "job-a";
const TYPED = { job: JOB, jobType: "bugfix", typeSource: "agent" } as const;
const TYPE_KEYS = ["jobType", "typeSource"] as const;

describe("the closed lists", () => {
	// Kills: a type slipped into the list without a deliberate change here (and a CHANGELOG
	// line), and an `"inferred"` source, which the design rules out.
	it("JOB_TYPES and TYPE_SOURCES are exactly the agreed closed lists", () => {
		expect([...JOB_TYPES]).toEqual([
			"feature",
			"bugfix",
			"review",
			"test",
			"docs",
			"ops",
			"research",
			"other",
		]);
		expect([...TYPE_SOURCES]).toEqual(["explicit", "agent"]);
	});

	it("every listed value is accepted and nothing else is", () => {
		for (const t of JOB_TYPES) expect(jobTypeRefusal(t), t).toBeUndefined();
		for (const s of TYPE_SOURCES) expect(typeSourceRefusal(s), s).toBeUndefined();
		expect(jobTypeRefusal(undefined)).toBeUndefined();
		expect(typeSourceRefusal(undefined)).toBeUndefined();
		for (const bad of ["Feature", "feature ", "", "chore", "inferred", 7, null, {}, ["feature"]]) {
			expect(jobTypeRefusal(bad), String(bad)).toMatch(/jobType must be one of feature, bugfix/);
		}
		for (const bad of ["inferred", "Agent", "", "user", 1, null]) {
			expect(typeSourceRefusal(bad), String(bad)).toMatch(
				/typeSource must be one of explicit, agent/,
			);
		}
	});

	it("the same values reach a consumer from the headless entry and the package root", () => {
		expect(headless.JOB_TYPES).toBe(JOB_TYPES);
		expect(headless.TYPE_SOURCES).toBe(TYPE_SOURCES);
		expect(headless.jobTypeRefusal).toBe(jobTypeRefusal);
		expect(headless.typeSourceRefusal).toBe(typeSourceRefusal);
		expect(root.JOB_TYPES).toBe(JOB_TYPES);
		expect(root.TYPE_SOURCES).toBe(TYPE_SOURCES);
		expect(root.jobTypeRefusal).toBe(jobTypeRefusal);
		expect(root.typeSourceRefusal).toBe(typeSourceRefusal);
	});
});

describe("captureJob: jobType and typeSource", () => {
	it("captures both with the job, frozen", () => {
		const out = captureJob(TYPED);
		expect(out).toEqual(TYPED);
		expect(Object.isFrozen(out)).toBe(true);
	});

	it("a type alone (no source) captures NO source: `explicit` is never synthesized here", () => {
		const out = captureJob({ job: JOB, jobType: "docs" });
		expect(out).toEqual({ job: JOB, jobType: "docs" });
		expect(out).not.toHaveProperty("typeSource");
	});

	it("an untyped capture has neither key", () => {
		for (const input of [{}, { job: JOB }, { jobState: "invalid" }]) {
			const out = captureJob(input);
			for (const key of TYPE_KEYS) expect(out, key).not.toHaveProperty(key);
		}
	});

	it("reads each field ONCE (a getter cannot answer differently later)", () => {
		let typeReads = 0;
		let sourceReads = 0;
		const out = captureJob({
			job: JOB,
			get jobType() {
				typeReads++;
				return typeReads === 1 ? "feature" : "ops";
			},
			get typeSource() {
				sourceReads++;
				return sourceReads === 1 ? "agent" : "explicit";
			},
		});
		expect(out).toEqual({ job: JOB, jobType: "feature", typeSource: "agent" });
		expect(typeReads).toBe(1);
		expect(sourceReads).toBe(1);
	});

	it.each([
		["an unknown type", { job: JOB, jobType: "chore" }, /jobType must be one of/],
		["a differently-cased type", { job: JOB, jobType: "Feature" }, /jobType must be one of/],
		["an empty type", { job: JOB, jobType: "" }, /jobType must be one of/],
		["a numeric type", { job: JOB, jobType: 7 }, /jobType must be one of/],
		["a null type", { job: JOB, jobType: null }, /jobType must be one of/],
		[
			"an unknown source",
			{ job: JOB, jobType: "docs", typeSource: "inferred" },
			/typeSource must be one of/,
		],
		["a null source", { job: JOB, jobType: "docs", typeSource: null }, /typeSource must be one of/],
		["a type with no job", { jobType: "docs" }, /jobType requires a job/],
		["a source with no type", { job: JOB, typeSource: "agent" }, /typeSource requires a jobType/],
		["a source with no job and no type", { typeSource: "agent" }, /typeSource requires a jobType/],
		[
			"a type beside jobState invalid",
			{ jobState: "invalid", jobType: "docs" },
			/jobState cannot accompany a jobType/,
		],
		[
			"a type and source beside jobState invalid",
			{ jobState: "invalid", jobType: "docs", typeSource: "agent" },
			/jobState cannot accompany a jobType/,
		],
		[
			"a source beside jobState invalid",
			{ jobState: "invalid", typeSource: "agent" },
			/typeSource requires a jobType/,
		],
	])("refuses %s with a TypeError", (_name, input, message) => {
		expect(() => captureJob(input)).toThrow(TypeError);
		expect(() => captureJob(input)).toThrow(message);
	});
});

// ── The governor ──

interface Run {
	events: AppendEventInput[];
	receipts: Array<{ kind: string; data: Record<string, unknown> }>;
}

type Labels = Record<string, unknown>;

interface Scenario {
	name: string;
	/** Record kinds (chain) this scenario must produce with the call's labels. */
	kinds: string[];
	/** Whether the rotated receipt is produced. */
	receipt?: boolean;
	config?: object;
	engine?: Parameters<typeof makeEngine>[0];
	body: (gov: Governor, labels: Labels) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
	{
		name: "settle",
		kinds: ["llm_call"],
		receipt: true,
		body: async (gov, labels) => {
			const auth = await gov.authorize({ ...AUTHORIZE, ...labels });
			await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		},
	},
	{
		name: "abort",
		kinds: ["llm_call_failed"],
		body: async (gov, labels) => {
			const auth = await gov.authorize({ ...AUTHORIZE, ...labels });
			await gov.abort(auth, new Error("provider 500"));
		},
	},
	{
		name: "release",
		kinds: ["hold_released"],
		body: async (gov, labels) => {
			const auth = await gov.authorize({ ...AUTHORIZE, ...labels });
			await gov.release(auth, "no usage");
		},
	},
	{
		// destroy() takes the hold itself: a different append site from release().
		name: "destroy",
		kinds: ["hold_released"],
		body: async (gov, labels) => {
			await gov.authorize({ ...AUTHORIZE, ...labels });
		},
	},
	{
		name: "settlement_ambiguous",
		kinds: ["settlement_ambiguous", "llm_call"],
		engine: { post: new Error("socket reset") },
		body: async (gov, labels) => {
			const auth = await gov.authorize({ ...AUTHORIZE, ...labels });
			await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		},
	},
	{
		name: "settlement_shortfall",
		kinds: ["settlement_shortfall", "llm_call"],
		engine: { post: { posted: 1, shortfall: 4 } },
		body: async (gov, labels) => {
			const auth = await gov.authorize({ ...AUTHORIZE, ...labels });
			await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		},
	},
	{
		name: "usage_implausible",
		kinds: ["usage_implausible", "llm_call"],
		body: async (gov, labels) => {
			const auth = await gov.authorize({ ...AUTHORIZE, ...labels });
			await gov.settle(auth, { inputTokens: 2000, cacheReadTokens: 1e15 });
		},
	},
	{
		name: "policy_denied (PII at the mutex boundary)",
		kinds: ["policy_denied"],
		config: { budget: 100_000, pii: "block" },
		body: async (gov, labels) => {
			await expect(
				gov.authorize({
					...AUTHORIZE,
					...labels,
					messages: [{ role: "user", content: "mail me at jane.doe@example.com" }],
				}),
			).rejects.toBeInstanceOf(PolicyDeniedError);
		},
	},
	{
		name: "policy_denied (unknown model, the pre-mutex site)",
		kinds: ["policy_denied"],
		config: { budget: 100_000, unknownModelPolicy: "deny" },
		body: async (gov, labels) => {
			await expect(
				gov.authorize({ ...AUTHORIZE, model: "no-such-model-xyz", ...labels }),
			).rejects.toBeInstanceOf(PolicyDeniedError);
		},
	},
	{
		name: "ledger_rejected",
		kinds: ["ledger_rejected"],
		engine: { spend: new InsufficientBalanceError("trust:hold", 999, 0) },
		body: async (gov, labels) => {
			await expect(gov.authorize({ ...AUTHORIZE, ...labels })).rejects.toBeInstanceOf(
				InsufficientBalanceError,
			);
		},
	},
];

describe("headless records carry the authorize capture's jobType and typeSource", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-job-type-${randomUUID()}`);
		mkdirSync(join(vaultBase, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});
	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function drive(scenario: Scenario, labels: Labels): Promise<Run> {
		const audit = makeAudit();
		if (scenario.config !== undefined) {
			writeFileSync(
				join(vaultBase, VAULT_DIR, "usertrust.config.json"),
				JSON.stringify(scenario.config),
			);
		}
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: makeEngine(scenario.engine),
			_audit: audit,
		});
		await scenario.body(gov, labels);
		await gov.destroy();
		const receipts =
			scenario.receipt === true
				? listReceipts(vaultBase, "llm_call").map((r) => ({ kind: r.kind, data: r.data }))
				: [];
		// A fresh vault per run, so the next drive starts clean.
		rmSync(join(vaultBase, VAULT_DIR, AUDIT_DIR), { recursive: true, force: true });
		return { events: audit.events, receipts };
	}

	/**
	 * The serialized payload, with the one thing that differs between two runs (the minted
	 * transfer id) pinned. Key ORDER is kept: an untyped record must serialize exactly as it did.
	 */
	const serialize = (data: unknown): string =>
		JSON.stringify(data, (key, value) =>
			key === "transferId" ? "T" : key === "receiptId" ? "R" : value,
		);

	const withoutType = (data: Record<string, unknown>): Record<string, unknown> => {
		const { jobType: _t, typeSource: _s, ...rest } = data;
		return rest;
	};

	describe.each(SCENARIOS)("$name", (scenario) => {
		it("every record of the kind carries jobType and typeSource from the capture", async () => {
			const run = await drive(scenario, TYPED);
			for (const kind of scenario.kinds) {
				const found = run.events.filter((e) => e.kind === kind);
				expect(found.length, kind).toBeGreaterThan(0);
				for (const e of found) expect(e.data, kind).toMatchObject(TYPED);
			}
			if (scenario.receipt === true) {
				expect(run.receipts).toHaveLength(1);
				expect(run.receipts[0]?.data).toMatchObject(TYPED);
			}
		});

		it("a type without a source records the type and NO source key", async () => {
			const run = await drive(scenario, { job: JOB, jobType: "docs" });
			for (const kind of scenario.kinds) {
				for (const e of run.events.filter((x) => x.kind === kind)) {
					expect(e.data, kind).toMatchObject({ job: JOB, jobType: "docs" });
					expect(e.data, kind).not.toHaveProperty("typeSource");
				}
			}
		});

		it("untyped and job-only records serialize exactly as before: no type key, and typed minus the two keys is byte-identical", async () => {
			const untyped = await drive(scenario, {});
			const jobOnly = await drive(scenario, { job: JOB });
			const typed = await drive(scenario, TYPED);
			expect(typed.events.map((e) => e.kind)).toEqual(jobOnly.events.map((e) => e.kind));
			for (const run of [untyped, jobOnly]) {
				for (const e of run.events) {
					const text = serialize(e.data);
					for (const key of TYPE_KEYS) expect(text, `${e.kind} ${key}`).not.toContain(key);
				}
				for (const r of run.receipts) {
					for (const key of TYPE_KEYS) expect(serialize(r.data)).not.toContain(key);
				}
			}
			for (const [i, e] of typed.events.entries()) {
				expect(serialize(withoutType(e.data)), e.kind).toBe(serialize(jobOnly.events[i]?.data));
			}
			for (const [i, r] of typed.receipts.entries()) {
				const base = jobOnly.receipts[i]?.data;
				expect(serialize(withoutType(r.data)), "receipt").toBe(serialize(base));
			}
		});
	});

	/**
	 * THE PRE-TYPED-JOBS SHAPE, as literals. Every expectation below was captured by running
	 * these same scenarios on the code BEFORE `jobType`/`typeSource` existed, so a change that
	 * touches an unlabelled, job-only or invalid-log record (an extra key, a lost key, a moved
	 * value) fails here even when it also touches the typed path. Comparing the new code with
	 * itself, as the test above does, cannot see that.
	 *
	 * Before typed jobs a job-only call recorded exactly the unlabelled record plus `job`, and an
	 * invalid-log call exactly the unlabelled record plus `jobState`: both are applied below as
	 * the one key each adds. What is masked is only what the pricing table or the error's hint
	 * text decides, none of which this change may touch: `cost`-like amounts, the applied rates
	 * and table version, and an error's text after its first line. The `transferId` and
	 * `receiptId` are minted per run.
	 */
	const PRICED = "<priced>";
	const MODEL_ID = "claude-sonnet-4-6";
	const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const llmCall = (extra: Record<string, unknown> = {}) => ({
		kind: "llm_call",
		actor: "local",
		data: {
			model: MODEL_ID,
			cost: PRICED,
			settled: true,
			transferId: "T",
			usageSource: "provider",
			usage: USAGE,
			appliedRates: PRICED,
			pricingTableVersion: PRICED,
			source: "headless",
			costBasis: "usd-proxy",
			endpointClass: "cloud",
			ledgerPosted: true,
			...extra,
		},
	});
	interface PreTyped {
		events: Array<{ kind: string; actor: string; data: Record<string, unknown> }>;
		receipts: Array<Record<string, unknown>>;
	}
	const PRE_TYPED: Record<string, PreTyped> = {
		settle: {
			events: [llmCall()],
			receipts: [{ receiptId: "R", model: MODEL_ID, cost: PRICED, settled: true, transferId: "T" }],
		},
		abort: {
			events: [
				{
					kind: "llm_call_failed",
					actor: "local",
					data: { model: MODEL_ID, transferId: "T", error: "provider 500", source: "headless" },
				},
			],
			receipts: [],
		},
		release: {
			events: [
				{
					kind: "hold_released",
					actor: "local",
					data: { model: MODEL_ID, transferId: "T", reason: "no usage", source: "headless" },
				},
			],
			receipts: [],
		},
		destroy: {
			events: [
				{
					kind: "hold_released",
					actor: "local",
					data: { transferId: "T", reason: "governor destroyed", source: "headless" },
				},
			],
			receipts: [],
		},
		settlement_ambiguous: {
			events: [
				{
					kind: "settlement_ambiguous",
					actor: "local",
					data: { model: MODEL_ID, cost: PRICED, transferId: "T", error: "socket reset" },
				},
				(() => {
					const { ledgerPosted: _l, ...rest } = llmCall({ settled: false }).data;
					return { kind: "llm_call", actor: "local", data: rest };
				})(),
			],
			receipts: [],
		},
		settlement_shortfall: {
			events: [
				llmCall({ postedAmount: 1 }),
				{
					kind: "settlement_shortfall",
					actor: "local",
					data: { model: MODEL_ID, actual: PRICED, posted: 1, shortfall: 4, transferId: "T" },
				},
			],
			receipts: [],
		},
		usage_implausible: {
			events: [
				(() => {
					const { usage: _u, ...rest } = llmCall({ usageSource: "estimated" }).data;
					return { kind: "llm_call", actor: "local", data: rest };
				})(),
				{
					kind: "usage_implausible",
					actor: "local",
					data: {
						checks: { cacheReadTokens: "sum" },
						model: MODEL_ID,
						transferId: "T",
						tiers: { cacheReadTokens: 1e15 },
						ceilingTokensPerTier: 100_000_000,
						charged: "estimate",
					},
				},
			],
			receipts: [],
		},
		"policy_denied (PII at the mutex boundary)": {
			events: [
				{
					kind: "policy_denied",
					actor: "local",
					data: {
						schemaVersion: 1,
						decision: "deny",
						denialClass: "pii",
						model: MODEL_ID,
						piiTypes: ["email"],
						promptHash: "138855b29486e3cfda6d199fde1c565c5313a0d880c50c07ac88cf10614279fe",
						promptHashAlg: "sha256-json-v1",
						endpointClass: "cloud",
						error: "Policy denied: PII detected: email",
						transferId: "T",
					},
				},
			],
			receipts: [],
		},
		"policy_denied (unknown model, the pre-mutex site)": {
			events: [
				{
					kind: "policy_denied",
					actor: "local",
					data: {
						schemaVersion: 1,
						decision: "deny",
						denialClass: "unknown_model",
						model: "no-such-model-xyz",
						promptHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
						promptHashAlg: "sha256-json-v1",
						endpointClass: "cloud",
						error: "Policy denied: unknown_model: no-such-model-xyz not in pricing table",
					},
				},
			],
			receipts: [],
		},
		ledger_rejected: {
			events: [
				{
					kind: "ledger_rejected",
					actor: "local",
					data: {
						schemaVersion: 1,
						decision: "deny",
						model: MODEL_ID,
						transferId: "T",
						estimatedCost: PRICED,
						endpointClass: "cloud",
						error: "Insufficient balance for user trust:hold: need 999, have 0",
					},
				},
			],
			receipts: [],
		},
	};

	const MASKED = new Set([
		"cost",
		"actual",
		"estimatedCost",
		"appliedRates",
		"pricingTableVersion",
	]);
	/** Deep copy with the per-run ids and the table-decided values masked, keys in sorted order. */
	const masked = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(masked);
		if (value === null || typeof value !== "object") return value;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (key === "transferId") out[key] = "T";
			else if (key === "receiptId") out[key] = "R";
			else if (MASKED.has(key)) out[key] = PRICED;
			else if (key === "error" && typeof v === "string") out[key] = v.split("\n")[0];
			else out[key] = masked(v);
		}
		return out;
	};

	describe.each(SCENARIOS)(
		"$name: serialized payloads are the pre-typed-jobs shape",
		(scenario) => {
			it.each([
				["an unlabelled call", {}, {}],
				["a job-only call", { job: JOB }, { job: JOB }],
				["an invalid-log call", { jobState: "invalid" }, { jobState: "invalid" }],
			])("%s", async (_label, labels, added) => {
				const pinned = PRE_TYPED[scenario.name];
				if (pinned === undefined) throw new Error(`no pinned shape for ${scenario.name}`);
				const run = await drive(scenario, labels);
				const expected = {
					events: pinned.events.map((e) => ({ ...e, data: { ...e.data, ...added } })),
					receipts: pinned.receipts.map((r) => ({ ...r, ...added })),
				};
				const actual = {
					events: run.events.map((e) => ({ kind: e.kind, actor: e.actor, data: e.data })),
					receipts: run.receipts.map((r) => r.data),
				};
				expect(JSON.stringify(masked(actual), null, 1)).toBe(
					JSON.stringify(masked(expected), null, 1),
				);
			});
		},
	);

	// ── Refused before any I/O ──

	it.each([
		["an unknown type", { job: JOB, jobType: "chore" }],
		["a differently-cased type", { job: JOB, jobType: "BUGFIX" }],
		["an unknown source", { job: JOB, jobType: "bugfix", typeSource: "inferred" }],
		["a type with no job", { jobType: "bugfix" }],
		["a source with no type", { job: JOB, typeSource: "agent" }],
		["a type with jobState invalid", { jobState: "invalid", jobType: "bugfix" }],
		[
			"a type and source with jobState invalid",
			{ jobState: "invalid", jobType: "bugfix", typeSource: "agent" },
		],
	])(
		"authorize refuses %s with a TypeError BEFORE any I/O: no hold, no record",
		async (_n, labels) => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await createGovernor({
				budget: 100_000,
				vaultBase,
				_engine: engine,
				_audit: audit,
			});
			await expect(gov.authorize({ ...AUTHORIZE, ...labels } as never)).rejects.toThrow(TypeError);
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(audit.events).toEqual([]);
			// …and the governor is unharmed: the next, valid call still goes through.
			const auth = await gov.authorize({ ...AUTHORIZE, ...TYPED });
			expect(auth.jobType).toBe("bugfix");
			await gov.destroy();
		},
	);

	// ── The handle is reporting; the capture is the record ──

	it("the handle reports jobType and typeSource; an untyped handle has neither key", async () => {
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: makeEngine(),
			_audit: makeAudit(),
		});
		const typed = await gov.authorize({ ...AUTHORIZE, ...TYPED });
		expect(typed).toMatchObject(TYPED);
		const plain = await gov.authorize({ ...AUTHORIZE, job: JOB });
		for (const key of TYPE_KEYS) expect(plain).not.toHaveProperty(key);
		const bare = await gov.authorize(AUTHORIZE);
		for (const key of ["job", ...TYPE_KEYS]) expect(bare).not.toHaveProperty(key);
		await gov.destroy();
	});

	it("a getter that answers differently after authorize reaches no record", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: makeEngine(),
			_audit: audit,
		});
		let typeReads = 0;
		let sourceReads = 0;
		const params = {
			...AUTHORIZE,
			job: JOB,
			get jobType() {
				typeReads++;
				return typeReads === 1 ? "feature" : "ops";
			},
			get typeSource() {
				sourceReads++;
				return sourceReads === 1 ? "agent" : "explicit";
			},
		};
		const auth = await gov.authorize(params as never);
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		expect(typeReads).toBe(1);
		expect(sourceReads).toBe(1);
		expect(record(audit, "llm_call").data).toMatchObject({
			job: JOB,
			jobType: "feature",
			typeSource: "agent",
		});
		await gov.destroy();
	});

	it("a caller mutation, or an extra settle property, cannot relabel a hold", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: makeEngine(),
			_audit: audit,
		});
		const params: Record<string, unknown> = { ...AUTHORIZE, ...TYPED };
		const auth = await gov.authorize(params as never);
		// the caller's own object, then the handle it holds
		params.jobType = "ops";
		params.typeSource = "explicit";
		(auth as { jobType?: string }).jobType = "ops";
		(auth as { typeSource?: string }).typeSource = "explicit";
		// …and a settle that SAYS something else: core's SettleParams has no such fields.
		await gov.settle(auth, {
			inputTokens: 10,
			outputTokens: 5,
			job: "job-z",
			jobType: "research",
			typeSource: "explicit",
		} as never);
		const data = record(audit, "llm_call").data;
		expect(data).toMatchObject(TYPED);
		expect(data.job).toBe(JOB);
		await gov.destroy();
	});

	it("an abort and a release cannot be relabelled by the handle either", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: makeEngine(),
			_audit: audit,
		});
		const a = await gov.authorize({ ...AUTHORIZE, ...TYPED });
		const b = await gov.authorize({ ...AUTHORIZE, ...TYPED });
		for (const h of [a, b]) {
			(h as { jobType?: string }).jobType = "ops";
			(h as { typeSource?: string }).typeSource = "explicit";
		}
		await gov.abort(a, new Error("boom"));
		await gov.release(b, "no usage");
		expect(record(audit, "llm_call_failed").data).toMatchObject(TYPED);
		expect(record(audit, "hold_released").data).toMatchObject(TYPED);
		await gov.destroy();
	});

	it("a type never moves money: the hold is the same transfer with and without one", async () => {
		const plain = makeEngine();
		const typed = makeEngine();
		const a = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: plain,
			_audit: makeAudit(),
		});
		const b = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: typed,
			_audit: makeAudit(),
		});
		await a.authorize({ ...AUTHORIZE, job: JOB });
		await b.authorize({ ...AUTHORIZE, ...TYPED });
		const strip = (call: unknown[]) => {
			const { transferId: _t, ...rest } = call[0] as Record<string, unknown>;
			return rest;
		};
		expect(strip(typed.spendPending.mock.calls[0] ?? [])).toEqual(
			strip(plain.spendPending.mock.calls[0] ?? []),
		);
		await a.destroy();
		await b.destroy();
	});
});
