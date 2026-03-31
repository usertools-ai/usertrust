import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tigerbeetle-node
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
	const dir = join(tmpdir(), `openclaw-index-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ── Tests ──

describe("openclaw plugin entry point", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		// Reset module-level governor state between tests
		const mod = await import("../src/index.js");
		await mod.shutdown();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	describe("register()", () => {
		it("calls api.registerProvider() with a plugin object", async () => {
			const mod = await import("../src/index.js");
			const registerFn = mod.default;

			const registerProviderMock = vi.fn();
			const api = {
				registerTool: vi.fn(),
				registerProvider: registerProviderMock,
				registerChannel: vi.fn(),
				registerHttpRoute: vi.fn(),
			};

			registerFn(api);

			expect(registerProviderMock).toHaveBeenCalledOnce();
			const plugin = registerProviderMock.mock.calls[0][0];
			expect(plugin.id).toBe("usertrust");
			expect(plugin.label).toBe("usertrust Governance");
			expect(typeof plugin.wrapStreamFn).toBe("function");
		});

		it("wrapStreamFn returns a function with the same arity", async () => {
			const mod = await import("../src/index.js");
			const registerFn = mod.default;

			let capturedPlugin: { wrapStreamFn: (fn: unknown, config: unknown) => unknown } | null = null;
			const api = {
				registerTool: vi.fn(),
				registerProvider: vi.fn((p: unknown) => {
					capturedPlugin = p as typeof capturedPlugin;
				}),
				registerChannel: vi.fn(),
				registerHttpRoute: vi.fn(),
			};

			registerFn(api);

			const mockStreamFn = async function* () {
				yield { type: "start" as const };
			};

			const wrapped = capturedPlugin?.wrapStreamFn(mockStreamFn, {
				budget: 100_000,
				dryRun: true,
			});

			expect(typeof wrapped).toBe("function");
		});
	});

	describe("createGovernedStreamFn()", () => {
		it("returns a governed stream function and a governor", async () => {
			const { createGovernedStreamFn } = await import("../src/index.js");

			const events = [
				{ type: "start" as const },
				{ type: "text_delta" as const, text: "hello" },
				{
					type: "done" as const,
					stopReason: "stop" as const,
					usage: { inputTokens: 50, outputTokens: 20 },
				},
			];

			const mockStreamFn = async function* () {
				for (const event of events) {
					yield event;
				}
			};

			const { governedStreamFn, governor } = await createGovernedStreamFn(mockStreamFn, {
				budget: 100_000,
				dryRun: true,
			});

			expect(typeof governedStreamFn).toBe("function");
			expect(governor).toBeDefined();
			expect(governor.budgetRemaining()).toBe(100_000);

			await governor.destroy();
		});
	});

	describe("getGovernor()", () => {
		it("returns null before initialization", async () => {
			// Fresh import — governor not yet initialized
			const mod = await import("../src/index.js");
			// After shutdown in afterEach, governor should be null
			await mod.shutdown();
			const gov = mod.getGovernor();
			expect(gov).toBeNull();
		});

		it("returns governor after createGovernedStreamFn() initializes it", async () => {
			const { createGovernedStreamFn, getGovernor } = await import("../src/index.js");

			const mockStreamFn = async function* () {
				yield { type: "start" as const };
			};

			const { governor } = await createGovernedStreamFn(mockStreamFn, {
				budget: 100_000,
				dryRun: true,
			});

			const got = getGovernor();
			expect(got).not.toBeNull();
			expect(got).toBe(governor);

			await governor.destroy();
		});
	});

	describe("shutdown()", () => {
		it("cleans up governor and sets it to null", async () => {
			const { createGovernedStreamFn, getGovernor, shutdown } = await import("../src/index.js");

			const mockStreamFn = async function* () {
				yield { type: "start" as const };
			};

			await createGovernedStreamFn(mockStreamFn, {
				budget: 100_000,
				dryRun: true,
			});

			expect(getGovernor()).not.toBeNull();

			await shutdown();

			expect(getGovernor()).toBeNull();
		});

		it("is idempotent — multiple calls do not throw", async () => {
			const { shutdown } = await import("../src/index.js");
			await shutdown();
			await shutdown();
			await shutdown();
		});
	});
});
