// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * endpoint-scope.test.ts — F1: UsertrustPluginConfig.endpoint threading.
 *
 * The headless/OpenClaw path has no client baseURL to classify, so the operator
 * must declare the endpoint scope on the plugin config. This verifies the
 * declaration reaches the headless governor: a declared local endpoint meters a
 * "llama3.3:70b" call at the 1 nominal-usertoken local floor, while the absence
 * of a declaration preserves cloud scope (frontier fallback pricing + the
 * once-per-model unknown-model warning).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, StreamFn } from "../src/types.js";
import {
	doneEvent,
	makeContext,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
	textDelta,
} from "./host-fixtures.js";

// Mock tigerbeetle-node (native module; dry-run never touches it, keep hermetic)
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

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openclaw-endpoint-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A host stream that reports 26 input / 298 output tokens on its done event. */
function llamaStream(): StreamFn {
	return streamOf([startEvent(), textDelta("hello world"), doneEvent(makeUsage(26, 298))]);
}

const MODEL = makeModel("llama3.3:70b");
const CONTEXT: Context = makeContext();

const BUDGET = 100_000;

describe("UsertrustPluginConfig.endpoint threading (F1)", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		const mod = await import("../src/index.js");
		await mod.shutdown();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("a declared local endpoint settles a llama3.3:70b call at 1 nominal usertoken", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { createGovernedStreamFn } = await import("../src/index.js");

		const { governedStreamFn, governor } = await createGovernedStreamFn(llamaStream(), {
			budget: BUDGET,
			dryRun: true,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});

		for await (const _event of await governedStreamFn(MODEL, CONTEXT)) {
			// drain — settlement runs after the final event
		}

		// Local default rate {0,0} + the per-call >=1 floor = exactly 1 usertoken.
		expect(BUDGET - governor.budgetRemaining()).toBe(1);
		// Local scope never routes through the cloud unknown-model warning.
		const modelWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("llama3.3:70b"));
		expect(modelWarns).toHaveLength(0);

		warnSpy.mockRestore();
		await governor.destroy();
	});

	it("without an endpoint declaration the same call stays cloud-scoped (frontier fallback)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { createGovernedStreamFn } = await import("../src/index.js");

		const { governedStreamFn, governor } = await createGovernedStreamFn(llamaStream(), {
			budget: BUDGET,
			dryRun: true,
			vaultBase,
		});

		for await (const _event of await governedStreamFn(MODEL, CONTEXT)) {
			// drain
		}

		// Cloud scope: unknown model → sonnet-class FALLBACK_RATE {30,150}.
		// ceil(26/1000*30 + 298/1000*150) = ceil(45.48) = 46 usertokens.
		expect(BUDGET - governor.budgetRemaining()).toBe(46);
		// Cloud unknown model warns once per model string (default unknownModelPolicy "warn").
		const modelWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("llama3.3:70b"));
		expect(modelWarns.length).toBeGreaterThanOrEqual(1);

		warnSpy.mockRestore();
		await governor.destroy();
	});
});
