// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Writes that fail part-way. A key whose write fails (ENOSPC, EIO) must not stay behind,
 * and a failure while setting up the mirror must be reported, not turned into "ready" by
 * the concurrent-creation retry (ensure retries only on a lost race).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAll, tmp } from "./fixtures.js";

let failKeyWrite = false;
let failMirror = false;
let shortKeyWrite = false;
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		writeSync: (...a: Parameters<typeof real.writeSync>) => {
			// A short write: only half the key reaches the file, and no error is raised.
			if (shortKeyWrite && typeof a[1] === "string" && a[1].includes("PRIVATE KEY")) {
				const half = a[1].slice(0, Math.floor(a[1].length / 2));
				return real.writeSync(a[0], half);
			}
			return real.writeSync(...a);
		},
		writeFileSync: (...a: Parameters<typeof real.writeFileSync>) => {
			if (failKeyWrite && typeof a[0] === "number") {
				failKeyWrite = false;
				throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
			}
			if (failMirror && String(a[0]).endsWith("anchors.jsonl")) {
				throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
			}
			return real.writeFileSync(...a);
		},
	};
});

import { initAnchorIdentity, resolveSigner } from "../../../src/audit/anchor.js";
import { ensureAnchorIdentity } from "../../../src/audit/anchor-setup.js";

afterEach(() => {
	failKeyWrite = false;
	failMirror = false;
	shortKeyWrite = false;
	cleanupAll();
});

function vaultRoot(): string {
	const root = tmp("anchor-partial-vault-");
	mkdirSync(join(root, ".usertrust"), { recursive: true });
	writeFileSync(join(root, ".usertrust", "usertrust.config.json"), "{}\n");
	return root;
}

describe("a key whose write fails part-way", () => {
	it("is removed, so a retry with the same --key-file succeeds", () => {
		const root = tmp("anchor-partial-");
		const keyFile = join(tmp("anchor-partial-keys-"), "k.anchor.pem");
		failKeyWrite = true;
		expect(() => initAnchorIdentity(root, { keyFile })).toThrow(/ENOSPC/);
		expect(existsSync(keyFile)).toBe(false);
		const made = initAnchorIdentity(root, { keyFile });
		expect(existsSync(made.keyFile)).toBe(true);
	});
});

describe("a write that returns a short count", () => {
	it("still lands the whole key: a half-written key is never published", () => {
		const root = tmp("anchor-short-");
		const keyFile = join(tmp("anchor-short-keys-"), "k.anchor.pem");
		shortKeyWrite = true;
		const made = initAnchorIdentity(root, { keyFile });
		const pem = readFileSync(made.keyFile, "utf-8");
		expect(pem.trimEnd().endsWith("-----END PRIVATE KEY-----")).toBe(true);
		// the key on disk is the one the identity names
		expect(resolveSigner({ type: "pem", file: made.keyFile }, made.identity.vaultId).keyId).toBe(
			made.identity.keyId,
		);
	});
});

describe("a failure creating the mirror", () => {
	it("is reported by initAnchorIdentity with nothing published and the key removed", () => {
		const root = tmp("anchor-partial-mirror-");
		const keyFile = join(tmp("anchor-partial-mkeys-"), "k.anchor.pem");
		failMirror = true;
		expect(() => initAnchorIdentity(root, { keyFile })).toThrow(/EIO/);
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "identity.json"))).toBe(false);
		expect(existsSync(keyFile)).toBe(false);
		failMirror = false;
		expect(existsSync(initAnchorIdentity(root, { keyFile }).keyFile)).toBe(true);
	});

	it("makes ensure report key-write-failed, never ready", () => {
		const root = vaultRoot();
		const keyFile = join(tmp("anchor-partial-ekeys-"), "k.anchor.pem");
		failMirror = true;
		const r = ensureAnchorIdentity(root, { keyFile });
		expect(r.status).toBe("needs-attention");
		if (r.status === "needs-attention") expect(r.reason).toBe("key-write-failed");
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "identity.json"))).toBe(false);
		expect(existsSync(keyFile)).toBe(false);
	});
});
