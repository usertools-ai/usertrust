// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P3-PII-REDACT-EGRESS (HIGH) — in `pii:"redact"` mode the OUTBOUND request to
 * the provider must be redacted (not just the local audit copy), and the caller's
 * original object must never be mutated. `pii:"block"` must prevent egress.
 *
 * The second half of this file pins the DENIAL HINTS, because the remedy a hint
 * prescribes is only honest on the path that can actually perform it. Exactly one
 * of the three PII block sites forwards a redacted clone to the provider; the
 * other two do not, and must not tell an operator that `pii:"redact"` will strip
 * PII before egress for them.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import type { PolicyDeniedError } from "../../src/shared/errors.js";

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

const VAULT_DIR = ".usertrust";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `harden-redact-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "usertrust.config.json"), JSON.stringify(config));
}

describe("P3-PII-REDACT-EGRESS", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("redact mode: the forwarded body is redacted and the caller's object is untouched", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, pii: "redact" });
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		const original = {
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "email me at alice@example.com and ssn 123-45-6789" }],
		};
		await governed.messages.create(original);

		const forwarded = createSpy.mock.calls[0]?.[0];
		const forwardedJson = JSON.stringify(forwarded);
		expect(forwardedJson).not.toContain("alice@example.com");
		expect(forwardedJson).not.toContain("123-45-6789");
		expect(forwardedJson).toContain("REDACTED");
		// Model preserved (not a PII match).
		expect((forwarded as { model: string }).model).toBe("claude-sonnet-4-6");

		// Caller's original object is NOT mutated.
		expect(original.messages[0].content).toContain("alice@example.com");
		expect(original.messages[0].content).toContain("123-45-6789");

		await governed.destroy();
	});

	it("block mode: PII prevents egress entirely", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, pii: "block" });
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "ssn 123-45-6789" }],
			}),
		).rejects.toThrow(/PII detected/);
		expect(createSpy).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("redact mode with no PII forwards the body verbatim", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, pii: "redact" });
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "what is the capital of France?" }],
		});
		const forwarded = JSON.stringify(createSpy.mock.calls[0]?.[0]);
		expect(forwarded).toContain("capital of France");
		expect(forwarded).not.toContain("REDACTED");

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Denial-hint truth: a hint may only prescribe a remedy its own path performs
// ---------------------------------------------------------------------------

/** Run `fn`, require it to reject, and hand back the thrown PolicyDeniedError. */
async function denialFrom(fn: () => Promise<unknown>): Promise<PolicyDeniedError> {
	try {
		await fn();
	} catch (err) {
		return err as PolicyDeniedError;
	}
	throw new Error("expected the call to be denied, but it resolved");
}

describe("PII denial hints name only the remedy their own path can perform", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("trust() LLM path offers redact — it is the ONE site that redacts egress", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, pii: "block" });
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		const err = await denialFrom(() =>
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "ssn 123-45-6789" }],
			}),
		);

		// The interceptCall redact branch really does forward a redacted DEEP CLONE
		// (pinned by the first test in this file), so this remedy is TRUE here.
		expect(err.hint).toBe(
			'PII enforcement blocked this call. Use { pii: "warn" } to log instead, or { pii: "redact" } to strip PII before egress.',
		);

		await governed.destroy();
	});

	it("headless authorize does NOT promise redaction — the host owns egress", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, pii: "block" });
		const gov = await createGovernor({ dryRun: true, vaultBase: tmpVault });

		const err = await denialFrom(() =>
			gov.authorize({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "ssn 123-45-6789" }],
			}),
		);

		// The headless governor never sees the outbound request — it authorizes and
		// settles around a call the integrating host makes itself. `pii: "redact"`
		// cannot strip anything here, so the hint must not claim it will.
		expect(err.hint).toBe(
			'PII enforcement blocked this call. Use { pii: "warn" } to log instead of block; the headless governor does not redact egress — redaction is the integrating host\'s responsibility.',
		);
		expect(err.hint).not.toContain("strip PII before egress");

		await gov.destroy();
	});

	it("governAction says redact touches the AUDIT copy only — execute sees the original", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, pii: "block" });
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: tmpVault },
		);
		const executeFn = vi.fn(async () => "done");

		const err = await denialFrom(() =>
			governed.governAction(
				{ kind: "tool_use", name: "send_data", cost: 10, params: { ssn: "123-45-6789" } },
				executeFn,
			),
		);

		// On a governed action, redaction applies to the audited copy of the params.
		// The execute closure is the caller's own and runs on the ORIGINAL input, so
		// "strip PII before egress" would be a false promise.
		expect(err.hint).toBe(
			'PII enforcement blocked this action. Use { pii: "warn" } to log instead of block; on governed actions { pii: "redact" } redacts only the audit copy — the action itself runs on the original input.',
		);
		expect(err.hint).not.toContain("strip PII before egress");
		expect(executeFn).not.toHaveBeenCalled();

		await governed.destroy();
	});
});

describe("unknown-model denial hint names the real configuration surface", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// `customRates` is NOT a trust()/GovernorOpts option. It is a
	// usertrust.config.json field, honored only when `pricing` is "custom"
	// (ledger/pricing.ts resolveRates) — so the old hint sent operators to an
	// option that does not exist.
	const EXPECTED_HINT =
		'Set pricing: "custom" with a customRates entry for this model in usertrust.config.json, or use a model from the built-in pricing table.';

	it("trust() names usertrust.config.json + pricing: custom", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, unknownModelPolicy: "deny" });
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		const err = await denialFrom(() =>
			governed.messages.create({
				model: "not-a-real-model-abc",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			}),
		);

		expect(err.message).toContain("unknown_model");
		expect(err.hint).toBe(EXPECTED_HINT);
		expect(err.hint).not.toContain("trust() options");

		await governed.destroy();
	});

	it("createGovernor() names the same surface (F5: identical wording)", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, unknownModelPolicy: "deny" });
		const gov = await createGovernor({ dryRun: true, vaultBase: tmpVault });

		const err = await denialFrom(() =>
			gov.authorize({ model: "not-a-real-model-abc", maxOutputTokens: 64 }),
		);

		expect(err.message).toContain("unknown_model");
		expect(err.hint).toBe(EXPECTED_HINT);
		expect(err.hint).not.toContain("trust() options");

		await gov.destroy();
	});
});
