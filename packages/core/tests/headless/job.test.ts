// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * WHICH JOB a spend was for: `job`, `jobState` and `usageFrom` captured ONCE at
 * authorize, `usageTo` from the settle, and every record of the hold carrying the
 * authorize capture's labels. A job is a label, never a payer.
 *
 * Job ids here are opaque. Each test names the mutant it kills.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";
import { captureJob, captureUsageTo, usageTimeRefusal } from "../../src/shared/job.js";
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

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-01T00:00:05.000Z";
const LABELS: { job: string; usageFrom: string } = { job: "job-a", usageFrom: FROM };

describe("captureJob", () => {
	it("absent is an empty, frozen capture", () => {
		const out = captureJob({});
		expect(out).toEqual({});
		expect(Object.isFrozen(out)).toBe(true);
	});
	it("rebuilds job, jobState and usageFrom; frozen", () => {
		expect(captureJob(LABELS)).toEqual(LABELS);
		expect(captureJob({ jobState: "invalid" })).toEqual({ jobState: "invalid" });
		expect(Object.isFrozen(captureJob(LABELS))).toBe(true);
	});
	it("reads each field ONCE (a getter cannot answer differently later)", () => {
		let reads = 0;
		const out = captureJob({
			get job() {
				reads++;
				return reads === 1 ? "job-a" : "job-b";
			},
		});
		expect(out.job).toBe("job-a");
		expect(reads).toBe(1);
	});
	it.each([
		["a job with a space", { job: "has space" }, /job must be 1-128/],
		["an empty job", { job: "" }, /job must be/],
		["a numeric job", { job: 7 }, /job must be a string/],
		["a 129-character job", { job: "x".repeat(129) }, /job must be/],
		["a jobState other than invalid", { jobState: "ok" }, /jobState must be/],
		["a job with a jobState", { job: "job-a", jobState: "invalid" }, /cannot accompany/],
		["a non-UTC usageFrom", { usageFrom: "2026-01-01T00:00:00+02:00" }, /usageFrom must be an ISO/],
		["a date-only usageFrom", { usageFrom: "2026-01-01" }, /usageFrom must be an ISO/],
	])("refuses %s with a TypeError", (_name, input, message) => {
		expect(() => captureJob(input)).toThrow(TypeError);
		expect(() => captureJob(input)).toThrow(message);
	});
	it("usageTo is validated by the same time rule", () => {
		expect(captureUsageTo(TO)).toEqual({ usageTo: TO });
		expect(captureUsageTo(undefined)).toEqual({});
		expect(() => captureUsageTo("tomorrow")).toThrow(TypeError);
		expect(usageTimeRefusal(FROM)).toBeUndefined();
		expect(usageTimeRefusal("2026-13-45T00:00:00.000Z")).toMatch(/ISO-8601 UTC/);
	});
	it("refuses a calendar date Date.parse would silently normalize", () => {
		for (const bad of [
			"2026-02-31T00:00:00.000Z",
			"2026-02-29T00:00:00.000Z",
			"2026-04-31T00:00:00Z",
			"2026-01-01T24:00:00.000Z",
			"2026-01-01T00:60:00.000Z",
		]) {
			expect(usageTimeRefusal(bad), bad).toMatch(/ISO-8601 UTC/);
		}
		expect(usageTimeRefusal("2028-02-29T23:59:59.999Z")).toBeUndefined();
	});
	it("allows at most millisecond precision (finer digits would compare equal)", () => {
		expect(usageTimeRefusal("2026-01-01T00:00:00.000000009Z")).toMatch(/ISO-8601 UTC/);
		expect(usageTimeRefusal("2026-01-01T00:00:00.1234Z")).toMatch(/ISO-8601 UTC/);
		expect(usageTimeRefusal("2026-01-01T00:00:00.123Z")).toBeUndefined();
		expect(usageTimeRefusal("2026-01-01T00:00:00Z")).toBeUndefined();
	});
});

describe("headless records carry the authorize capture's job", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-job-${randomUUID()}`);
		mkdirSync(join(vaultBase, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});
	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function governor(
		engine: EngineHandle,
		audit: AuditHandle,
		config?: object,
	): Promise<Governor> {
		if (config !== undefined) {
			writeFileSync(join(vaultBase, VAULT_DIR, "usertrust.config.json"), JSON.stringify(config));
		}
		return await createGovernor({ budget: 100_000, vaultBase, _engine: engine, _audit: audit });
	}

	it("llm_call: job and usageFrom from authorize, usageTo from the settle", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5, usageTo: TO });
		expect(record(audit, "llm_call").data).toMatchObject({ ...LABELS, usageTo: TO });
		await gov.destroy();
	});

	it("an unlabelled call's records are byte-identical to before: no job keys", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize(AUTHORIZE);
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		for (const key of ["job", "jobState", "usageFrom", "usageTo"]) {
			expect(record(audit, "llm_call").data).not.toHaveProperty(key);
		}
		expect(auth).not.toHaveProperty("job");
		await gov.destroy();
	});

	it("jobState invalid is recorded with no job", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, jobState: "invalid" });
		await gov.settle(auth, { inputTokens: 1, outputTokens: 1 });
		const data = record(audit, "llm_call").data;
		expect(data).toMatchObject({ jobState: "invalid" });
		expect(data).not.toHaveProperty("job");
		await gov.destroy();
	});

	it("llm_call_failed (abort) carries job and usageFrom", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.abort(auth, new Error("provider 500"));
		expect(record(audit, "llm_call_failed").data).toMatchObject(LABELS);
		await gov.destroy();
	});

	it("hold_released (release) inherits job and usageFrom from the capture", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.release(auth, "no usage");
		const data = record(audit, "hold_released").data;
		expect(data).toMatchObject(LABELS);
		expect(data).not.toHaveProperty("usageTo");
		await gov.destroy();
	});

	it("release records a structured releaseClass, and only a valid one", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await expect(
			gov.release(auth, "x", { releaseClass: "because" as unknown as "unused" }),
		).rejects.toThrow(/releaseClass must be one of/);
		// refused BEFORE the claim: the hold is still releasable
		await gov.release(auth, "given back", { releaseClass: "unused" });
		expect(record(audit, "hold_released").data).toMatchObject({
			reason: "given back",
			releaseClass: "unused",
		});
		await gov.destroy();
	});

	it("a release that states no class records none, and so does destroy(): neither proves anything", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const a = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.release(a, "session ended with unsettled hold");
		await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.destroy();
		const released = audit.events.filter((e) => e.kind === "hold_released");
		expect(released).toHaveLength(2);
		for (const e of released) expect(e.data).not.toHaveProperty("releaseClass");
	});

	it("destroy() releasing a hold still held records its job too", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.destroy();
		expect(record(audit, "hold_released").data).toMatchObject(LABELS);
	});

	it("settlement_shortfall carries the job", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine({ post: { posted: 1, shortfall: 4 } }), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5, usageTo: TO });
		expect(record(audit, "settlement_shortfall").data).toMatchObject({ job: "job-a" });
		await gov.destroy();
	});

	it("a policy denial names the job it refused", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit, { budget: 100_000, pii: "block" });
		await expect(
			gov.authorize({
				...AUTHORIZE,
				...LABELS,
				messages: [{ role: "user", content: "mail me at jane.doe@example.com" }],
			}),
		).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(record(audit, "policy_denied").data).toMatchObject(LABELS);
		await gov.destroy();
	});

	it("the pre-mutex unknown-model refusal names the job", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit, {
			budget: 100_000,
			unknownModelPolicy: "deny",
		});
		await expect(
			gov.authorize({ ...AUTHORIZE, model: "no-such-model-xyz", ...LABELS }),
		).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(record(audit, "policy_denied").data).toMatchObject(LABELS);
		await gov.destroy();
	});

	it("a ledger rejection names the job", async () => {
		const audit = makeAudit();
		const gov = await governor(
			makeEngine({ spend: new InsufficientBalanceError("trust:hold", 999, 0) }),
			audit,
		);
		await expect(gov.authorize({ ...AUTHORIZE, ...LABELS })).rejects.toBeInstanceOf(
			InsufficientBalanceError,
		);
		expect(record(audit, "ledger_rejected").data).toMatchObject(LABELS);
		await gov.destroy();
	});

	it("an invalid job is refused BEFORE any I/O — no hold, no record", async () => {
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governor(engine, audit);
		await expect(gov.authorize({ ...AUTHORIZE, job: "has space" })).rejects.toThrow(TypeError);
		await expect(gov.authorize({ ...AUTHORIZE, usageFrom: "later" })).rejects.toThrow(TypeError);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(audit.events).toEqual([]);
		await gov.destroy();
	});

	it("relabelling after authorize reaches nothing: the handle, then the caller's params", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const params = { ...AUTHORIZE, ...LABELS };
		const auth = await gov.authorize(params);
		expect(auth.job).toBe("job-a");
		params.job = "job-z";
		(auth as { job?: string }).job = "job-z";
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		expect(record(audit, "llm_call").data).toMatchObject({ job: "job-a" });
		await gov.destroy();
	});

	it("a job never moves money: the hold is the same transfer with and without one", async () => {
		const plain = makeEngine();
		const labelled = makeEngine();
		const a = await governor(plain, makeAudit());
		const b = await governor(labelled, makeAudit());
		await a.authorize(AUTHORIZE);
		await b.authorize({ ...AUTHORIZE, ...LABELS });
		const strip = (call: unknown[]) => {
			const { transferId: _t, ...rest } = call[0] as Record<string, unknown>;
			return rest;
		};
		expect(strip(labelled.spendPending.mock.calls[0] ?? [])).toEqual(
			strip(plain.spendPending.mock.calls[0] ?? []),
		);
		await a.destroy();
		await b.destroy();
	});

	it("a usageTo before the hold's usageFrom is refused before the claim, and the hold stays settleable", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await expect(
			gov.settle(auth, { inputTokens: 1, outputTokens: 1, usageTo: "2025-12-31T23:59:59.999Z" }),
		).rejects.toThrow(/usageTo must not be before/);
		expect(audit.events.filter((e) => e.kind === "llm_call")).toEqual([]);
		await gov.settle(auth, { inputTokens: 1, outputTokens: 1, usageTo: TO });
		expect(record(audit, "llm_call").data).toMatchObject({ usageFrom: FROM, usageTo: TO });
		await gov.destroy();
	});

	it("a bad usageTo is refused before the claim: the hold stays settleable", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, ...LABELS });
		await expect(
			gov.settle(auth, { inputTokens: 1, outputTokens: 1, usageTo: "soon" }),
		).rejects.toThrow(TypeError);
		await gov.settle(auth, { inputTokens: 1, outputTokens: 1, usageTo: TO });
		expect(record(audit, "llm_call").data).toMatchObject({ usageTo: TO });
		await gov.destroy();
	});
});
