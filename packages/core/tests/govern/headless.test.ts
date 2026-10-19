import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLockReleaseError, type AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, type TrustOpts, trust } from "../../src/govern.js";
import type { Governor } from "../../src/headless.js";
import { createGovernor } from "../../src/headless.js";
import { costFromRates, getModelRates } from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

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
	const dir = join(tmpdir(), `headless-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mockEngine(): TrustEngine & {
	pendingIds: string[];
	postedIds: string[];
	voidedIds: string[];
} {
	const pendingIds: string[] = [];
	const postedIds: string[] = [];
	const voidedIds: string[] = [];

	return {
		pendingIds,
		postedIds,
		voidedIds,
		async spendPending(params) {
			pendingIds.push(params.transferId);
			return { transferId: params.transferId };
		},
		async postPendingSpend(transferId) {
			postedIds.push(transferId);
		},
		async voidPendingSpend(transferId) {
			voidedIds.push(transferId);
		},
		async voidAllPending() {
			// no-op for tests
		},
		destroy() {},
	};
}

// ── Tests ──

describe("headless governor", () => {
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

	it("creates a governor in dry-run mode", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		expect(gov).toBeDefined();
		expect(gov.config.budget).toBe(100_000);
		expect(gov.budgetRemaining()).toBe(100_000);
		await gov.destroy();
	});

	it("authorize → settle lifecycle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		expect(auth.transferId).toMatch(/^tx_/);
		expect(auth.model).toBe("claude-sonnet-4-6");
		expect(auth.estimatedCost).toBeGreaterThan(0);

		// Budget should reflect in-flight hold
		expect(gov.budgetRemaining()).toBeLessThan(100_000);

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
			usageSource: "provider",
			chunksDelivered: 15,
		});

		expect(receipt.settled).toBe(true);
		expect(receipt.model).toBe("claude-sonnet-4-6");
		expect(receipt.provider).toBe("headless");
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.chunksDelivered).toBe(15);
		expect(receipt.cost).toBeGreaterThan(0);
		expect(receipt.budgetRemaining).toBeLessThan(100_000);

		await gov.destroy();
	});

	it("authorize → abort lifecycle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "gpt-4o",
			estimatedInputTokens: 200,
			maxOutputTokens: 1000,
		});

		const budgetAfterAuth = gov.budgetRemaining();
		expect(budgetAfterAuth).toBeLessThan(100_000);

		await gov.abort(auth, new Error("LLM failed"));

		// Budget should be restored after abort
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	it("settle without usage falls back to estimate", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		// Settle without providing actual usage
		const receipt = await gov.settle(auth);

		// Review fix (round 1, spec D3): `auth.estimatedCost` is the
		// write-premium-INFLATED hold (claude-sonnet-4-6 has a cache-write
		// premium), which is deliberately fatter than plain
		// `inputPer1k`-priced usage. The settle-time "no usage reported"
		// fallback must charge the UN-INFLATED metering estimate, never the
		// hold, so `receipt.cost` is strictly LESS than `auth.estimatedCost`
		// here, not equal to it.
		expect(receipt.cost).toBeLessThan(auth.estimatedCost);
		expect(receipt.cost).toBe(costFromRates(getModelRates("claude-sonnet-4-6"), 100, 500));
		expect(receipt.usageSource).toBe("estimated");

		await gov.destroy();
	});

	it("prevents double-settle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.settle(auth);

		await expect(gov.settle(auth)).rejects.toThrow("not active");

		await gov.destroy();
	});

	it("abort is idempotent", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.abort(auth, new Error("first abort"));
		// Second abort should not throw
		await gov.abort(auth, new Error("second abort"));

		await gov.destroy();
	});

	it("uses mock engine in test mode", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
			maxOutputTokens: 200,
		});

		expect(engine.pendingIds).toHaveLength(1);
		expect(engine.pendingIds[0]).toBe(auth.transferId);

		await gov.settle(auth, {
			inputTokens: 40,
			outputTokens: 100,
		});

		expect(engine.postedIds).toHaveLength(1);
		expect(engine.postedIds[0]).toBe(auth.transferId);

		await gov.destroy();
	});

	it("voids pending hold via engine on abort", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		const auth = await gov.authorize({ model: "gpt-4o" });
		await gov.abort(auth, new Error("test error"));

		expect(engine.voidedIds).toHaveLength(1);
		expect(engine.voidedIds[0]).toBe(auth.transferId);

		await gov.destroy();
	});

	it("tracks budget across multiple calls", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		// First call
		const auth1 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 200,
		});
		await gov.settle(auth1, { inputTokens: 100, outputTokens: 200 });

		const afterFirst = gov.budgetRemaining();
		expect(afterFirst).toBeLessThan(100_000);

		// Second call
		const auth2 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 200,
		});
		await gov.settle(auth2, { inputTokens: 100, outputTokens: 200 });

		const afterSecond = gov.budgetRemaining();
		expect(afterSecond).toBeLessThan(afterFirst);

		await gov.destroy();
	});

	it("estimateCost and estimateInputTokens work", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const cost = gov.estimateCost("claude-sonnet-4-6", 1000, 500);
		expect(cost).toBeGreaterThan(0);

		const tokens = gov.estimateInputTokens([{ role: "user", content: "Hello world" }]);
		expect(tokens).toBeGreaterThan(0);

		await gov.destroy();
	});

	it("throws after destroy", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		await gov.destroy();

		await expect(gov.authorize({ model: "test" })).rejects.toThrow("destroyed");
	});

	it("destroy voids active authorizations", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		// Authorize but don't settle
		await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.authorize({ model: "gpt-4o" });

		expect(engine.pendingIds).toHaveLength(2);

		await gov.destroy();

		// Both should be voided
		expect(engine.voidedIds).toHaveLength(2);
	});

	// ── Proxy mode removed ──

	it("createGovernor throws when proxy is set", async () => {
		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
				key: "test-key",
			}),
		).rejects.toThrow("proxy mode is not yet implemented");
	});

	it("createGovernor throws the proxy-removal error when proxy is set", async () => {
		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
			}),
		).rejects.toThrow("proxy mode is not yet implemented");
	});

	it("createGovernor error suggests dryRun when proxy is set", async () => {
		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
			}),
		).rejects.toThrow("dryRun");
	});

	it("a lock left behind: destroy() RESOLVES, still destroys the engine, and reports it as a USERTRUST_AUDIT_LOCK_LEFT warning — none when release succeeds", async () => {
		const LEFT = "/vaults/a/.usertrust/audit/.audit-writer.lock";
		const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const fails of [true, false]) {
				emitWarning.mockClear();
				const mockAudit: AuditWriter = {
					appendEvent: vi.fn(),
					getWriteFailures: () => 0,
					isDegraded: () => false,
					flush: async () => {},
					release: () => {
						if (fails) {
							throw new AuditLockReleaseError([
								{ path: LEFT, error: Object.assign(new Error("EIO: i/o error"), { code: "EIO" }) },
							]);
						}
					},
				};
				const engine = mockEngine();
				const engineDestroy = vi.spyOn(engine, "destroy");
				const gov = await createGovernor({
					budget: 100_000,
					vaultBase,
					_engine: engine,
					_audit: mockAudit,
				});

				await expect(gov.destroy()).resolves.toBeUndefined();
				expect(engineDestroy).toHaveBeenCalledOnce();
				if (fails) {
					expect(emitWarning).toHaveBeenCalledWith(
						expect.stringContaining(LEFT),
						expect.objectContaining({ code: "USERTRUST_AUDIT_LOCK_LEFT" }),
					);
				} else {
					expect(emitWarning, "control: no warning").not.toHaveBeenCalled();
				}
			}
		} finally {
			emitWarning.mockRestore();
			warn.mockRestore();
		}
	});

	// ── Engine POST failure in settle() ──

	it("settle sets settled=false and writes settlement_ambiguous on engine POST failure", async () => {
		const auditEvents: { kind: string }[] = [];
		const mockAudit: AuditWriter = {
			appendEvent: vi.fn(async (input) => {
				auditEvents.push({ kind: input.kind });
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
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const failingEngine: TrustEngine = {
			async spendPending(params) {
				return { transferId: params.transferId };
			},
			async postPendingSpend(_transferId) {
				throw new Error("TigerBeetle POST failed");
			},
			async voidPendingSpend() {},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
			_audit: mockAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		expect(receipt.settled).toBe(false);
		expect(auditEvents.some((e) => e.kind === "settlement_ambiguous")).toBe(true);

		await gov.destroy();
	});

	// ── Engine VOID failure in abort() ──

	it("abort completes even when engine voidPendingSpend throws (best-effort)", async () => {
		const failingEngine: TrustEngine = {
			async spendPending(params) {
				return { transferId: params.transferId };
			},
			async postPendingSpend() {},
			async voidPendingSpend() {
				throw new Error("VOID failed");
			},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
		});

		const auth = await gov.authorize({ model: "gpt-4o" });

		// Should NOT throw even though void fails
		await gov.abort(auth, new Error("LLM error"));

		// Budget should still be restored
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	// ── Audit degraded path ──

	it("settle returns auditDegraded=true when audit.appendEvent throws", async () => {
		let appendCallCount = 0;
		const degradedAudit: AuditWriter = {
			appendEvent: vi.fn(async (input) => {
				appendCallCount++;
				// Let the settlement_ambiguous audit through but fail on the main llm_call audit
				if (input.kind === "llm_call") {
					throw new Error("Disk full");
				}
				return {
					id: randomUUID(),
					timestamp: new Date().toISOString(),
					previousHash: "0".repeat(64),
					hash: "b".repeat(64),
					kind: input.kind,
					actor: input.actor,
					data: input.data,
				};
			}),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			_audit: degradedAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
		});

		const receipt = await gov.settle(auth);

		expect(receipt.auditDegraded).toBe(true);
		expect(appendCallCount).toBeGreaterThan(0);

		await gov.destroy();
	});

	// ── Audit degraded in settle() POST failure path ──

	it("settle returns auditDegraded=true when settlement_ambiguous audit also throws", async () => {
		const degradedAudit: AuditWriter = {
			appendEvent: vi.fn(async () => {
				throw new Error("All writes fail");
			}),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const failingEngine: TrustEngine = {
			async spendPending(params) {
				return { transferId: params.transferId };
			},
			async postPendingSpend() {
				throw new Error("POST failed");
			},
			async voidPendingSpend() {},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
			_audit: degradedAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
		});

		const receipt = await gov.settle(auth);

		expect(receipt.settled).toBe(false);
		expect(receipt.auditDegraded).toBe(true);

		await gov.destroy();
	});

	// ── Pattern memory recording ──

	it("recordPattern is called on settle when patterns are enabled", async () => {
		// Spy on the actual recordPattern function
		const patterns = await import("../../src/memory/patterns.js");
		const spy = vi.spyOn(patterns, "recordPattern").mockResolvedValue(undefined);

		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		// Verify config has patterns enabled (default)
		expect(gov.config.patterns.enabled).toBe(true);

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		expect(spy).toHaveBeenCalledOnce();
		// Into this governor's vault, never a `.usertrust/` relative to the working directory.
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-sonnet-4-6",
				success: true,
			}),
			join(vaultBase, VAULT_DIR),
		);

		spy.mockRestore();
		await gov.destroy();
	});

	// ── PII detection blocking ──

	it("authorize throws PolicyDeniedError when PII detected in block mode", async () => {
		// Create a config file with pii: "block"
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				pii: "block",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		expect(gov.config.pii).toBe("block");

		await expect(
			gov.authorize({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "My email is test@example.com" }],
			}),
		).rejects.toThrow("PII detected");

		await gov.destroy();
	});

	// The `pii` option overrides the config file in createGovernor() exactly as in
	// trust(): the two build their config with one shared override list.
	it('{ pii: "block" } blocks over a config file of warn, before any hold', async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({ budget: 100_000, pii: "warn" }),
		);
		const engine = mockEngine();

		const gov = await createGovernor({ _engine: engine, vaultBase, pii: "block" });

		expect(gov.config.pii).toBe("block");
		await expect(
			gov.authorize({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Charge my card 4111 1111 1111 1111 please" }],
			}),
		).rejects.toThrow(/PII detected: .*credit_card/);
		expect(engine.pendingIds).toHaveLength(0);

		await gov.destroy();
	});

	it('{ pii: "warn" } over a config file of block authorizes', async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({ budget: 100_000, pii: "block" }),
		);

		const gov = await createGovernor({ dryRun: true, vaultBase, pii: "warn" });

		expect(gov.config.pii).toBe("warn");
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Charge my card 4111 1111 1111 1111 please" }],
		});
		expect(auth.transferId).toMatch(/^tx_/);

		await gov.settle(auth);
		await gov.destroy();
	});

	it("refuses an option it does not read, by name, before the vault is created", async () => {
		// `as never`: a JavaScript caller has no type check; this models one.
		await expect(
			createGovernor({
				dryRun: true,
				vaultBase,
				circuitBreaker: { failureThreshold: 1, resetTimeout: 1 },
			} as never),
		).rejects.toThrow(
			'createGovernor(): unknown option "circuitBreaker" (set it in .usertrust/usertrust.config.json)',
		);
		await expect(createGovernor({ dryRun: true, vaultBase, pi: "block" } as never)).rejects.toThrow(
			'createGovernor(): unknown option "pi"',
		);
		await expect(createGovernor({ dryRun: true, vaultBase, pii: "blok" } as never)).rejects.toThrow(
			'createGovernor(): invalid option pii "blok"',
		);
		expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
	});

	it("refuses an own option a getter removed while the options were read (never the inherited value)", async () => {
		const options = Object.create({ pii: "off" }) as Record<string, unknown>;
		Object.defineProperty(options, "dryRun", {
			enumerable: true,
			get() {
				delete options.pii;
				return true;
			},
		});
		options.vaultBase = vaultBase;
		options.pii = "block";
		await expect(createGovernor(options as never)).rejects.toThrow(
			'createGovernor(): option "pii" was removed while the options were being read',
		);
		expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
	});

	// `allowUngoverned` opts SDK methods out of a wrapped client's default-deny boundary; a
	// governor wraps no client, so createGovernor() refuses it by name. GovernorOpts does not
	// offer it, but a value typed as TrustOpts still carries it past the type check.
	const TRUST_ONLY_REFUSAL =
		'createGovernor(): option "allowUngoverned" applies to trust()-wrapped clients only';

	it("refuses allowUngoverned by name, before anything is created", async () => {
		await expect(
			createGovernor({
				dryRun: true,
				vaultBase,
				// @ts-expect-error GovernorOpts does not offer allowUngoverned
				allowUngoverned: ["embeddings.create"],
			}),
		).rejects.toThrow(TRUST_ONLY_REFUSAL);
		expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
	});

	it("refuses allowUngoverned passed through a value typed as TrustOpts (the type check misses it)", async () => {
		const asTrustOpts: TrustOpts = {
			dryRun: true,
			vaultBase,
			allowUngoverned: ["embeddings.create"],
		};
		await expect(createGovernor(asTrustOpts)).rejects.toThrow(TRUST_ONLY_REFUSAL);
		expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
	});

	it("does not list allowUngoverned among the options createGovernor() accepts", async () => {
		const err = await createGovernor({ dryRun: true, vaultBase, pi: "block" } as never).then(
			() => undefined,
			(e: unknown) => e,
		);
		const accepts = /accepts only: (.*)\.$/.exec((err as Error).message)?.[1];
		expect(accepts).toBe(
			"budget, configPath, dryRun, endpoint, parentUserId, pii, scope, vaultBase",
		);
	});

	it("trust() still accepts allowUngoverned", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn(async (_params: unknown) => ({ id: "msg" })) } },
			{ dryRun: true, vaultBase, allowUngoverned: ["embeddings.create"] },
		);
		await governed.destroy();
	});

	// Only an omitted (undefined) argument means "no options"; cwd points at the temp
	// vault so a regression builds its vault where the assertion sees it.
	it("refuses null options by name, before anything is created", async () => {
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(vaultBase);
		try {
			await expect(createGovernor(null as never)).rejects.toThrow(
				"createGovernor(): options must be an object, got null",
			);
			expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
		} finally {
			cwd.mockRestore();
		}
	});

	it("still treats an undefined options argument as none", async () => {
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(vaultBase);
		vi.stubEnv("USERTRUST_DRY_RUN", "true");
		try {
			const gov = await createGovernor(undefined);
			expect(gov.config.pii).toBe("warn");
			expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(true);
			await gov.destroy();
		} finally {
			vi.unstubAllEnvs();
			cwd.mockRestore();
		}
	});

	it("refuses an inherited pii by name instead of applying it (own properties only)", async () => {
		const options = Object.create({ pii: "block" }) as Record<string, unknown>;
		options.dryRun = true;
		options.vaultBase = vaultBase;
		await expect(createGovernor(options as never)).rejects.toThrow(
			'createGovernor(): option "pii" is inherited from the options object\'s prototype',
		);
		expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
	});

	it("accepts a plain options object from another realm, and applies its pii", async () => {
		const engine = mockEngine();
		const options = runInNewContext('({ vaultBase: v, pii: "block", _engine: e })', {
			v: vaultBase,
			e: engine,
		}) as object;
		expect(Object.getPrototypeOf(options)).not.toBe(Object.prototype);
		const gov = await createGovernor(options as never);
		expect(gov.config.pii).toBe("block");
		await expect(
			gov.authorize({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Charge my card 4111 1111 1111 1111 please" }],
			}),
		).rejects.toThrow(/PII detected: .*credit_card/);
		expect(engine.pendingIds).toHaveLength(0);
		await gov.destroy();
	});

	it("still refuses an option inherited from a custom prototype made in another realm", async () => {
		const options = runInNewContext(
			'Object.assign(Object.create({ pii: "block" }), { dryRun: true, vaultBase: v })',
			{ v: vaultBase },
		) as object;
		await expect(createGovernor(options as never)).rejects.toThrow(
			'createGovernor(): option "pii" is inherited',
		);
		expect(existsSync(join(vaultBase, VAULT_DIR))).toBe(false);
	});

	// ── D8 migration warning ──

	it(
		"warns on stderr once when customRates omits cache fields the table publishes " +
			"(createGovernor is a config-load path warnCacheRateMigration is wired into)",
		async () => {
			const configDir = join(vaultBase, VAULT_DIR);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "usertrust.config.json"),
				JSON.stringify({
					budget: 100_000,
					pricing: "custom",
					// claude-opus-4-6 publishes cacheReadPer1k/cacheWritePer1k in
					// PRICING_TABLE; this entry, pre-D1 shaped, omits both.
					customRates: { "claude-opus-4-6": { inputPer1k: 50, outputPer1k: 250 } },
				}),
			);

			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const gov = await createGovernor({ dryRun: true, vaultBase });

			const migrationCalls = stderrSpy.mock.calls.filter((call) =>
				String(call[0]).includes("cache reads will price at full input rate"),
			);
			expect(migrationCalls).toHaveLength(1);
			expect(String(migrationCalls[0]?.[0])).toContain("claude-opus-4-6");

			stderrSpy.mockRestore();
			await gov.destroy();
		},
	);

	// ── Policy denial ──

	it("authorize throws PolicyDeniedError when budget is exhausted", async () => {
		// Create a config with policy rules that deny when budget_remaining < estimated_cost
		const configDir = join(vaultBase, VAULT_DIR);
		const policiesDir = join(configDir, "policies");
		mkdirSync(policiesDir, { recursive: true });
		writeFileSync(
			join(policiesDir, "default.yml"),
			`- name: budget_exhausted
  effect: deny
  enforcement: hard
  conditions:
    - field: budget_remaining
      operator: lte
      value: 0
`,
		);
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 1,
				policies: "./policies/default.yml",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
		});

		// STRENGTHENED (harden/core-promises): DEFAULT_RULES are now ALWAYS merged
		// (mergePolicies), so a call whose estimated cost would overshoot the
		// 1-usertoken budget is denied PRE-spend by block-budget-overshoot
		// (budget_remaining_after < 0) — earlier and stronger than the prior
		// post-settle denial. The custom budget_exhausted rule from the policies
		// file is concatenated on top and remains active.
		await expect(
			gov.authorize({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 100,
				maxOutputTokens: 500,
			}),
		).rejects.toThrow("Policy denied");

		await gov.destroy();
	});

	// ── Budget persistence ──

	it("persist spend-ledger.json after settle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		await gov.settle(auth, { inputTokens: 100, outputTokens: 500 });

		const ledgerPath = join(vaultBase, VAULT_DIR, "spend-ledger.json");
		expect(existsSync(ledgerPath)).toBe(true);

		const ledgerData = JSON.parse(readFileSync(ledgerPath, "utf-8"));
		expect(ledgerData.budgetSpent).toBeGreaterThan(0);
		expect(typeof ledgerData.updatedAt).toBe("string");

		await gov.destroy();
	});

	// ── Destroyed governor ──

	it("settle throws after governor is destroyed", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.destroy();

		// settle should throw because auth was voided during destroy, and say why
		await expect(gov.settle(auth)).rejects.toThrow("Governor has been destroyed");
	});

	it("abort is no-op after governor is destroyed", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.destroy();

		// abort should be idempotent (auth was voided during destroy): it ended nothing
		expect(await gov.abort(auth, new Error("test"))).toEqual({ aborted: false });
	});

	// ── Config loading from file ──

	it("loads config from file when configPath is provided", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });

		const configFile = join(configDir, "custom-config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				budget: 75_000,
				tier: "pro",
				pii: "off",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
			configPath: configFile,
		});

		expect(gov.config.budget).toBe(75_000);
		expect(gov.config.tier).toBe("pro");
		expect(gov.config.pii).toBe("off");
		expect(gov.budgetRemaining()).toBe(75_000);

		await gov.destroy();
	});

	it("config file budget can be overridden by opts.budget", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });

		const configFile = join(configDir, "usertrust.config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				budget: 50_000,
				tier: "pro",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			budget: 200_000,
			vaultBase,
		});

		expect(gov.config.budget).toBe(200_000);
		expect(gov.config.tier).toBe("pro");

		await gov.destroy();
	});

	// ── Proxy settle failure branch removed ──

	it("createGovernor rejects proxy option", async () => {
		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
			}),
		).rejects.toThrow("proxy mode is not yet implemented");
	});

	// ── PII in warn mode (non-blocking branch) ──

	it("authorize succeeds when PII detected in warn mode", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				pii: "warn",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
		});

		// warn mode should NOT throw — just continue
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "My email is test@example.com" }],
		});

		expect(auth.transferId).toMatch(/^tx_/);

		await gov.settle(auth);
		await gov.destroy();
	});

	// ── Authorize with no messages (skip PII check) ──

	it("authorize skips PII check when no messages provided", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
		});

		expect(auth.transferId).toMatch(/^tx_/);

		await gov.settle(auth);
		await gov.destroy();
	});

	// ── Settle with only outputTokens (partial usage branch) ──

	it("settle with only outputTokens provided is an incomplete report, labelled estimated", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });

		const receipt = await gov.settle(auth, {
			outputTokens: 500,
		});

		expect(receipt.cost).toBeGreaterThan(0);
		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);

		await gov.destroy();
	});

	// ── Audit rotation none mode ──

	it("skips receipt rotation when audit.rotation is none", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				audit: { rotation: "none" },
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
		});

		expect(gov.config.audit.rotation).toBe("none");

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		const receipt = await gov.settle(auth);

		expect(receipt.settled).toBe(true);

		await gov.destroy();
	});

	// ── Engine spendPending failure ──

	it("authorize throws LedgerUnavailableError when engine.spendPending fails", async () => {
		const failingEngine: TrustEngine = {
			async spendPending() {
				throw new Error("TB connection refused");
			},
			async postPendingSpend() {},
			async voidPendingSpend() {},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
		});

		await expect(gov.authorize({ model: "claude-sonnet-4-6" })).rejects.toThrow(
			"Ledger unavailable",
		);

		await gov.destroy();
	});

	// ── Engine spendPending failure with non-Error thrown ──

	it("authorize wraps non-Error from engine.spendPending", async () => {
		const failingEngine: TrustEngine = {
			async spendPending() {
				throw "string error";
			},
			async postPendingSpend() {},
			async voidPendingSpend() {},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
		});

		await expect(gov.authorize({ model: "claude-sonnet-4-6" })).rejects.toThrow("string error");

		await gov.destroy();
	});

	// ── Teardown: every step is attempted, whatever an earlier one does ──

	function teardownAudit(release: () => void): AuditWriter {
		return {
			appendEvent: vi.fn(async (input) => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			})),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: vi.fn(release),
		};
	}

	it("destroy: a throwing engine destroy still rejects with the engine's own error", async () => {
		const engineErr = new Error("engine destroy failed");
		const engine = mockEngine();
		const engineDestroy = vi.fn(() => {
			throw engineErr;
		});
		engine.destroy = engineDestroy;
		const audit = teardownAudit(() => {});

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		await expect(gov.destroy()).rejects.toBe(engineErr);
		expect(audit.release).toHaveBeenCalledOnce();
		expect(engineDestroy).toHaveBeenCalledOnce();
	});

	it("destroy control: no step throws, it resolves and each step runs exactly once", async () => {
		const engine = mockEngine();
		const engineDestroy = vi.fn();
		engine.destroy = engineDestroy;
		const audit = teardownAudit(() => {});

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		await expect(gov.destroy()).resolves.toBeUndefined();
		expect(audit.release).toHaveBeenCalledOnce();
		expect(engineDestroy).toHaveBeenCalledOnce();
	});

	// The drain, the engine sweep and the flush are teardown steps too: a throw from any of
	// them must not leave the TigerBeetle client open (the process would hang on it) or the
	// audit lock held. One hold is left active so the drain has a hold to void and record.
	async function governorForTeardown(
		fail: { drain?: unknown; voidAll?: unknown; flush?: unknown; release?: unknown } = {},
	) {
		const calls: string[] = [];
		const engine = mockEngine();
		const voidPendingSpend = engine.voidPendingSpend.bind(engine);
		engine.voidPendingSpend = async (transferId) => {
			calls.push("voidPendingSpend");
			await voidPendingSpend(transferId);
		};
		engine.voidAllPending = async () => {
			calls.push("voidAllPending");
			if (fail.voidAll !== undefined) throw fail.voidAll;
		};
		const engineDestroy = vi.fn(() => {
			calls.push("engine.destroy");
		});
		engine.destroy = engineDestroy;
		const audit = teardownAudit(() => {
			calls.push("release");
			if (fail.release !== undefined) throw fail.release;
		});
		const append = audit.appendEvent;
		// Synchronous on purpose: a throw here is one the drain's own `.catch` cannot see.
		audit.appendEvent = (input) => {
			if (input.kind === "hold_released") {
				calls.push("hold_released");
				if (fail.drain !== undefined) throw fail.drain;
			}
			return append(input);
		};
		audit.flush = vi.fn(async () => {
			calls.push("flush");
			if (fail.flush !== undefined) throw fail.flush;
		});
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});
		await gov.authorize({ model: "claude-sonnet-4-6" });
		return { gov, engine, engineDestroy, audit, calls };
	}

	it("destroy: an engine with close(): the teardown AWAITS it as its ledger step, after the voids, the flush and the lock release, and never calls the sync destroy()", async () => {
		const { gov, engine, engineDestroy, calls } = await governorForTeardown();
		let finishClose: () => void = () => {};
		engine.close = vi.fn(() => {
			calls.push("engine.close");
			return new Promise<void>((resolve) => {
				finishClose = resolve;
			});
		});
		let done = false;
		const destroying = gov.destroy().then(() => {
			done = true;
		});
		await vi.waitFor(() => expect(calls).toContain("engine.close"));
		await new Promise((r) => setImmediate(r));
		expect(done).toBe(false);
		finishClose();
		await destroying;
		expect(calls).toEqual([
			"voidPendingSpend",
			"hold_released",
			"voidAllPending",
			"flush",
			"release",
			"engine.close",
		]);
		expect(engine.close).toHaveBeenCalledOnce();
		expect(engineDestroy).not.toHaveBeenCalled();
	});

	it("destroy: a throwing voidAllPending is still swallowed (unchanged), and every later step runs", async () => {
		const { gov, engineDestroy, audit } = await governorForTeardown({
			voidAll: new Error("voidAllPending failed"),
		});

		await expect(gov.destroy()).resolves.toBeUndefined();
		expect(audit.flush).toHaveBeenCalledOnce();
		expect(audit.release).toHaveBeenCalledOnce();
		expect(engineDestroy).toHaveBeenCalledOnce();
	});

	it("destroy: a throwing flush still releases the lock and destroys the engine, then rejects with its error", async () => {
		const flushErr = new Error("flush failed");
		const { gov, engineDestroy, audit } = await governorForTeardown({ flush: flushErr });

		await expect(gov.destroy()).rejects.toBe(flushErr);
		expect(audit.release).toHaveBeenCalledOnce();
		expect(engineDestroy).toHaveBeenCalledOnce();
	});

	it("destroy: a throw from the drain still sweeps, flushes, releases and destroys the engine, then rejects with it", async () => {
		const drainErr = new Error("drain failed");
		const { gov, engineDestroy, audit, calls } = await governorForTeardown({ drain: drainErr });

		await expect(gov.destroy()).rejects.toBe(drainErr);
		expect(calls).toContain("voidAllPending");
		expect(audit.flush).toHaveBeenCalledOnce();
		expect(audit.release).toHaveBeenCalledOnce();
		expect(engineDestroy).toHaveBeenCalledOnce();
	});

	it("destroy: a throwing drain and flush reject with ONE AggregateError, in step order", async () => {
		const drainErr = new Error("drain failed");
		const flushErr = new Error("flush failed");
		const { gov, engineDestroy } = await governorForTeardown({ drain: drainErr, flush: flushErr });

		const err = await gov.destroy().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AggregateError);
		expect((err as AggregateError).errors).toEqual([drainErr, flushErr]);
		expect((err as AggregateError).errors[0]).toBe(drainErr);
		expect((err as AggregateError).errors[1]).toBe(flushErr);
		expect(engineDestroy).toHaveBeenCalledOnce();
	});

	it("destroy: a lock left behind adds no rejection: a throwing flush rejects with its error alone", async () => {
		const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const flushErr = new Error("flush failed");
			const { gov, engineDestroy } = await governorForTeardown({
				flush: flushErr,
				release: new Error("lock left behind"),
			});

			await expect(gov.destroy()).rejects.toBe(flushErr);
			expect(engineDestroy).toHaveBeenCalledOnce();
			expect(emitWarning).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ code: "USERTRUST_AUDIT_LOCK_LEFT" }),
			);
		} finally {
			emitWarning.mockRestore();
			warn.mockRestore();
		}
	});

	it("destroy control: nothing throws, it resolves and runs every step once, in order", async () => {
		const { gov, calls } = await governorForTeardown();

		await expect(gov.destroy()).resolves.toBeUndefined();
		expect(calls).toEqual([
			"voidPendingSpend",
			"hold_released",
			"voidAllPending",
			"flush",
			"release",
			"engine.destroy",
		]);
	});
});
