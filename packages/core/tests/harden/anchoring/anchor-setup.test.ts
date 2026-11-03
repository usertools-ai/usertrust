// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ensureAnchorIdentity: idempotent, never overwrites, never mints a second key, never
 * deletes a damaged identity. Also `anchor pubkey`, `anchor init --json` and the
 * exclusive private-key write.
 */

import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAnchorIdentity } from "../../../src/audit/anchor.js";
import { ensureAnchorIdentity } from "../../../src/audit/anchor-setup.js";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import { cleanupAll, tmp } from "./fixtures.js";

const origHome = process.env.HOME;
const origCwd = process.cwd();
let home: string;

beforeEach(() => {
	// os.homedir() reads HOME on POSIX: the default key path lands in a throwaway dir.
	home = tmp("anchor-setup-home-");
	process.env.HOME = home;
	delete process.env.USERTRUST_ANCHOR_KEY;
});

afterEach(() => {
	process.env.HOME = origHome;
	process.chdir(origCwd);
	process.exitCode = 0;
	vi.restoreAllMocks();
	cleanupAll();
});

function vaultRoot(): string {
	const root = tmp("anchor-setup-vault-");
	mkdirSync(join(root, ".usertrust"), { recursive: true });
	writeFileSync(join(root, ".usertrust", "usertrust.config.json"), "{}\n");
	return root;
}

function keysDir(): string {
	return join(home, ".usertrust", "keys");
}

function keyFiles(): string[] {
	return existsSync(keysDir()) ? readdirSync(keysDir()).sort() : [];
}

describe("ensureAnchorIdentity", () => {
	it("creates identity, private key (0600), public copy and mirror on a fresh vault", () => {
		const root = vaultRoot();
		const r = ensureAnchorIdentity(root);
		if (r.status !== "created") throw new Error(`expected created, got ${r.status}`);
		expect(statSync(r.keyFile).mode & 0o777).toBe(0o600);
		expect(keyFiles()).toEqual([
			`${r.identity.vaultId}.anchor.pem`,
			`${r.identity.vaultId}.anchor.pub.pem`,
		]);
		expect(readFileSync(join(keysDir(), `${r.identity.vaultId}.anchor.pub.pem`), "utf-8")).toBe(
			r.publicKeyPem,
		);
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "identity.json"))).toBe(true);
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "anchors.jsonl"))).toBe(true);
	});

	it("is ready on the second call and leaves the key bytes and the key directory unchanged", () => {
		const root = vaultRoot();
		const first = ensureAnchorIdentity(root);
		if (first.status !== "created") throw new Error("setup");
		const before = readFileSync(first.keyFile);
		const files = keyFiles();
		const second = ensureAnchorIdentity(root);
		expect(second.status).toBe("ready");
		if (second.status === "ready") expect(second.keyId).toBe(first.keyId);
		expect(readFileSync(first.keyFile).equals(before)).toBe(true);
		expect(keyFiles()).toEqual(files);
	});

	it("with the key moved away it reports key-missing and mints nothing (control: key present -> ready)", () => {
		const root = vaultRoot();
		const first = ensureAnchorIdentity(root);
		if (first.status !== "created") throw new Error("setup");
		const aside = mkdtempSync(join(tmpdir(), "anchor-setup-aside-"));
		const moved = join(aside, "key.pem");
		renameSync(first.keyFile, moved);
		const identityBefore = readFileSync(
			join(root, ".usertrust", "audit", "anchors", "identity.json"),
			"utf-8",
		);
		const filesBefore = keyFiles();
		const r = ensureAnchorIdentity(root);
		expect(r.status).toBe("needs-attention");
		if (r.status === "needs-attention") expect(r.reason).toBe("key-missing");
		expect(keyFiles()).toEqual(filesBefore);
		expect(
			readFileSync(join(root, ".usertrust", "audit", "anchors", "identity.json"), "utf-8"),
		).toBe(identityBefore);
		renameSync(moved, first.keyFile);
		expect(ensureAnchorIdentity(root).status).toBe("ready");
	});

	it("reports key-mismatch when the file at the key path is another vault's key", () => {
		const a = vaultRoot();
		const b = vaultRoot();
		const ra = ensureAnchorIdentity(a);
		const rb = ensureAnchorIdentity(b);
		if (ra.status !== "created" || rb.status !== "created") throw new Error("setup");
		const bKey = readFileSync(rb.keyFile);
		writeFileSync(ra.keyFile, bKey);
		const r = ensureAnchorIdentity(a);
		expect(r.status).toBe("needs-attention");
		if (r.status === "needs-attention") expect(r.reason).toBe("key-mismatch");
	});

	it("leaves a corrupt identity.json byte-for-byte and creates nothing", () => {
		const root = vaultRoot();
		const dir = join(root, ".usertrust", "audit", "anchors");
		mkdirSync(dir, { recursive: true });
		const p = join(dir, "identity.json");
		writeFileSync(p, "{ not json");
		const r = ensureAnchorIdentity(root);
		expect(r.status).toBe("needs-attention");
		if (r.status === "needs-attention") expect(r.reason).toBe("identity-unreadable");
		expect(readFileSync(p, "utf-8")).toBe("{ not json");
		expect(keyFiles()).toEqual([]);
	});

	it("refuses without a vault config and does not create .usertrust", () => {
		const root = tmp("anchor-setup-novault-");
		const r = ensureAnchorIdentity(root);
		expect(r.status).toBe("needs-attention");
		if (r.status === "needs-attention") expect(r.reason).toBe("no-vault");
		expect(existsSync(join(root, ".usertrust"))).toBe(false);
		expect(keyFiles()).toEqual([]);
	});

	it("reports key-write-failed with a message when the key directory cannot be made", () => {
		const root = vaultRoot();
		// A regular file where the key directory must go.
		writeFileSync(join(home, ".usertrust"), "in the way");
		const r = ensureAnchorIdentity(root);
		expect(r.status).toBe("needs-attention");
		if (r.status === "needs-attention") expect(r.reason).toBe("key-write-failed");
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "identity.json"))).toBe(false);
	});
});

describe("initAnchorIdentity writes the private key exclusively", () => {
	it("refuses a --key-file that already exists and leaves its bytes unchanged", () => {
		const root = vaultRoot();
		const target = join(tmp("anchor-setup-kf-"), "mine.pem");
		writeFileSync(target, "somebody's key\n", { mode: 0o600 });
		expect(() => initAnchorIdentity(root, { keyFile: target })).toThrow(/overwrite/);
		expect(readFileSync(target, "utf-8")).toBe("somebody's key\n");
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "identity.json"))).toBe(false);
	});

	it("control: a --key-file that does not exist yet is written", () => {
		const root = vaultRoot();
		const target = join(tmp("anchor-setup-kf-"), "new.pem");
		const made = initAnchorIdentity(root, { keyFile: target });
		expect(readFileSync(target, "utf-8")).toContain("PRIVATE KEY");
		expect(made.keyFile).toContain("new.pem");
	});
});

describe("anchor pubkey / anchor init --json", () => {
	function capture(): { lines: string[]; out: string[] } {
		const lines: string[] = [];
		const out: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		});
		return { lines, out };
	}

	it("init --json carries publicKeyPem, and pubkey prints the same key", async () => {
		const root = vaultRoot();
		process.chdir(root);
		const c = capture();
		await anchorRun(["init"], { json: true });
		const init = JSON.parse(c.lines.at(-1) as string);
		expect(init.success).toBe(true);
		expect(init.data.publicKeyPem).toContain("BEGIN PUBLIC KEY");

		await anchorRun(["pubkey"], {});
		expect(c.out.join("")).toBe(init.data.publicKeyPem);

		await anchorRun(["pubkey"], { json: true });
		const pk = JSON.parse(c.lines.at(-1) as string);
		expect(pk.command).toBe("anchor pubkey");
		expect(pk.data.publicKeyPem).toBe(init.data.publicKeyPem);
		expect(pk.data.keyId).toBe(init.data.keyId);
	});

	it("the printed key verifies a signature from the vault's key; another vault's key does not", async () => {
		const a = vaultRoot();
		const b = vaultRoot();
		const ra = ensureAnchorIdentity(a);
		const rb = ensureAnchorIdentity(b);
		if (ra.status !== "created" || rb.status !== "created") throw new Error("setup");
		process.chdir(a);
		const c = capture();
		await anchorRun(["pubkey"], {});
		const pem = c.out.join("");
		const msg = Buffer.from("anchor preimage");
		const sig = cryptoSign(null, msg, readFileSync(ra.keyFile, "utf-8"));
		expect(cryptoVerify(null, msg, createPublicKey(pem), sig)).toBe(true);
		expect(cryptoVerify(null, msg, createPublicKey(rb.publicKeyPem), sig)).toBe(false);
	});

	it("pubkey without an identity fails with exit 1", async () => {
		const root = vaultRoot();
		process.chdir(root);
		const c = capture();
		await anchorRun(["pubkey"], { json: true });
		const out = JSON.parse(c.lines.at(-1) as string);
		expect(out.success).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});
