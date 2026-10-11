// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust secret` cleanup: the vault is destroyed and the audit writer released after EVERY
 * command, and a cleanup failure never hides the command's own outcome.
 *  - the command failed → ITS error is what the CLI reports; a cleanup failure is a warning;
 *  - the command succeeded → a cleanup failure (an audit lock left behind) makes the CLI exit
 *    non-zero with a message;
 *  - each cleanup step runs even when the other throws.
 *
 * The real vault store and audit writer are used, each wrapped so one call can be made to fail:
 * `ls` (the command), `vault.destroy()` and `audit.release()`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
	command: undefined as Error | undefined,
	destroy: undefined as Error | undefined,
	release: undefined as Error | undefined,
	destroyed: 0,
	released: 0,
}));

vi.mock("../../src/audit/chain.js", async (importOriginal) => {
	const chain = await importOriginal<typeof import("../../src/audit/chain.js")>();
	return {
		...chain,
		createAuditWriter: (...args: Parameters<typeof chain.createAuditWriter>) => {
			const writer = chain.createAuditWriter(...args);
			return {
				...writer,
				release() {
					faults.released++;
					writer.release();
					if (faults.release !== undefined) throw faults.release;
				},
			};
		},
	};
});

vi.mock("../../src/vault/store.js", async (importOriginal) => {
	const store = await importOriginal<typeof import("../../src/vault/store.js")>();
	return {
		...store,
		createVaultStore: async (...args: Parameters<typeof store.createVaultStore>) => {
			const vault = await store.createVaultStore(...args);
			return {
				...vault,
				async list() {
					if (faults.command !== undefined) throw faults.command;
					return vault.list();
				},
				destroy() {
					faults.destroyed++;
					vault.destroy();
					if (faults.destroy !== undefined) throw faults.destroy;
				},
			};
		},
	};
});

const { run } = await import("../../src/cli/secret.js");

describe("usertrust secret — cleanup never hides the command's outcome", () => {
	let tmpDir: string;
	let origCwd: string;
	let origArgv: string[];
	let origVaultKey: string | undefined;
	let errorOutput: string[];
	let warnOutput: string[];

	beforeEach(() => {
		tmpDir = join(tmpdir(), `trust-secret-cleanup-${randomUUID()}`);
		mkdirSync(join(tmpDir, ".usertrust"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 10_000, vault: { enabled: true, auditAccess: false } }),
		);
		origCwd = process.cwd();
		process.chdir(tmpDir);
		origArgv = process.argv;
		process.argv = ["node", "usertrust", "secret", "ls"];
		origVaultKey = process.env.USERTRUST_VAULT_KEY;
		process.env.USERTRUST_VAULT_KEY = "test-cli-vault-key-2026";
		process.exitCode = undefined;
		Object.assign(faults, {
			command: undefined,
			destroy: undefined,
			release: undefined,
			destroyed: 0,
			released: 0,
		});
		errorOutput = [];
		warnOutput = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errorOutput.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
			warnOutput.push(a.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.argv = origArgv;
		process.chdir(origCwd);
		process.exitCode = undefined;
		if (origVaultKey === undefined) {
			delete process.env.USERTRUST_VAULT_KEY;
		} else {
			process.env.USERTRUST_VAULT_KEY = origVaultKey;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("the command fails AND release fails: the COMMAND's error is what surfaces; the release failure is a warning", async () => {
		const commandErr = new Error("vault list failed");
		faults.command = commandErr;
		faults.release = new Error("lock left: /v/.audit-writer.lock (EIO)");

		await expect(run()).rejects.toBe(commandErr);
		expect(faults.destroyed, "the vault was still destroyed").toBe(1);
		expect(warnOutput.join("\n")).toContain("lock left: /v/.audit-writer.lock (EIO)");
	});

	it("the command fails AND vault.destroy() fails: the command's error surfaces, and the audit writer is still released", async () => {
		const commandErr = new Error("vault list failed");
		faults.command = commandErr;
		faults.destroy = new Error("vault destroy failed");

		await expect(run()).rejects.toBe(commandErr);
		expect(faults.released, "release still ran").toBe(1);
		expect(warnOutput.join("\n")).toContain("vault destroy failed");
	});

	it("the command succeeds and release fails: the CLI exits non-zero with the release failure — and the vault was still destroyed", async () => {
		faults.release = new Error("lock left: /v/.audit-writer.lock (EIO)");

		await expect(run()).resolves.toBeUndefined();
		expect(process.exitCode).toBe(1);
		expect(errorOutput.join("\n")).toContain("lock left: /v/.audit-writer.lock (EIO)");
		expect(faults.destroyed).toBe(1);
	});

	it("the command succeeds and vault.destroy() fails: the CLI exits non-zero — and the audit writer was still released", async () => {
		faults.destroy = new Error("vault destroy failed");

		await expect(run()).resolves.toBeUndefined();
		expect(process.exitCode).toBe(1);
		expect(errorOutput.join("\n")).toContain("vault destroy failed");
		expect(faults.released).toBe(1);
	});

	it("control: nothing fails — exit code untouched, nothing on stderr, both cleanup steps ran", async () => {
		await expect(run()).resolves.toBeUndefined();
		expect(process.exitCode).toBeUndefined();
		expect(errorOutput).toEqual([]);
		expect(warnOutput).toEqual([]);
		expect(faults.destroyed).toBe(1);
		expect(faults.released).toBe(1);
	});
});
