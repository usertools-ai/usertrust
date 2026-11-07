// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The task scope stays ledger-free, as the cost-center scope does.
 *
 * `budget/task.ts` derives the task key itself, so a caller that only wraps work in
 * `withTaskLimit` (in dryRun, or before a ledger is configured) never loads the ledger client or
 * the native TigerBeetle binding. The derivation it uses lives in `shared/derive.ts`, which the
 * ledger client's statics delegate to, so the two cannot drift.
 *
 * Both the binding and the ledger client are replaced here by modules that throw when loaded: a
 * static import of either, anywhere under the task scope, fails this file. A positive control
 * loads the ledger client and expects that throw, so the trap is known to fire.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("tigerbeetle-node", () => {
	throw new Error("the task scope loaded tigerbeetle-node");
});
vi.mock("../../src/ledger/client.js", () => {
	throw new Error("the task scope loaded the ledger client");
});

describe("the task scope loads no ledger code", () => {
	it("budget/task.ts imports without the ledger client or the binding", async () => {
		const task = await import("../../src/budget/task.js");
		expect(task.withTaskLimit("t", 1, () => task.getCurrentTask()?.id)).toBe("t");
	});

	it("shared/derive.ts imports without them too, and gives the known answers", async () => {
		const derive = await import("../../src/shared/derive.js");
		// Known answers computed outside the implementation (sha256 of the domain tag, then each
		// part as a big-endian u32 UTF-8 byte length and its bytes; the first 16 bytes). The same
		// values the ledger client's own suite pins.
		expect(derive.deriveTaskLimitAccountId("local", "a")).toBe(
			336617073386892556721645347786877214709n,
		);
		expect(derive.deriveTaskLimitAccountId("\u00e9quipe", "a")).toBe(
			114683262744481504069649086242835571669n,
		);
		expect(derive.deriveTaskLimitOperatorId("local")).toBe(
			246640142458018110351941908793456646562n,
		);
		expect(derive.taskNamespaceTag("local")).toBe(186289599134792991193483597080094301258n);
	});

	it("taskKeyHex is the shared derivation in 32 lowercase hex characters", async () => {
		const { taskKeyHex } = await import("../../src/budget/task.js");
		const { deriveTaskLimitAccountId } = await import("../../src/shared/derive.js");
		expect(taskKeyHex("local", "t41")).toBe(
			deriveTaskLimitAccountId("local", "t41").toString(16).padStart(32, "0"),
		);
	});

	it("control: loading the ledger client here throws, so the trap fires", async () => {
		await expect(import("../../src/ledger/client.js")).rejects.toThrow();
	});
});
