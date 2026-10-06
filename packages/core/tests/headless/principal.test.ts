// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * WHO did the work: the caller's `actor` and its optional `principal` on every
 * record a headless call emits, and the principal's `user_data` tags on its hold.
 *
 * Pinned here:
 *  - `actor` is recorded as sent on the SETTLE-side records too. It used to be
 *    honoured only on denials; `llm_call`, `llm_call_failed`,
 *    `settlement_ambiguous`, `settlement_shortfall` and the rotated receipt all
 *    hard-coded "local", so whatever an integration said about who did the work
 *    was thrown away exactly where the money was recorded.
 *  - `principal` is captured ONCE at authorize, validated before any I/O, frozen,
 *    and read back from the governor's capture — never from the caller's object
 *    or handle — so it cannot be relabelled between the two phases.
 *  - an untagged call keeps its records' shape: no `principal` key, and no
 *    `userData` on the hold.
 *  - the principal never moves money: the hold debits the same account either way.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { listReceipts } from "../../src/audit/rotation.js";
import type { TrustEngine } from "../../src/govern.js";
import {
	createGovernor,
	type Governor,
	principalFieldRefusal,
	principalLedgerTags,
} from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";
import { capturePrincipal, ledgerTag } from "../../src/shared/principal.js";
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
const ACTOR = "claude-code:s-1:Explore:a7f3";
const PRINCIPAL = { id: "a7f3", type: "Explore", unit: "receipts", role: "reviewer" } as const;

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

/** An INDEPENDENT recomputation of the tag rule, for the golden pins below. */
function expectedTag(dimension: string, value: string, bytes: number): bigint {
	const digest = createHash("sha256")
		.update(`usertrust/ledger-tag/v1\n${dimension}\n${value}`, "utf8")
		.digest("hex");
	const tag = BigInt(`0x${digest.slice(0, bytes * 2)}`);
	return tag === 0n ? 1n : tag;
}

// ── The capture rule ──

describe("capturePrincipal", () => {
	it("absent or empty is NO principal", () => {
		expect(capturePrincipal(undefined)).toBeUndefined();
		expect(capturePrincipal({})).toBeUndefined();
		expect(capturePrincipal({ id: undefined })).toBeUndefined();
	});

	it("rebuilds the four fields, frozen, and drops anything else", () => {
		const out = capturePrincipal({ ...PRINCIPAL, secret: "x", nested: { a: 1 } });
		expect(out).toEqual(PRINCIPAL);
		expect(Object.isFrozen(out)).toBe(true);
		expect(out).not.toHaveProperty("secret");
	});

	it("reads each field ONCE (a getter cannot answer differently later)", () => {
		let reads = 0;
		const source = {
			get unit() {
				reads++;
				return reads === 1 ? "receipts" : "someone-else";
			},
		};
		const out = capturePrincipal(source);
		expect(out).toEqual({ unit: "receipts" });
		expect(reads).toBe(1);
		expect(out?.unit).toBe("receipts");
	});

	it("refuses an invalid field with a TypeError naming it", () => {
		expect(() => capturePrincipal({ unit: "has space" })).toThrow(/principal\.unit/);
		expect(() => capturePrincipal({ role: "" })).toThrow(TypeError);
		expect(() => capturePrincipal({ id: 42 })).toThrow(/principal\.id must be a string/);
		expect(() => capturePrincipal({ type: "x".repeat(129) })).toThrow(TypeError);
		expect(capturePrincipal({ type: "x".repeat(128) })).toEqual({ type: "x".repeat(128) });
	});

	it("refuses a principal that is not an object", () => {
		for (const bad of [null, "unit", 7, ["receipts"]]) {
			expect(() => capturePrincipal(bad)).toThrow(/principal must be an object/);
		}
	});

	it("principalFieldRefusal is the same rule, as a reason string", () => {
		expect(principalFieldRefusal("claude-code:s-1:Explore:a7f3")).toBeUndefined();
		expect(principalFieldRefusal("a/b")).toMatch(/1-128 characters/);
		expect(principalFieldRefusal(undefined)).toBe("must be a string");
	});
});

// ── The ledger tags ──

describe("principalLedgerTags", () => {
	it("id → user_data_128, unit → user_data_64, role → user_data_32; type stays off the ledger", () => {
		const tags = principalLedgerTags(PRINCIPAL);
		expect(tags.userData128).toBe(expectedTag("agent", PRINCIPAL.id, 16));
		expect(tags.userData64).toBe(expectedTag("unit", PRINCIPAL.unit, 8));
		expect(tags.userData32).toBe(Number(expectedTag("role", PRINCIPAL.role, 4)));
		// Golden: a change to the domain or the dimension names changes every
		// roll-up an operator has ever queried, so it must be deliberate.
		expect(tags.userData64).toBe(expectedTag("unit", "receipts", 8));
		expect(principalLedgerTags({ unit: "receipts" }).userData64).toBe(tags.userData64);
		expect(ledgerTag("unit", "receipts", 8)).toBe(tags.userData64);
	});

	it("an absent field (or principal) is ZERO — TigerBeetle's 'no tag'", () => {
		expect(principalLedgerTags(undefined)).toEqual({
			userData128: 0n,
			userData64: 0n,
			userData32: 0,
		});
		expect(principalLedgerTags({ type: "Explore" })).toEqual({
			userData128: 0n,
			userData64: 0n,
			userData32: 0,
		});
	});

	it("the dimensions are domain-separated: the same string tags differently per field", () => {
		expect(ledgerTag("unit", "x", 8)).not.toBe(ledgerTag("role", "x", 8));
	});
});

// ── The governor ──

describe("headless records carry the caller's actor and principal", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-principal-${randomUUID()}`);
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

	it("llm_call names the actor AS SENT and carries the principal", async () => {
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governor(engine, audit);
		const auth = await gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: PRINCIPAL });
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		const call = record(audit, "llm_call");
		expect(call.actor).toBe(ACTOR);
		expect(call.data).toMatchObject({ principal: PRINCIPAL });
		await gov.destroy();
	});

	it("an untagged call keeps its shape: actor 'local', no principal key, no hold userData", async () => {
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governor(engine, audit);
		const auth = await gov.authorize(AUTHORIZE);
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		const call = record(audit, "llm_call");
		expect(call.actor).toBe("local");
		expect(call.data).not.toHaveProperty("principal");
		expect(engine.spendPending.mock.calls[0]?.[0]).not.toHaveProperty("userData");
		await gov.destroy();
	});

	it("the hold carries the principal's ledger tags — and still debits the same account", async () => {
		const engine = makeEngine();
		const gov = await governor(engine, makeAudit());
		await gov.authorize({ ...AUTHORIZE, principal: PRINCIPAL });

		const spend = engine.spendPending.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(spend.userData).toEqual(principalLedgerTags(PRINCIPAL));
		// A label, never a payer: no envelope, so no debit account is named.
		expect(spend).not.toHaveProperty("debitAccountId");
		await gov.destroy();
	});

	it("llm_call_failed (abort) carries the actor and principal", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: PRINCIPAL });
		await gov.abort(auth, new Error("provider 500"));

		const failed = record(audit, "llm_call_failed");
		expect(failed.actor).toBe(ACTOR);
		expect(failed.data).toMatchObject({ principal: PRINCIPAL });
		await gov.destroy();
	});

	it("settlement_ambiguous (a POST that failed in transport) carries the actor and principal", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine({ post: new Error("socket reset") }), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: PRINCIPAL });
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		const ambiguous = record(audit, "settlement_ambiguous");
		expect(ambiguous.actor).toBe(ACTOR);
		expect(ambiguous.data).toMatchObject({ principal: PRINCIPAL });
		// …and the llm_call written after it, for the same call.
		expect(record(audit, "llm_call").actor).toBe(ACTOR);
		await gov.destroy();
	});

	it("settlement_shortfall carries the actor and principal", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine({ post: { posted: 1, shortfall: 4 } }), audit);
		const auth = await gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: PRINCIPAL });
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		const shortfall = record(audit, "settlement_shortfall");
		expect(shortfall.actor).toBe(ACTOR);
		expect(shortfall.data).toMatchObject({ principal: PRINCIPAL });
		await gov.destroy();
	});

	it("the rotated receipt carries the actor and principal", async () => {
		const gov = await governor(makeEngine(), makeAudit());
		const auth = await gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: PRINCIPAL });
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		await gov.destroy();

		const receipts = listReceipts(vaultBase, "llm_call").filter(
			(r) => r.data.transferId === auth.transferId,
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.actor).toBe(ACTOR);
		expect(receipts[0]?.data).toMatchObject({ principal: PRINCIPAL });
	});

	it("a policy denial (policy_denied) names the actor and the principal it refused", async () => {
		const audit = makeAudit();
		const gov = await governor(makeEngine(), audit, { budget: 100_000, pii: "block" });
		await expect(
			gov.authorize({
				...AUTHORIZE,
				actor: ACTOR,
				principal: PRINCIPAL,
				messages: [{ role: "user", content: "mail me at jane.doe@example.com" }],
			}),
		).rejects.toBeInstanceOf(PolicyDeniedError);

		const denied = record(audit, "policy_denied");
		expect(denied.actor).toBe(ACTOR);
		expect(denied.data).toMatchObject({ principal: PRINCIPAL });
		await gov.destroy();
	});

	it("the pre-mutex unknown-model refusal (policy_denied) names the actor and the principal", async () => {
		const audit = makeAudit();
		const engine = makeEngine();
		const gov = await governor(engine, audit, { budget: 100_000, unknownModelPolicy: "deny" });
		await expect(
			gov.authorize({
				...AUTHORIZE,
				model: "no-such-model-xyz",
				actor: ACTOR,
				principal: PRINCIPAL,
			}),
		).rejects.toBeInstanceOf(PolicyDeniedError);

		const denied = record(audit, "policy_denied");
		expect(denied.data).toMatchObject({ denialClass: "unknown_model", principal: PRINCIPAL });
		expect(denied.actor).toBe(ACTOR);
		expect(engine.spendPending).not.toHaveBeenCalled();
		await gov.destroy();
	});

	it("a ledger rejection (ledger_rejected) names the actor and the principal it refused", async () => {
		const audit = makeAudit();
		const engine = makeEngine({ spend: new InsufficientBalanceError("trust:hold", 999, 0) });
		const gov = await governor(engine, audit);
		await expect(
			gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: PRINCIPAL }),
		).rejects.toBeInstanceOf(InsufficientBalanceError);

		const rejected = record(audit, "ledger_rejected");
		expect(rejected.actor).toBe(ACTOR);
		expect(rejected.data).toMatchObject({ principal: PRINCIPAL });
		await gov.destroy();
	});

	it("an invalid principal is refused BEFORE any I/O — no hold, no record", async () => {
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governor(engine, audit);
		await expect(
			gov.authorize({ ...AUTHORIZE, principal: { unit: "not valid!" } }),
		).rejects.toBeInstanceOf(TypeError);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(audit.events).toHaveLength(0);
		await gov.destroy();
	});

	it("relabelling after authorize reaches nothing: the caller's object, then the handle", async () => {
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governor(engine, audit);
		const mine: { id: string; unit: string; role?: string } = { id: "a7f3", unit: "receipts" };
		const auth = await gov.authorize({ ...AUTHORIZE, actor: ACTOR, principal: mine });

		mine.unit = "someone-else";
		mine.role = "admin";
		(auth as unknown as Record<string, unknown>).principal = { unit: "someone-else" };
		(auth as unknown as Record<string, unknown>).actor = "someone-else";
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		const call = record(audit, "llm_call");
		expect(call.actor).toBe(ACTOR);
		expect(call.data).toMatchObject({ principal: { id: "a7f3", unit: "receipts" } });
		expect((call.data as { principal: object }).principal).not.toHaveProperty("role");
		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({
			userData: principalLedgerTags({ id: "a7f3", unit: "receipts" }),
		});
		await gov.destroy();
	});
});
