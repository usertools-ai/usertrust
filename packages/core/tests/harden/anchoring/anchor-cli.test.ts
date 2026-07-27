// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — anchor CLI regressions: `anchor now --json` and `anchor rotate`
 * must report failure (exit 1) when a record is emitted but never delivered
 * to any sink (spec §5.3); the core `verify` CLI rejects unknown flags so a
 * typo cannot silently weaken a CI gate (spec §7.5).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import { run as verifyRun } from "../../../src/cli/verify.js";
import { appendEvents, cleanupAll, makeAnchoredVault, tmp } from "./fixtures.js";

const origCwd = process.cwd();
const origArgv = process.argv;

afterEach(() => {
	process.chdir(origCwd);
	process.argv = origArgv;
	process.exitCode = 0;
	vi.restoreAllMocks();
	cleanupAll();
});

function captureLog(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	return { lines, restore: () => spy.mockRestore() };
}

describe("HARDEN: `anchor now --json` is delivery-gated", () => {
	it("reports success:false and exit 1 when every sink fails (record stranded in outbox)", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const unwritable = "/proc/nonexistent/anchors.jsonl"; // guaranteed write failure
		const { lines, restore } = captureLog();
		try {
			await anchorRun(["now", "--sink-file", unwritable, "--publish-retries", "1"], { json: true });
		} finally {
			restore();
		}
		const out = JSON.parse(lines.at(-1) as string);
		expect(out.command).toBe("anchor now");
		expect(out.success).toBe(false);
		expect(out.data.delivered).toBe(false);
		expect(out.data.outboxDepth).toBeGreaterThan(0);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: `anchor rotate` is delivery-gated", () => {
	it("reports success:false and exit 1 when the rotation record never reaches a sink", async () => {
		const s = await makeAnchoredVault(3);
		await appendEvents(s.root, 1, 4);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const unwritable = "/proc/nonexistent/anchors.jsonl";
		const { lines, restore } = captureLog();
		try {
			await anchorRun(["rotate", "--sink-file", unwritable, "--publish-retries", "1"], {
				json: true,
			});
		} finally {
			restore();
		}
		const out = JSON.parse(lines.at(-1) as string);
		expect(out.command).toBe("anchor rotate");
		expect(out.success).toBe(false);
		expect(out.data.delivered).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: core `verify` CLI rejects unknown flags", () => {
	it("a typoed --require-anchro fails loudly instead of silently weakening the gate", async () => {
		const root = tmp("verify-flag-");
		await appendEvents(root, 2);
		process.argv = ["node", "usertrust", "verify", "--require-anchro"];
		const { lines, restore } = captureLog();
		try {
			await verifyRun(root, { json: false });
		} finally {
			restore();
		}
		expect(lines.join("\n")).toMatch(/Unknown flag: --require-anchro/);
		expect(process.exitCode).toBe(1);
	});
});
