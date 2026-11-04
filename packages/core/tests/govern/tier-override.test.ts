// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * tier-override.test.ts: the `tier` option overrides the config file's tier, and policy rules that
 * match on `tier` see the tier the host set.
 *
 * `tier` was accepted and ignored: a rule keyed on the tier a host configured never saw it (it saw
 * the config file's tier, "mini" when the file names none), so a deny rule for one tier silently
 * did not fire.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";

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
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const MODEL = "claude-sonnet-4-6";

describe("the tier option", () => {
	let vault: string;

	beforeEach(() => {
		vault = join(tmpdir(), `tier-override-${randomUUID()}`);
		mkdirSync(join(vault, VAULT_DIR, "policies"), { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		rmSync(vault, { recursive: true, force: true });
	});

	/** A vault whose only rule denies every call evaluated at `deniedTier`; the file names `fileTier` (or none). */
	function writeVault(deniedTier: string, fileTier?: string): void {
		writeFileSync(
			join(vault, VAULT_DIR, "policies", "default.yml"),
			JSON.stringify({
				rules: [
					{
						name: `deny-${deniedTier}`,
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "tier", operator: "eq", value: deniedTier }],
					},
				],
			}),
		);
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000,
				policies: "./policies/default.yml",
				...(fileTier !== undefined ? { tier: fileTier } : {}),
			}),
		);
	}

	async function callWith(opts: Record<string, unknown>, params: Record<string, unknown> = {}) {
		const createFn = vi.fn(async (_p: unknown) => ({ id: "msg" }));
		let governed: Awaited<ReturnType<typeof trust<{ messages: { create: typeof createFn } }>>>;
		try {
			governed = await trust({ messages: { create: createFn } }, {
				dryRun: true,
				vaultBase: vault,
				...opts,
			} as never);
		} catch (error) {
			// Refused at construction: no call was made.
			return { error, createFn };
		}
		try {
			await governed.messages.create({
				model: MODEL,
				messages: [{ role: "user", content: "hi" }],
				...params,
			});
			return { error: undefined, createFn };
		} catch (error) {
			return { error, createFn };
		} finally {
			await governed.destroy();
		}
	}

	describe("trust()", () => {
		it("a rule on the tier the host set denies the call, though the file names no tier", async () => {
			writeVault("free");
			const { error, createFn } = await callWith({ tier: "free" });
			expect(error).toBeInstanceOf(PolicyDeniedError);
			expect(createFn).not.toHaveBeenCalled();
		});

		it("the option wins over the file's tier, in both directions", async () => {
			writeVault("free", "pro");
			expect((await callWith({ tier: "free" })).error).toBeInstanceOf(PolicyDeniedError);
			writeVault("free", "free");
			const { error, createFn } = await callWith({ tier: "pro" });
			expect(error).toBeUndefined();
			expect(createFn).toHaveBeenCalledTimes(1);
		});

		it("without the option the file's tier applies, and with neither it is mini", async () => {
			writeVault("pro", "pro");
			expect((await callWith({})).error).toBeInstanceOf(PolicyDeniedError);
			writeVault("mini");
			expect((await callWith({})).error).toBeInstanceOf(PolicyDeniedError);
			writeVault("free");
			expect((await callWith({})).error).toBeUndefined();
		});

		for (const bad of ["enterprise", "Pro", "", " free"]) {
			it(`refuses the tier ${JSON.stringify(bad)} before any call, never falling back to a default`, async () => {
				writeVault("free");
				const { error, createFn } = await callWith({ tier: bad });
				expect(error).toBeDefined();
				expect(error).not.toBeInstanceOf(PolicyDeniedError);
				expect(createFn).not.toHaveBeenCalled();
			});
		}

		it("a call cannot set its own tier: a tier in the request's params is not what rules see", async () => {
			writeVault("ultra", "mini");
			const { error, createFn } = await callWith({}, { tier: "ultra" });
			expect(error).toBeUndefined();
			expect(createFn).toHaveBeenCalledTimes(1);
		});
	});

	describe("governAction()", () => {
		/** One governed action under `opts`; `run` is the caller's own work, reached only when policy allows it. */
		async function actionWith(opts: Record<string, unknown>) {
			const run = vi.fn(async () => "done");
			const governed = await trust({ messages: { create: vi.fn() } }, {
				dryRun: true,
				vaultBase: vault,
				...opts,
			} as never);
			try {
				await governed.governAction(
					{ kind: "tool_use", name: "search", cost: 25, params: {} },
					run,
				);
				return { error: undefined, run };
			} catch (error) {
				return { error, run };
			} finally {
				await governed.destroy();
			}
		}

		it("a rule on the tier the host set denies the action, though the file names no tier", async () => {
			writeVault("free");
			const { error, run } = await actionWith({ tier: "free" });
			expect(error).toBeInstanceOf(PolicyDeniedError);
			expect(run).not.toHaveBeenCalled();
		});

		it("the option wins over the file's tier, in both directions", async () => {
			// The file names the denied tier; the host's tier is another one: allowed.
			writeVault("free", "free");
			const allowed = await actionWith({ tier: "pro" });
			expect(allowed.error).toBeUndefined();
			expect(allowed.run).toHaveBeenCalledTimes(1);
			// The file names another tier; the host's tier is the denied one: denied.
			writeVault("free", "pro");
			const denied = await actionWith({ tier: "free" });
			expect(denied.error).toBeInstanceOf(PolicyDeniedError);
			expect(denied.run).not.toHaveBeenCalled();
		});

		it("without the option the file's tier applies, and with neither it is mini", async () => {
			writeVault("pro", "pro");
			expect((await actionWith({})).error).toBeInstanceOf(PolicyDeniedError);
			writeVault("mini");
			expect((await actionWith({})).error).toBeInstanceOf(PolicyDeniedError);
			writeVault("free");
			expect((await actionWith({})).error).toBeUndefined();
		});
	});

	describe("createGovernor()", () => {
		async function authorizeWith(opts: Record<string, unknown>) {
			const gov = await createGovernor({
				budget: 100_000,
				vaultBase: vault,
				dryRun: true,
				...opts,
			} as never);
			try {
				await gov.authorize({ model: MODEL, estimatedInputTokens: 100, maxOutputTokens: 50 });
				return undefined;
			} catch (error) {
				return error;
			} finally {
				await gov.destroy();
			}
		}

		it("a rule on the tier the host set denies the authorize", async () => {
			writeVault("free");
			expect(await authorizeWith({ tier: "free" })).toBeInstanceOf(PolicyDeniedError);
		});

		it("the option wins over the file's tier", async () => {
			writeVault("free", "free");
			expect(await authorizeWith({ tier: "pro" })).toBeUndefined();
		});

		it("an unknown tier is refused at construction", async () => {
			writeVault("free");
			await expect(
				createGovernor({
					budget: 100_000,
					vaultBase: vault,
					dryRun: true,
					tier: "enterprise",
				} as never),
			).rejects.toThrow();
		});
	});
});
