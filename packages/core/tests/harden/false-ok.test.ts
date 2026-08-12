// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The false-OK family: three places that answered "fine" to a question they
 * could not read.
 *
 * Each of these took the PERMISSIVE branch on uninterpretable input — an
 * unparseable date, an unlistable directory, a malformed PEM — and reported
 * success. None of them were detectable downstream, because the output of each
 * is indistinguishable from the genuine healthy case: an unexpired credential,
 * an empty vault, a complete snapshot.
 *
 * They are grouped in one file deliberately. They live in three subsystems and
 * share no code, but they are one defect, and the next instance of it will be
 * found by someone reading this file rather than by someone reading any one of
 * the three modules.
 *
 * The fourth member of this family — an unparseable `--successor-pin` — moved to
 * its own branch: it edits a verdict lattice with precedence rules and needed
 * three review rounds, and bundling it here let one hard change gate three
 * one-liners.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../src/audit/verify.js";
import type { CredentialScope } from "../../src/shared/types.js";
import { createSnapshot } from "../../src/snapshot/checkpoint.js";
import { checkScope } from "../../src/vault/scope.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "usertrust-false-ok-"));
});

afterEach(() => {
	// Restore traversability first — a 0o000 dir cannot be removed recursively.
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the OS reclaims the temp dir regardless.
	}
});

describe("false OK — an unparseable credential expiry", () => {
	const scope = (expiresAt: string | null): CredentialScope =>
		({ agents: [], actions: [], expiresAt }) as unknown as CredentialScope;
	const accessor = { agent: "a", action: "read" } as Parameters<typeof checkScope>[1];

	it("DENIES an expiry that cannot be parsed", () => {
		// `new Date("not-a-date").getTime()` is NaN, and `NaN <= Date.now()` is
		// false — so this fell through to allowed:true and an unreadable expiry
		// read as "not expired".
		const result = checkScope(scope("not-a-date"), accessor);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/not a valid date/i);
	});

	it("still denies a genuinely expired credential", () => {
		expect(checkScope(scope("2020-01-01T00:00:00.000Z"), accessor).allowed).toBe(false);
	});

	it("still allows a future expiry and a null expiry", () => {
		expect(checkScope(scope("2999-01-01T00:00:00.000Z"), accessor).allowed).toBe(true);
		expect(checkScope(scope(null), accessor).allowed).toBe(true);
	});
});

describe("false OK — an audit directory that cannot be enumerated", () => {
	it("does NOT report a clean vault it could not read", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		// A segment exists, so this vault is NOT empty. With `events.jsonl` absent
		// and the directory unreadable, the old code returned
		// `valid: true, chainLength: 0` — a clean bill of health, exit 0, on a
		// vault nobody could open.
		await writeFile(join(auditDir, "segment-1.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			const result = verifyVault(vault);
			// Running as root defeats permission bits entirely; skip rather than
			// assert a false negative on a machine where the setup cannot hold.
			if (result.chainLength > 0) return;
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toMatch(/could not be enumerated/i);
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still reports a genuinely absent audit directory honestly", () => {
		const result = verifyVault(join(tmp, "nope"));
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toMatch(/not found/i);
	});

	it("still verifies a readable empty vault as empty, not as broken", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		const result = verifyVault(vault);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
	});
});

describe("false OK — a snapshot built from an unreadable vault", () => {
	it("FAILS rather than writing a silently incomplete snapshot", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		await writeFile(join(auditDir, "events.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			// PROBE, don't pattern-match the failure. Root ignores mode 000, and the
			// previous guard tried to detect that by matching /rejects/ against
			// Vitest's message — which says "instead of rejecting", so the guard
			// rethrew instead of skipping. Ask the filesystem directly.
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				await expect(createSnapshot(vault, "snap")).rejects.toThrow(/enumerate/i);
			}
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still snapshots a readable vault", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		writeFileSync(join(vault, "audit", "events.jsonl"), "{}\n", "utf-8");
		await expect(createSnapshot(vault, "snap")).resolves.toBeDefined();
	});
});

describe("false OK — the fail-closed error must still be machine-readable", () => {
	it("snapshot create --json emits success:false rather than an uncaught throw", async () => {
		// A fail-closed error a machine consumer cannot read is only half-surfaced.
		// The new enumeration failure arrives as a throw, and unguarded it printed
		// no JSON at all — breaking the every-command JSON contract on exactly the
		// path this change exists to expose.
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		await writeFile(join(auditDir, "events.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		const logged: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
			logged.push(String(m));
		});
		const argv = process.argv;
		const exitCode = process.exitCode;
		process.argv = ["node", "usertrust", "snapshot", "create", "snap", "--json"];
		try {
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				const { run } = await import("../../src/cli/snapshot.js");
				await run(tmp, { json: true } as never);
				const out = logged.join("\n");
				expect(() => JSON.parse(out) as unknown).not.toThrow();
				expect(JSON.parse(out)).toMatchObject({ command: "snapshot", success: false });
			}
		} finally {
			process.argv = argv;
			process.exitCode = exitCode;
			spy.mockRestore();
			await chmod(auditDir, 0o700);
		}
	});
});
