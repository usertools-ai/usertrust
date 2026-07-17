// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — The verify CLI must set a nonzero process exit code on a FAILED
 * verdict, otherwise CI gates pass on tampered vaults.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent } from "../../src/shared/types.js";

describe("HARDEN: verify CLI exit code", () => {
	let root: string;
	let logOutput: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harden-exit-"));
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// CRITICAL: reset so the FAILED verdict does not leak into the vitest worker exit
		process.exitCode = 0;
		rmSync(root, { recursive: true, force: true });
	});

	it("sets process.exitCode = 1 for a tampered vault", async () => {
		const writer = createAuditWriter(root);
		await writer.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } });
		writer.release();

		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		const ev = JSON.parse(lines[0] as string) as AuditEvent;
		(ev.data as Record<string, unknown>).n = 999;
		lines[0] = JSON.stringify(ev);
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		process.exitCode = 0;
		await run(root);

		expect(process.exitCode).toBe(1);
		expect(logOutput.join("\n")).toContain("FAILED");
	});

	it("leaves process.exitCode = 0 for a clean vault", async () => {
		const writer = createAuditWriter(root);
		await writer.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
		writer.release();

		process.exitCode = 0;
		await run(root);

		expect(process.exitCode).toBe(0);
		expect(logOutput.join("\n")).toContain("Chain verified");
	});
});
