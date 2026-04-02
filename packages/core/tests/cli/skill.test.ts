// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/skill.js";
import { createUnsignedManifest } from "../../src/supply-chain/manifest.js";
import { generateKeyPair, signManifest } from "../../src/supply-chain/sign.js";

// ── Helpers ──

function writeManifest(dir: string, manifest: object): string {
	const path = join(dir, `manifest-${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify(manifest), "utf-8");
	return path;
}

function makeSignedManifest(
	opts: {
		permissions?: string[];
		publisher?: string;
	} = {},
) {
	const kp = generateKeyPair();
	const unsigned = createUnsignedManifest({
		id: "acme/summarizer",
		name: "Summarizer",
		publisher: opts.publisher ?? "acme",
		permissions: (opts.permissions as never[]) ?? ["llm_call", "tool_use", "file_read"],
		entrySource: "console.log('hello');",
	});
	const signed = signManifest(unsigned, kp.privateKey);
	return { signed, kp };
}

// ── Tests ──

describe("usertrust skill verify", () => {
	let tempDir: string;
	let logOutput: string[];
	let errorOutput: string[];
	let savedArgv: string[];
	let savedCwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `skill-test-${randomUUID()}`);
		mkdirSync(tempDir, { recursive: true });

		// Create .usertrust config with supplyChain enabled
		const vaultDir = join(tempDir, ".usertrust");
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000,
				supplyChain: {
					enabled: true,
					requireSignature: true,
					trustedPublishers: [],
					allowedPermissions: ["llm_call", "tool_use", "file_read"],
				},
			}),
			"utf-8",
		);

		logOutput = [];
		errorOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput.push(args.map(String).join(" "));
		});

		savedArgv = process.argv;
		savedCwd = process.cwd();
		process.chdir(tempDir);
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.argv = savedArgv;
		process.chdir(savedCwd);
		process.exitCode = undefined;
		vi.restoreAllMocks();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("valid signed manifest passes", async () => {
		const { signed } = makeSignedManifest();
		const manifestPath = writeManifest(tempDir, signed);

		process.argv = ["node", "usertrust", "skill", "verify", manifestPath];
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("valid");
		expect(combined).toContain("allowed");
	});

	it("tampered manifest fails", async () => {
		const { signed } = makeSignedManifest();
		// Tamper with the name after signing
		const tampered = { ...signed, name: "Evil Skill" };
		const manifestPath = writeManifest(tempDir, tampered);

		process.argv = ["node", "usertrust", "skill", "verify", manifestPath];
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("INVALID");
	});

	it("invalid signature fails", async () => {
		const { signed } = makeSignedManifest();
		// Replace signature with garbage (must be valid hex, 128 chars = 64 bytes)
		const invalid = { ...signed, signature: "a".repeat(128) };
		const manifestPath = writeManifest(tempDir, invalid);

		process.argv = ["node", "usertrust", "skill", "verify", manifestPath];
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("INVALID");
	});

	it("denied permissions reported", async () => {
		const { signed } = makeSignedManifest({
			permissions: ["shell_command", "network_access"],
		});
		const manifestPath = writeManifest(tempDir, signed);

		process.argv = ["node", "usertrust", "skill", "verify", manifestPath];
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("denied");
		expect(combined).toContain("shell_command");
		expect(combined).toContain("network_access");
	});

	it("--json returns structured result", async () => {
		const { signed } = makeSignedManifest();
		const manifestPath = writeManifest(tempDir, signed);

		process.argv = ["node", "usertrust", "skill", "verify", manifestPath, "--json"];
		await run();

		expect(logOutput.length).toBeGreaterThanOrEqual(1);
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.command).toBe("skill verify");
		expect(parsed.success).toBe(true);
		expect(parsed.data.id).toBe("acme/summarizer");
		expect(parsed.data.signatureValid).toBe(true);
		expect(parsed.data.permissionsAllowed).toBe(true);
	});

	it("--trusted-publisher overrides config", async () => {
		// Manifest requests shell_command + network_access (denied by default config)
		const { signed } = makeSignedManifest({
			permissions: ["shell_command", "network_access"],
			publisher: "trusted-corp",
		});
		const manifestPath = writeManifest(tempDir, signed);

		// Rewrite config to trust this publisher
		const vaultDir = join(tempDir, ".usertrust");
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000,
				supplyChain: {
					enabled: true,
					requireSignature: true,
					trustedPublishers: ["trusted-corp"],
					allowedPermissions: ["llm_call", "tool_use", "file_read"],
				},
			}),
			"utf-8",
		);

		process.argv = ["node", "usertrust", "skill", "verify", manifestPath, "--json"];
		await run();

		expect(logOutput.length).toBeGreaterThanOrEqual(1);
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.command).toBe("skill verify");
		expect(parsed.success).toBe(true);
		expect(parsed.data.permissionsAllowed).toBe(true);
		expect(parsed.data.deniedPermissions).toEqual([]);
	});

	it("non-existent file prints error", async () => {
		const fakePath = join(tempDir, "does-not-exist.json");

		process.argv = ["node", "usertrust", "skill", "verify", fakePath];
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("File not found");
	});

	it("invalid JSON prints error", async () => {
		const garbagePath = join(tempDir, "garbage.json");
		writeFileSync(garbagePath, "not valid json {{{}}", "utf-8");

		process.argv = ["node", "usertrust", "skill", "verify", garbagePath];
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("Invalid JSON");
	});
});
