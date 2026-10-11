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

/**
 * picocolors fixes colour support when it is imported (from a TTY, `CI`, `FORCE_COLOR`), so the
 * same test printed SGR codes on CI and none on a laptop. These tests choose it per case instead,
 * and run every terminal assertion with colours ON and OFF.
 */
const colour = vi.hoisted(() => ({ on: false }));
vi.mock("picocolors", async (importOriginal) => {
	const mod = (await importOriginal()) as { default?: unknown };
	const real = (mod.default ?? mod) as typeof import("picocolors");
	const pc = new Proxy(
		{},
		{
			get: (_target, key) =>
				(real.createColors(colour.on) as unknown as Record<PropertyKey, unknown>)[key],
		},
	);
	return { default: pc };
});

const { run } = await import("../../src/cli/secret.js");
const { AuditLockReleaseError } = await import("../../src/audit/chain.js");

/**
 * Terminal control planted in a vault's directory name, built from char codes (never a literal
 * escape in source): a well-formed SGR (`ESC[31m`), an OSC "set window title" (`ESC]0;…BEL`), CR,
 * DEL, and C1's 8-bit CSI. The SGR is the point: the planted bytes may look exactly like the
 * colour codes the CLI itself prints, so nothing is stripped "because it is well-formed" — the
 * assertion looks only at the text DERIVED FROM THIS PATH, where every one of them must be gone.
 */
const char = (code: number) => String.fromCharCode(code);
const [ESC, BEL, CR, DEL, CSI8] = [0x1b, 0x07, 0x0d, 0x7f, 0x9b].map(char) as [
	string,
	string,
	string,
	string,
	string,
];
const PLANTED_DIR = `vault-planted${ESC}[31m${ESC}]0;pwned${BEL}${CR}${DEL}${CSI8}2J`;
const LOCK_TAIL = ".audit-writer.lock";
/** A lock left behind in a vault whose directory name is {@link PLANTED_DIR}. */
const hostileLockLeft = () =>
	new AuditLockReleaseError([
		{
			path: join(tmpdir(), PLANTED_DIR, ".usertrust", "audit", LOCK_TAIL),
			error: Object.assign(new Error("EIO: i/o error"), { code: "EIO" }),
		},
	]);
/** C0, DEL and C1 characters in `text`. */
const controlsIn = (text: string) =>
	[...text].filter((ch) => {
		const code = ch.codePointAt(0) ?? 0;
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	});
/**
 * The printed path: from the planted directory name to the end of the lock file name. Whatever
 * picocolors wraps AROUND the message lies outside it; anything inside came from the path.
 */
function plantedPathIn(printed: string): string {
	const start = printed.indexOf("vault-planted");
	expect(start, "control: the planted path is printed").toBeGreaterThanOrEqual(0);
	const end = printed.indexOf(LOCK_TAIL, start);
	expect(end, "control: the whole path is printed").toBeGreaterThan(start);
	return printed.slice(start, end + LOCK_TAIL.length);
}
/** The terminal assertion, for one colour mode. */
function expectScrubbed(printed: string) {
	const path = plantedPathIn(printed);
	expect(controlsIn(path), "no control character from the planted path survives").toEqual([]);
	// Substituted, not dropped: the printable remnants of every planted sequence are still there.
	for (const remnant of ["[31m", "]0;pwned", "2J"]) expect(path).toContain(remnant);
	if (colour.on) {
		expect(printed, "control: colours really are on (picocolors wraps the line)").toContain(ESC);
	} else {
		expect(controlsIn(printed), "colours off: no control character anywhere").toEqual([]);
	}
}

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
		colour.on = false;
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

	it.each([
		["on", true],
		["off", false],
	] as const)(
		"colours %s: a lock path carrying terminal control (SGR, OSC, CR, DEL, 8-bit CSI) is SCRUBBED on stderr after a successful command",
		async (_mode, on) => {
			colour.on = on;
			faults.release = hostileLockLeft();

			await run();
			expect(process.exitCode).toBe(1);
			expectScrubbed(errorOutput.join("\n"));
		},
	);

	it.each([
		["on", true],
		["off", false],
	] as const)("colours %s: …and in the warning after a FAILED command", async (_mode, on) => {
		colour.on = on;
		faults.command = new Error("vault list failed");
		faults.release = hostileLockLeft();

		await expect(run()).rejects.toThrow("vault list failed");
		expectScrubbed(warnOutput.join("\n"));
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
