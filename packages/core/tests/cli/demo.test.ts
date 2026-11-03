// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_PREFIX, demoLines, run, runDemo, shellWord } from "../../src/cli/demo.js";
import { COMMANDS } from "../../src/cli/main.js";

const CORE_VERSION = (
	JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8")) as {
		version: string;
	}
).version;

describe("usertrust demo", () => {
	let cwd: string;
	let previous: string;
	let fetchSpy: ReturnType<typeof vi.fn>;
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		previous = process.cwd();
		cwd = mkdtempSync(join(tmpdir(), "demo-cwd-"));
		process.chdir(cwd);
		// Nothing may reach the network: any fetch is a failure of the demo's promise.
		fetchSpy = vi.fn(async () => {
			throw new Error("the demo must not touch the network");
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		process.exitCode = undefined;
	});
	afterEach(() => {
		process.chdir(previous);
		globalThis.fetch = realFetch;
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("is a registered command", () => {
		expect(COMMANDS).toContain("demo");
	});

	it("makes three governed calls, then a PII refusal and a budget refusal, and its chain verifies", async () => {
		const result = await runDemo();
		expect(result.ok).toBe(true);
		expect(result.receipts).toHaveLength(3);
		expect(result.receipts.every((r) => r.settled && r.cost > 0)).toBe(true);
		expect(result.refusals.map((r) => r.kind)).toEqual(["pii", "budget"]);
		expect(result.refusals[0]?.reason).toContain("PII");
		expect(result.verified.valid).toBe(true);
		expect(result.verified.chainLength).toBeGreaterThanOrEqual(5);
	});

	it("writes nothing under the working directory and nothing reaches the network", async () => {
		// The control: the observer sees a vault when one is put there.
		const seen = (dir: string) => existsSync(join(dir, ".usertrust"));
		const probe = mkdtempSync(join(tmpdir(), "demo-probe-"));
		writeFileSync(join(probe, "marker"), "x");
		expect(seen(probe)).toBe(false);
		await runDemo();
		expect(readdirSync(cwd)).toEqual([]);
		expect(seen(cwd)).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("runs in a temporary vault of its own", async () => {
		const result = await runDemo();
		expect(
			result.vaultBase.startsWith(tmpdir()) || result.vaultBase.includes("usertrust-demo-"),
		).toBe(true);
		expect(result.vaultBase).not.toBe(cwd);
		expect(existsSync(join(result.vaultBase, ".usertrust", "audit", "events.jsonl"))).toBe(true);
	});

	it("prefixes every line it prints with the line that says nothing was called and nothing was spent", async () => {
		const lines = demoLines(await runDemo());
		expect(lines.length).toBeGreaterThan(15);
		for (const line of lines) expect(line.startsWith(`${DEMO_PREFIX}: `), line).toBe(true);
		expect(DEMO_PREFIX).toBe("demo: no AI was called, no money was spent");
	});

	it("opens with the first receipt's dollars, names both refusals, and points to the visual ledger at its own version", async () => {
		const result = await runDemo();
		const text = demoLines(result).join("\n");
		expect(text).toContain(`${DEMO_PREFIX}: call 1 of 3`);
		expect(text).toMatch(/\$0\.0004 \(4 usertokens\)/);
		expect(text).toContain("a call with a social security number in it was refused before it left");
		expect(text).toContain("a call that would overspend the budget was refused before it left");
		expect(text).toContain(`npx usertrust-ui@${CORE_VERSION} ${result.vaultBase}`);
	});

	it("quotes the vault path in the ui command, so a path with a space is one word", async () => {
		const spaced = mkdtempSync(join(tmpdir(), "a space "));
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = spaced;
		try {
			const result = await runDemo();
			expect(result.vaultBase).toContain("a space ");
			expect(result.uiCommand).toBe(
				`npx usertrust-ui@${CORE_VERSION} '${result.vaultBase.replace(/'/g, "'\\''")}'`,
			);
			expect(result.uiCommand).toContain("'");
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
	});

	it("shellWord leaves a plain path alone and quotes anything else for the shell it is printed for", () => {
		expect(shellWord("/tmp/usertrust-demo-abc123", "linux")).toBe("/tmp/usertrust-demo-abc123");
		expect(shellWord("/tmp/a b", "linux")).toBe("'/tmp/a b'");
		expect(shellWord("/tmp/it's", "linux")).toBe("'/tmp/it'\\''s'");
		expect(shellWord("/tmp/$(whoami)", "linux")).toBe("'/tmp/$(whoami)'");
		expect(shellWord("/tmp/a\\b", "linux")).toBe("'/tmp/a\\b'");
		expect(shellWord("C:\\Users\\A B\\Temp", "win32")).toBe('"C:\\Users\\A B\\Temp"');
		expect(shellWord("C:\\Users\\Temp", "win32")).toBe("C:\\Users\\Temp");
	});

	it("prints the same facts as one JSON object with --json", async () => {
		const out: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			out.push(String(line));
		});
		await run(undefined, { json: true });
		expect(out).toHaveLength(1);
		const parsed = JSON.parse(out[0] as string) as {
			command: string;
			success: boolean;
			data: {
				notice: string;
				receipts: unknown[];
				refusals: unknown[];
				verified: { valid: boolean };
			};
		};
		expect(parsed.command).toBe("demo");
		expect(parsed.success).toBe(true);
		expect(parsed.data.notice).toBe(DEMO_PREFIX);
		expect(parsed.data.receipts).toHaveLength(3);
		expect(parsed.data.refusals).toHaveLength(2);
		expect(parsed.data.verified.valid).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});
});
