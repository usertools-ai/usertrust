// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The `Authorization` handle is the CALLER's own object, live in its hands for the
 * whole authorize→terminal window. Nothing written to it in that window may change
 * what a terminal charges, decrements or records.
 *
 * Every terminal reads the governor's capture instead (AGENTS.md, Audit: never from
 * the handle). Before that, `settle()` priced from `auth.model` and `auth.endpoint`,
 * so one assignment between the two phases — a cheaper model, or `class: "local"` —
 * re-rated a call whose hold was already placed, and `settle()`/`abort()` subtracted
 * `auth.estimatedCost` from the session's in-flight total, so the caller could move
 * that total too. Each row below has an untampered CONTROL governor beside it, so a
 * pass cannot come from the tamper having had no effect to begin with.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { type Authorization, createGovernor, type Governor } from "../../src/headless.js";
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const BUDGET = 100_000;
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };
// A model the built-in table prices well below the authorized one.
const CHEAPER_MODEL = "claude-haiku-4-5";
const USAGE = { inputTokens: 8_000, outputTokens: 2_000 };

function makeEngine(): TrustEngine & {
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
} {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => undefined),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

interface AuditHandle extends AuditWriter {
	events: AppendEventInput[];
}

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

function dataOf(audit: AuditHandle, kind: string): Record<string, unknown> {
	const event = audit.events.find((e) => e.kind === kind);
	if (event === undefined) throw new Error(`no ${kind} event`);
	return event.data;
}

/** Every rewrite a caller can make to its own handle, applied at once. */
function tamper(auth: Authorization): void {
	auth.model = CHEAPER_MODEL;
	auth.estimatedCost = 1;
	auth.proxyTransferId = "proxy-forged";
	(auth as { endpoint?: unknown }).endpoint = { class: "local", runtime: "ollama" };
}

describe("the handle is the caller's: nothing written to it reaches a terminal", () => {
	const vaults: string[] = [];
	const governors: Governor[] = [];

	afterEach(async () => {
		for (const gov of governors.splice(0)) await gov.destroy();
		for (const dir of vaults.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	let engine: ReturnType<typeof makeEngine>;
	beforeEach(() => {
		engine = makeEngine();
	});

	async function governor(audit: AuditHandle = makeAudit()): Promise<Governor> {
		const vaultBase = join(tmpdir(), `headless-tamper-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		vaults.push(vaultBase);
		const gov = await createGovernor({ budget: BUDGET, vaultBase, _engine: engine, _audit: audit });
		governors.push(gov);
		return gov;
	}

	it("the tamper is real: the cheaper model really does price lower (the control's control)", async () => {
		const gov = await governor();
		const authorized = await gov.settle(await gov.authorize(AUTHORIZE), USAGE);
		const cheaper = await gov.settle(
			await gov.authorize({ ...AUTHORIZE, model: CHEAPER_MODEL }),
			USAGE,
		);
		expect(cheaper.cost).toBeLessThan(authorized.cost);
	});

	it("settle prices the AUTHORIZED model and endpoint, and records them", async () => {
		const control = await governor();
		const expected = await control.settle(await control.authorize(AUTHORIZE), USAGE);

		const audit = makeAudit();
		const gov = await governor(audit);
		const auth = await gov.authorize(AUTHORIZE);
		tamper(auth);
		const receipt = await gov.settle(auth, USAGE);

		expect(receipt.cost).toBe(expected.cost);
		expect(receipt.model).toBe(AUTHORIZE.model);
		expect(receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
		expect(receipt.pricing).toEqual(expected.pricing);
		expect(dataOf(audit, "llm_call").model).toBe(AUTHORIZE.model);
		expect(engine.postPendingSpend).toHaveBeenLastCalledWith(auth.transferId, expected.cost);
	});

	it("an IN-PLACE edit of the handle's endpoint object never reaches the capture", async () => {
		// The handle and the capture were once one object; an in-place edit through
		// a shared reference would re-rate the call without replacing anything.
		const control = await governor();
		const expected = await control.settle(await control.authorize(AUTHORIZE), USAGE);

		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const endpoint = auth.endpoint as { class: string; runtime: string };
		endpoint.class = "local";
		endpoint.runtime = "ollama";
		const receipt = await gov.settle(auth, USAGE);

		expect(receipt.cost).toBe(expected.cost);
		expect(receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
	});

	it("settle subtracts what authorize RESERVED from the in-flight total", async () => {
		const control = await governor();
		const expected = await control.settle(await control.authorize(AUTHORIZE), USAGE);

		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		tamper(auth);
		await gov.settle(auth, USAGE);

		expect(gov.budgetRemaining()).toBe(control.budgetRemaining());
		expect(gov.budgetRemaining()).toBe(BUDGET - expected.cost);
	});

	it("abort returns exactly what authorize reserved, and records the authorized model", async () => {
		const audit = makeAudit();
		const gov = await governor(audit);
		const auth = await gov.authorize(AUTHORIZE);
		tamper(auth);

		await gov.abort(auth, new Error("provider 500"));

		expect(gov.budgetRemaining()).toBe(BUDGET);
		expect(dataOf(audit, "llm_call_failed").model).toBe(AUTHORIZE.model);
	});
});
