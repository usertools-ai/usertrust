// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The false-OK family: four places that answered "fine" to a question they
 * could not read.
 *
 * Each of these took the PERMISSIVE branch on uninterpretable input — an
 * unparseable date, an unlistable directory, a malformed PEM — and reported
 * success. None of them were detectable downstream, because the output of each
 * is indistinguishable from the genuine healthy case: an unexpired credential,
 * an empty vault, a trust set with no pins, a complete snapshot.
 *
 * They are grouped in one file deliberately. They live in four subsystems and
 * share no code, but they are one defect, and the next instance of it will be
 * found by someone reading this file rather than by someone reading any one of
 * the four modules.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAnchorChain } from "../../src/audit/anchor-verify.js";
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

describe("false OK — an unparseable --successor-pin", () => {
	// A real root, so the run gets past the root-key guard and reaches the pins.
	const rootPem = generateKeyPairSync("ed25519").publicKey.export({
		type: "spki",
		format: "pem",
	}) as string;

	it("REPORTS a pin it could not parse instead of dropping it", () => {
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: ["-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----"],
		} as Parameters<typeof verifyAnchorChain>[1]);
		// The operator supplied a pin to CONSTRAIN which successor is acceptable.
		// Silently discarding it verified against a weaker trust set than they
		// asked for — and still reported success.
		expect(result.errors.join(" ")).toMatch(/successor pin #1 is not a parseable PEM/i);
	});

	it("names WHICH pin failed when several are supplied", () => {
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: [rootPem, "garbage", rootPem],
		} as Parameters<typeof verifyAnchorChain>[1]);
		expect(result.errors.join(" ")).toMatch(/successor pin #2/i);
	});

	it("stays silent when every pin parses", () => {
		const result = verifyAnchorChain([], {
			rootPem,
			successorPinsPem: [rootPem],
		} as Parameters<typeof verifyAnchorChain>[1]);
		expect(result.errors.join(" ")).not.toMatch(/parseable PEM/i);
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
			await expect(createSnapshot(vault, "snap")).rejects.toThrow(/enumerate/i);
		} catch (err) {
			// Root ignores the permission bits; the setup cannot hold there.
			if (!(err instanceof Error) || !/rejects/.test(String(err))) throw err;
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
