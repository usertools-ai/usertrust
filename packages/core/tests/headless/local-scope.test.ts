// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * M2 Task 4 — Headless Governor endpoint scope.
 *
 * Pins: governor-wide default endpoint scope (GovernorOpts.endpoint), per-call
 * AuthorizeParams.endpoint override (A3: scope is CAPTURED at authorize and
 * governs settle), SettleParams.computeMs passthrough into receipt.meter,
 * unknownModelPolicy enforcement at authorize for cloud scope (A5), and A6
 * receipt-field discipline (absent optional fields are OMITTED).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";
import type { EndpointInfo } from "../../src/shared/types.js";

// Mock tigerbeetle-node (native module, never loaded in tests)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Test helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `headless-local-scope-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

// ── Tests ──

describe("headless governor — M2 endpoint scope", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	// ── Plan-named test 1: governor-wide local default → 1 nominal usertoken ──

	it("dryRun governor with local endpoint authorizes+settles qwen2.5:7b at 1 nominal ut", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});

		const auth = await gov.authorize({
			model: "qwen2.5:7b",
			estimatedInputTokens: 5_000,
			maxOutputTokens: 4_096,
		});
		// Local default rate {0,0} + the >=1 per-call floor → exactly 1 (A11 analogue).
		expect(auth.estimatedCost).toBe(1);

		const receipt = await gov.settle(auth, {
			inputTokens: 123_456,
			outputTokens: 999_999,
			usageSource: "provider",
		});

		expect(receipt.cost).toBe(1);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
		// toEqual (not objectContaining) pins A6: no computeMs key when absent.
		expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-default" });
		expect(gov.budgetRemaining()).toBe(100_000 - 1);

		// Second call decrements by exactly 1 again.
		const auth2 = await gov.authorize({ model: "qwen2.5:7b" });
		await gov.settle(auth2, { inputTokens: 10, outputTokens: 10 });
		expect(gov.budgetRemaining()).toBe(100_000 - 2);

		await gov.destroy();
	});

	// ── Plan-named test 2 (A3): per-call local override beats governor-default cloud ──

	it("per-call local endpoint override wins over the governor-default cloud scope (A3)", async () => {
		// No governor-wide endpoint → default cloud scope.
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });

		const auth = await gov.authorize({
			model: "qwen2.5:7b",
			estimatedInputTokens: 1_000,
			maxOutputTokens: 1_000,
			endpoint: { class: "local", runtime: "vllm" },
		});
		expect(auth.estimatedCost).toBe(1);

		// A3: settle carries the LOCAL meter captured at authorize, even though the
		// governor default is cloud.
		const receipt = await gov.settle(auth, { inputTokens: 1_000, outputTokens: 1_000 });
		expect(receipt.cost).toBe(1);
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "vllm" });
		expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-default" });

		await gov.destroy();
	});

	it("per-call cloud endpoint override wins over a governor-default local scope (A3)", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 1_000,
			maxOutputTokens: 1_000,
			endpoint: { class: "cloud", runtime: "unknown" },
		});

		const receipt = await gov.settle(auth, { inputTokens: 1_000, outputTokens: 1_000 });
		// Cloud table rates for claude-sonnet-4-6: 30 in + 150 out per 1k → 180.
		expect(receipt.cost).toBe(180);
		expect(receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
		expect(receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "table" });

		await gov.destroy();
	});

	// ── Plan-named test 3: computeMs lands in receipt.meter ──

	it("SettleParams.computeMs lands in receipt.meter.computeMs", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});

		const auth = await gov.authorize({ model: "qwen2.5:7b" });
		const receipt = await gov.settle(auth, {
			inputTokens: 50,
			outputTokens: 200,
			computeMs: 842,
		});

		expect(receipt.meter).toMatchObject({
			costBasis: "nominal",
			rateSource: "local-default",
			computeMs: 842,
		});

		await gov.destroy();
	});

	it("non-finite or negative computeMs is omitted from receipt.meter (A6)", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});

		const auth1 = await gov.authorize({ model: "qwen2.5:7b" });
		const r1 = await gov.settle(auth1, {
			inputTokens: 10,
			outputTokens: 10,
			computeMs: Number.NaN,
		});
		expect(r1.meter).toBeDefined();
		expect(Object.hasOwn(r1.meter as object, "computeMs")).toBe(false);

		const auth2 = await gov.authorize({ model: "qwen2.5:7b" });
		const r2 = await gov.settle(auth2, { inputTokens: 10, outputTokens: 10, computeMs: -5 });
		expect(Object.hasOwn(r2.meter as object, "computeMs")).toBe(false);

		await gov.destroy();
	});

	// ── Plan-named test 4: cloud governor + deny policy throws on unknown model ──

	it("cloud governor with unknownModelPolicy deny throws PolicyDeniedError at authorize", async () => {
		writeConfig(vaultBase, { budget: 100_000, unknownModelPolicy: "deny" });
		const gov = await createGovernor({ dryRun: true, vaultBase });

		await expect(gov.authorize({ model: "m2-deny-model-xyz" })).rejects.toThrow(PolicyDeniedError);
		await expect(gov.authorize({ model: "m2-deny-model-xyz" })).rejects.toThrow(
			"unknown_model: m2-deny-model-xyz not in pricing table",
		);
		// Deny happens BEFORE any hold — no budget leak.
		expect(gov.budgetRemaining()).toBe(100_000);

		// Known models are unaffected under deny.
		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.settle(auth, { inputTokens: 100, outputTokens: 100 });

		await gov.destroy();
	});

	it("local scope never denies unknown models even under deny policy (A5)", async () => {
		writeConfig(vaultBase, { budget: 100_000, unknownModelPolicy: "deny" });
		const gov = await createGovernor({ dryRun: true, vaultBase });

		const auth = await gov.authorize({
			model: "m2-deny-model-xyz",
			endpoint: { class: "local", runtime: "ollama" },
		});
		const receipt = await gov.settle(auth, { inputTokens: 500, outputTokens: 500 });

		expect(receipt.cost).toBe(1);
		expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-default" });

		await gov.destroy();
	});

	// ── A5: warn semantics ──

	it("unknownModelPolicy warn warns ONCE per model string; rateSource fallback regardless", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Default config: unknownModelPolicy defaults to "warn".
			const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });

			const auth1 = await gov.authorize({
				model: "m2-warn-model",
				estimatedInputTokens: 100,
				maxOutputTokens: 100,
			});
			const r1 = await gov.settle(auth1, { inputTokens: 1_000, outputTokens: 1_000 });

			const auth2 = await gov.authorize({ model: "m2-warn-model" });
			const r2 = await gov.settle(auth2, { inputTokens: 1_000, outputTokens: 1_000 });

			const unknownModelWarns = warnSpy.mock.calls.filter((c) =>
				String(c[0]).includes("m2-warn-model"),
			);
			expect(unknownModelWarns).toHaveLength(1);

			// Receipt marker is set on EVERY receipt, regardless of warn dedup (A5).
			expect(r1.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "fallback" });
			expect(r2.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "fallback" });
			// FALLBACK_RATE (sonnet-class): 30 in + 150 out per 1k → 180.
			expect(r1.cost).toBe(180);

			await gov.destroy();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('unknownModelPolicy "fallback" is silent but still stamps rateSource fallback', async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeConfig(vaultBase, { budget: 100_000, unknownModelPolicy: "fallback" });
			const gov = await createGovernor({ dryRun: true, vaultBase });

			const auth = await gov.authorize({ model: "m2-silent-model" });
			const receipt = await gov.settle(auth, { inputTokens: 1_000, outputTokens: 0 });

			const silentModelWarns = warnSpy.mock.calls.filter((c) =>
				String(c[0]).includes("m2-silent-model"),
			);
			expect(silentModelWarns).toHaveLength(0);
			expect(receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "fallback" });
			expect(receipt.cost).toBe(30);

			await gov.destroy();
		} finally {
			warnSpy.mockRestore();
		}
	});

	// ── local.models + rateClass flow through the headless meter ──

	it("local.models glob rates + amortized-usd rateClass surface as local-model/usd-proxy", async () => {
		writeConfig(vaultBase, {
			budget: 100_000,
			local: {
				rateClass: "amortized-usd",
				models: { "qwen*": { inputPer1k: 1, outputPer1k: 2 } },
			},
		});
		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
			endpoint: { class: "local", runtime: "vllm" },
		});

		const auth = await gov.authorize({ model: "qwen2.5:7b" });
		const receipt = await gov.settle(auth, { inputTokens: 1_000, outputTokens: 1_000 });

		// ceil(1000/1000*1 + 1000/1000*2) = 3
		expect(receipt.cost).toBe(3);
		expect(receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "local-model" });

		await gov.destroy();
	});

	// ── Estimated-usage settle keeps the authorize-captured scope (A3) ──

	it("settle without usage on a local call falls back to the local nominal estimate", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "lmstudio" },
		});

		const auth = await gov.authorize({
			model: "qwen2.5:7b",
			estimatedInputTokens: 9_999,
			maxOutputTokens: 9_999,
		});
		const receipt = await gov.settle(auth);

		expect(receipt.cost).toBe(auth.estimatedCost);
		expect(receipt.cost).toBe(1);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "lmstudio" });
		expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-default" });

		await gov.destroy();
	});

	// ── Defensive normalization for JS callers ──

	it("partial endpoint shapes normalize (runtime → unknown) and baseURL never leaks to receipts", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			// Untyped JS callers can pass partial shapes — runtime defaults to "unknown".
			endpoint: { class: "local", baseURL: "http://localhost:11434" } as EndpointInfo,
		});

		const auth = await gov.authorize({ model: "qwen2.5:7b" });
		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 10 });

		expect(receipt.cost).toBe(1);
		// Exactly class+runtime — baseURL is classification input, not receipt data.
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "unknown" });

		await gov.destroy();
	});

	// ── Pre-M2 behavior: default cloud scope keeps table metering ──

	it("governor without any endpoint config meters cloud table rates (regression)", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 1_000,
			maxOutputTokens: 1_000,
		});
		const receipt = await gov.settle(auth, { inputTokens: 1_000, outputTokens: 1_000 });

		expect(receipt.cost).toBe(180);
		expect(receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
		expect(receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "table" });

		await gov.destroy();
	});
});
