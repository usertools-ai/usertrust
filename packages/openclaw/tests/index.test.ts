import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "../src/types.js";
import {
	doneEvent,
	makeContext,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
	textDelta,
} from "./host-fixtures.js";

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
			const api: OpenClawPluginApi = {
				id: "usertrust",
				name: "usertrust",
				pluginConfig: { budget: 100_000, dryRun: true },
				registerProvider: registerProviderMock,
			};

			registerFn(api);

			expect(registerProviderMock).toHaveBeenCalledOnce();
			const plugin = registerProviderMock.mock.calls[0]?.[0] as ProviderPlugin;
			expect(plugin.id).toBe("usertrust");
			expect(plugin.label).toBe("usertrust Governance");
			expect(typeof plugin.wrapStreamFn).toBe("function");
		});

		it("wrapStreamFn returns a stream function from the hook context", async () => {
			const mod = await import("../src/index.js");
			const registerFn = mod.default;

			let capturedPlugin: ProviderPlugin | null = null;
			const api: OpenClawPluginApi = {
				id: "usertrust",
				name: "usertrust",
				pluginConfig: { budget: 100_000, dryRun: true },
				registerProvider: (p) => {
					capturedPlugin = p;
				},
			};

			registerFn(api);

			const wrapped = capturedPlugin?.wrapStreamFn?.({
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				streamFn: streamOf([startEvent()]),
			});

			expect(typeof wrapped).toBe("function");
		});
	});

	describe("createGovernedStreamFn()", () => {
		it("returns a governed stream function and a governor", async () => {
			const { createGovernedStreamFn } = await import("../src/index.js");

			const { governedStreamFn, governor } = await createGovernedStreamFn(
				streamOf([startEvent(), doneEvent(makeUsage(50, 20))]),
				{
					budget: 100_000,
					dryRun: true,
				},
			);

			expect(typeof governedStreamFn).toBe("function");
			expect(governor).toBeDefined();
			expect(governor.budgetRemaining()).toBeGreaterThan(0);

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

			const mockStreamFn = streamOf([startEvent()]);

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

			const mockStreamFn = streamOf([startEvent()]);

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

	describe("initGovernor early return", () => {
		it("returns existing governor on second createGovernedStreamFn call with the SAME config", async () => {
			const { createGovernedStreamFn, getGovernor } = await import("../src/index.js");

			const mockStreamFn = streamOf([startEvent()]);
			const config = { budget: 100_000, dryRun: true };

			// First call initializes
			const { governor: gov1 } = await createGovernedStreamFn(mockStreamFn, config);

			// Second call, SAME config, should return the same governor — a
			// DIFFERENT config now rejects instead of silently reusing the first
			// instance's governor (Task 4, `tests/cost-centers-config.test.ts`'s
			// "governor config-mismatch guard" suite).
			const { governor: gov2 } = await createGovernedStreamFn(mockStreamFn, config);

			expect(gov1).toBe(gov2);
			expect(getGovernor()).toBe(gov1);

			await gov1.destroy();
		});
	});

	describe("wrapStreamFn end-to-end", () => {
		it("governed stream from wrapStreamFn yields all events", async () => {
			const mod = await import("../src/index.js");
			const registerFn = mod.default;

			let capturedPlugin: ProviderPlugin | null = null;
			const api: OpenClawPluginApi = {
				id: "usertrust",
				name: "usertrust",
				pluginConfig: { budget: 100_000, dryRun: true },
				registerProvider: (p) => {
					capturedPlugin = p;
				},
			};

			registerFn(api);

			const wrapped = capturedPlugin?.wrapStreamFn?.({
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				streamFn: streamOf([startEvent(), textDelta("hello"), doneEvent(makeUsage(50, 20))]),
			});

			expect(wrapped).toBeTypeOf("function");
			// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
			const stream = await wrapped!(makeModel(), makeContext());

			const collected: unknown[] = [];
			for await (const event of stream) {
				collected.push(event);
			}

			expect(collected).toHaveLength(3);
		});
	});
});
