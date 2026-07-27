// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/export.js";

describe("usertrust export", () => {
	let tempDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-export-"));
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("errors when no vault exists", async () => {
		await run(tempDir, {}, ["--markdown", join(tempDir, "out")]);
		expect(logOutput.join("\n")).toContain("usertrust init");
		expect(process.exitCode).toBe(1);
	});

	it("errors when --markdown <dir> is missing", async () => {
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		await run(tempDir, {}, []);
		expect(logOutput.join("\n")).toContain("--markdown");
		expect(process.exitCode).toBe(1);
	});

	it("exports and reports counts (human + json)", async () => {
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 5 } });
		writer.release();
		const out = join(tempDir, "out");

		await run(tempDir, {}, ["--markdown", out]);
		expect(existsSync(join(out, "Receipts.base"))).toBe(true);
		expect(logOutput.join("\n")).toContain("1");
		expect(process.exitCode).toBeUndefined();

		logOutput = [];
		await run(tempDir, { json: true }, ["--markdown", out]);
		const parsed = JSON.parse(logOutput.join("")) as {
			success: boolean;
			data: { written: number };
		};
		expect(parsed.success).toBe(true);
		expect(parsed.data.written).toBe(1);
	});
});
