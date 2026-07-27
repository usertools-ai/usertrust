// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P3-PII-REDACT-EGRESS (HIGH) — in `pii:"redact"` mode the OUTBOUND request to
 * the provider must be redacted (not just the local audit copy), and the caller's
 * original object must never be mutated. `pii:"block"` must prevent egress.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";

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
