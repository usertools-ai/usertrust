// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `principal` — WHO spent, carried onto every record a hold leaves, without ever
 * touching the wallet.
 *
 * Named `principal` rather than "attribution" because core already spends that word
 * on cost-center envelopes (`CostCenterAttribution`, `envelope.attribution`), which
 * DO select a wallet. A principal never does: it never picks an account and never
 * enters the policy gate. It is a label on the record.
 *
 * The record rules are AGENTS.md's Audit rules, applied to a new field:
 *  - captured at authorize, onto the governor's own capture — never read back from
 *    the caller's handle or object afterwards;
 *  - emitted as an object REBUILT from validated scalars, never the caller's object
 *    spread into a payload;
 *  - on every terminal a hold can reach, and on the receipt ROOT;
 *  - absent (the key, not an `undefined` value) when the caller gave none, so an
 *    unattributed record stays byte-identical to what it was before.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { type AuthorizeParams, createGovernor, type Governor } from "../../src/headless.js";
import { evaluatePolicy, type PolicyContext } from "../../src/policy/gate.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { AlreadySettledError, InsufficientBalanceError } from "../../src/shared/errors.js";
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

// The evaluator stays REAL; this only records the context it was handed.
vi.mock("../../src/policy/gate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/policy/gate.js")>();
	return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

// ── Harness ──

const PRINCIPAL = { id: "user-42", type: "human", origin: "cli:session.7" };
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };
const USAGE = { inputTokens: 80, outputTokens: 200 };

interface EngineHandle extends TrustEngine {
	spendPending: Mock<TrustEngine["spendPending"]>;
	postPendingSpend: Mock<TrustEngine["postPendingSpend"]>;
	voidPendingSpend: Mock<TrustEngine["voidPendingSpend"]>;
	lookupTransfer: Mock<NonNullable<TrustEngine["lookupTransfer"]>>;
}

type PostBehaviour = "ok" | "shortfall" | "ambiguous" | "duplicate";

function makeEngine(post: PostBehaviour = "ok"): EngineHandle {
	return {
		spendPending: vi.fn<TrustEngine["spendPending"]>(async (p) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn<TrustEngine["postPendingSpend"]>(async () => {
			if (post === "shortfall") return { posted: 5, shortfall: 3 };
			if (post === "ambiguous") throw new Error("socket hang up");
			if (post === "duplicate") throw new AlreadySettledError();
			return undefined;
		}),
		voidPendingSpend: vi.fn<TrustEngine["voidPendingSpend"]>(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		// No post anchor exists: the keyed authorize below proceeds to a hold.
		lookupTransfer: vi.fn<NonNullable<TrustEngine["lookupTransfer"]>>(async () => null),
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
	if (event === undefined) {
		throw new Error(`no ${kind} event (saw: ${audit.events.map((e) => e.kind).join(", ")})`);
	}
	return event.data;
}

/** Every rotated receipt the governor wrote under this vault. */
function rotatedReceipts(vaultBase: string): Array<{ data: Record<string, unknown> }> {
	const root = join(vaultBase, VAULT_DIR, "audit", "llm_call");
	const out: Array<{ data: Record<string, unknown> }> = [];
	for (const day of readdirSync(root)) {
		for (const file of readdirSync(join(root, day))) {
			out.push(JSON.parse(readFileSync(join(root, day, file), "utf-8")));
		}
	}
	return out;
}

describe("principal on the record", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-principal-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function governorWith(engine: EngineHandle, audit: AuditHandle): Promise<Governor> {
		return await createGovernor({ budget: 100_000, vaultBase, _engine: engine, _audit: audit });
	}

	describe("present on every record a hold can leave", () => {
		it("llm_call, the rotated receipt, and the receipt ROOT", async () => {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine(), audit);

			const auth = await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL });
			const receipt = await gov.settle(auth, USAGE);

			expect(dataOf(audit, "llm_call").principal).toEqual(PRINCIPAL);
			// AGENTS.md: new receipt fields go at the ROOT — receipt.v1 closes `meter`.
			expect(receipt.principal).toEqual(PRINCIPAL);
			expect(receipt.meter).not.toHaveProperty("principal");
			const [rotated] = rotatedReceipts(vaultBase);
			expect(rotated?.data.principal).toEqual(PRINCIPAL);

			await gov.destroy();
		});

		it("settlement_shortfall", async () => {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine("shortfall"), audit);

			await gov.settle(await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL }), USAGE);

			expect(dataOf(audit, "settlement_shortfall").principal).toEqual(PRINCIPAL);

			await gov.destroy();
		});

		it("settlement_ambiguous", async () => {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine("ambiguous"), audit);

			await gov.settle(await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL }), USAGE);

			expect(dataOf(audit, "settlement_ambiguous").principal).toEqual(PRINCIPAL);

			await gov.destroy();
		});

		it("llm_call_failed", async () => {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine(), audit);

			await gov.abort(
				await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL }),
				new Error("provider 500"),
			);

			expect(dataOf(audit, "llm_call_failed").principal).toEqual(PRINCIPAL);

			await gov.destroy();
		});

		it("hold_released", async () => {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine(), audit);

			await gov.release(await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL }));

			expect(dataOf(audit, "hold_released").principal).toEqual(PRINCIPAL);

			await gov.destroy();
		});

		it("settlement_duplicate (and the hold_released the duplicate path writes)", async () => {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine("duplicate"), audit);

			const auth = await gov.authorize({
				...AUTHORIZE,
				principal: PRINCIPAL,
				idempotencyKey: "call-1",
			});
			await expect(gov.settle(auth, USAGE)).rejects.toBeInstanceOf(AlreadySettledError);

			expect(dataOf(audit, "settlement_duplicate").principal).toEqual(PRINCIPAL);
			expect(dataOf(audit, "hold_released").principal).toEqual(PRINCIPAL);

			await gov.destroy();
		});
	});

	it("a REFUSED call's denial record names who was refused, and the key's hash — never the key", async () => {
		const audit = makeAudit();
		const engine = makeEngine();
		engine.spendPending.mockRejectedValueOnce(new InsufficientBalanceError("trust:hold", 999, 1));
		const gov = await governorWith(engine, audit);

		await expect(
			gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL, idempotencyKey: "call-1" }),
		).rejects.toBeInstanceOf(InsufficientBalanceError);

		const denied = dataOf(audit, "ledger_rejected");
		expect(denied.principal).toEqual(PRINCIPAL);
		expect(denied.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(audit.events)).not.toContain("call-1");

		await gov.destroy();
	});

	it("is ABSENT — the key, not an undefined value — when the caller gave none", async () => {
		const audit = makeAudit();
		const gov = await governorWith(makeEngine("shortfall"), audit);

		const receipt = await gov.settle(await gov.authorize(AUTHORIZE), USAGE);
		await gov.abort(await gov.authorize(AUTHORIZE), new Error("boom"));
		await gov.release(await gov.authorize(AUTHORIZE));

		for (const event of audit.events) {
			expect(Object.keys(event.data), `${event.kind} grew a principal key`).not.toContain(
				"principal",
			);
		}
		expect(Object.keys(receipt)).not.toContain("principal");
		for (const rotated of rotatedReceipts(vaultBase)) {
			expect(Object.keys(rotated.data)).not.toContain("principal");
		}

		await gov.destroy();
	});

	it("omits `origin` when the caller omitted it", async () => {
		const audit = makeAudit();
		const gov = await governorWith(makeEngine(), audit);

		await gov.release(
			await gov.authorize({ ...AUTHORIZE, principal: { id: "svc", type: "service" } }),
		);

		const principal = dataOf(audit, "hold_released").principal as Record<string, unknown>;
		expect(principal).toEqual({ id: "svc", type: "service" });
		expect(Object.keys(principal)).not.toContain("origin");

		await gov.destroy();
	});

	it("is captured at authorize: mutating the caller's object afterwards changes nothing", async () => {
		const audit = makeAudit();
		const gov = await governorWith(makeEngine(), audit);

		const mine = { id: "user-42", type: "human", origin: "cli" };
		const auth = await gov.authorize({ ...AUTHORIZE, principal: mine });
		mine.id = "someone-else";
		mine.type = "admin";
		(mine as Record<string, unknown>).extra = "smuggled";
		const receipt = await gov.settle(auth, USAGE);

		const recorded = { id: "user-42", type: "human", origin: "cli" };
		expect(dataOf(audit, "llm_call").principal).toEqual(recorded);
		expect(receipt.principal).toEqual(recorded);

		await gov.destroy();
	});

	it("is REBUILT from validated scalars: extra caller keys never reach the record", async () => {
		const audit = makeAudit();
		const gov = await governorWith(makeEngine(), audit);

		const withExtras = { ...PRINCIPAL, apiKey: "sk-secret-value", nested: { a: 1 } };
		await gov.release(await gov.authorize({ ...AUTHORIZE, principal: withExtras }));

		const recorded = dataOf(audit, "hold_released").principal as Record<string, unknown>;
		expect(recorded).toEqual(PRINCIPAL);
		expect(recorded).not.toBe(withExtras);
		expect(JSON.stringify(audit.events)).not.toContain("sk-secret-value");

		await gov.destroy();
	});

	it("reads each caller field exactly once, so a getter cannot pass validation and record another value", async () => {
		const audit = makeAudit();
		const gov = await governorWith(makeEngine(), audit);

		let reads = 0;
		const shifty = {
			get id(): string {
				reads += 1;
				return reads === 1 ? "user-42" : "bad value with spaces";
			},
			type: "human",
		};
		await gov.release(await gov.authorize({ ...AUTHORIZE, principal: shifty }));

		expect(reads).toBe(1);
		expect(dataOf(audit, "hold_released").principal).toEqual({ id: "user-42", type: "human" });

		await gov.destroy();
	});

	describe("invalid shapes are refused with a TypeError, before any I/O", () => {
		const bad: Array<[string, unknown]> = [
			["null", null],
			["a string", "user-42"],
			["an array", ["user-42", "human"]],
			["missing id", { type: "human" }],
			["missing type", { id: "user-42" }],
			["an empty id", { id: "", type: "human" }],
			["a non-string id", { id: 42, type: "human" }],
			["a space in the id", { id: "user 42", type: "human" }],
			["a control character", { id: `user${String.fromCharCode(0x1b)}`, type: "human" }],
			["non-ASCII", { id: "usér", type: "human" }],
			["129 characters", { id: "x".repeat(129), type: "human" }],
			["an empty origin", { id: "user-42", type: "human", origin: "" }],
			["a non-string origin", { id: "user-42", type: "human", origin: 7 }],
			["a slash in the type", { id: "user-42", type: "human/admin" }],
		];

		it.each(bad)("%s", async (_label, principal) => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);

			await expect(
				gov.authorize({ ...AUTHORIZE, principal } as unknown as AuthorizeParams),
			).rejects.toBeInstanceOf(TypeError);
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(engine.lookupTransfer).not.toHaveBeenCalled();
			expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
			expect(audit.events).toHaveLength(0);

			await gov.destroy();
		});

		it("accepts the boundary: 128 characters of every allowed class, origin included", async () => {
			const gov = await governorWith(makeEngine(), makeAudit());
			const edge = `${"Az09._:-".repeat(16)}`;
			expect(edge).toHaveLength(128);
			await expect(
				gov.authorize({ ...AUTHORIZE, principal: { id: edge, type: edge, origin: edge } }),
			).resolves.toBeDefined();
			await gov.destroy();
		});
	});

	it("has NO wallet effect: the same debit account with and without a principal", async () => {
		const engine = makeEngine();
		const gov = await governorWith(engine, makeAudit());

		await gov.authorize(AUTHORIZE);
		await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL });

		const [plain, labelled] = engine.spendPending.mock.calls.map(
			([p]) => p as Record<string, unknown>,
		);
		expect(plain?.debitAccountId).toBeUndefined();
		expect(labelled?.debitAccountId).toBeUndefined();
		expect(Object.keys(labelled ?? {}).sort()).toEqual(Object.keys(plain ?? {}).sort());
		expect(labelled?.amount).toBe(plain?.amount);

		await gov.destroy();
	});

	it("never enters the policy gate", async () => {
		const gov = await governorWith(makeEngine(), makeAudit());

		await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL });

		const calls = vi.mocked(evaluatePolicy).mock.calls;
		const ctx = calls[calls.length - 1]?.[1] as PolicyContext;
		expect(ctx).toBeDefined();
		expect(Object.keys(ctx)).not.toContain("principal");
		expect(JSON.stringify(ctx)).not.toContain(PRINCIPAL.id);

		await gov.destroy();
	});
});
