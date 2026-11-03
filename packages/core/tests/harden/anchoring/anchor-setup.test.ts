// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ensureAnchorIdentity: idempotent, never overwrites, never mints a second key, never
 * deletes a damaged identity. Also `anchor pubkey`, `anchor init --json` and the
 * exclusive private-key write.
 */

import { execFile } from "node:child_process";
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	initAnchorIdentity,
	mintSuccessorKey,
	publicKeyCopyPath,
	recordRotatedIdentity,
	resolveSigner,
} from "../../../src/audit/anchor.js";
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

	it.each([
		["an object", {}],
		["a null entry", [null]],
		["an entry without keys", [{ keyId: 1 }]],
	])(
		"a mismatched key with a key history that is %s is identity-unreadable, not a throw",
		(_n, history) => {
			const a = vaultRoot();
			const b = vaultRoot();
			const ra = ensureAnchorIdentity(a);
			const rb = ensureAnchorIdentity(b);
			if (ra.status !== "created" || rb.status !== "created") throw new Error("setup");
			writeFileSync(ra.keyFile, readFileSync(rb.keyFile));
			const p = join(a, ".usertrust", "audit", "anchors", "identity.json");
			const identity = JSON.parse(readFileSync(p, "utf-8"));
			identity.keyHistory = history;
			const text = JSON.stringify(identity);
			writeFileSync(p, text);
			const r = ensureAnchorIdentity(a);
			expect(r.status).toBe("needs-attention");
			if (r.status === "needs-attention") expect(r.reason).toBe("identity-unreadable");
			expect(readFileSync(p, "utf-8")).toBe(text);
		},
	);

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

	it("on a fresh vault with USERTRUST_ANCHOR_KEY set it mints nothing and says why (control: unset -> created)", () => {
		const root = vaultRoot();
		process.env.USERTRUST_ANCHOR_KEY = "/nonexistent/overriding.pem";
		try {
			const r = ensureAnchorIdentity(root);
			expect(r.status).toBe("needs-attention");
			if (r.status === "needs-attention") expect(r.reason).toBe("env-key-set");
		} finally {
			delete process.env.USERTRUST_ANCHOR_KEY;
		}
		expect(existsSync(join(root, ".usertrust", "audit", "anchors", "identity.json"))).toBe(false);
		expect(keyFiles()).toEqual([]);
		expect(ensureAnchorIdentity(root).status).toBe("created");
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

describe("ensureAnchorIdentity resolves the signer like the emitter does", () => {
	it("a vault keyed by USERTRUST_ANCHOR_KEY is ready; without it the same state is key-missing", () => {
		const root = vaultRoot();
		const first = ensureAnchorIdentity(root);
		if (first.status !== "created") throw new Error("setup");
		const aside = join(mkdtempSync(join(tmpdir(), "anchor-setup-env-")), "key.pem");
		renameSync(first.keyFile, aside);
		expect(ensureAnchorIdentity(root).status).toBe("needs-attention");
		process.env.USERTRUST_ANCHOR_KEY = aside;
		try {
			expect(ensureAnchorIdentity(root).status).toBe("ready");
		} finally {
			delete process.env.USERTRUST_ANCHOR_KEY;
		}
	});

	it("a rotated vault is ready with the successor key and key-superseded with the old one", () => {
		const root = vaultRoot();
		const first = ensureAnchorIdentity(root);
		if (first.status !== "created") throw new Error("setup");
		const next = mintSuccessorKey(first.identity.vaultId);
		recordRotatedIdentity(root, { keyId: next.keyId, publicKeySpki: next.publicKeySpki });
		const old = ensureAnchorIdentity(root);
		expect(old.status).toBe("needs-attention");
		if (old.status === "needs-attention") expect(old.reason).toBe("key-superseded");
		expect(ensureAnchorIdentity(root, { keyFile: next.keyFile }).status).toBe("ready");
	});
});

describe("concurrent callers", () => {
	it("six processes on one fresh vault: exactly one creates, the rest see ready, one key pair on disk", async () => {
		const root = vaultRoot();
		const dir = tmp("anchor-setup-race-");
		const script = join(dir, "child.mts");
		const mod = pathToFileURL(join(import.meta.dirname, "../../../src/audit/anchor-setup.ts")).href;
		writeFileSync(
			script,
			`import { ensureAnchorIdentity } from ${JSON.stringify(mod)};\nconst r = ensureAnchorIdentity(process.argv[2]);\nconsole.log(JSON.stringify({ status: r.status, reason: r.status === "needs-attention" ? r.reason : null }));\n`,
		);
		const results = await Promise.all(
			Array.from(
				{ length: 6 },
				() =>
					new Promise<string>((resolve, reject) => {
						execFile(
							process.execPath,
							["--import", "tsx", script, root],
							{ env: { ...process.env, HOME: home } },
							(err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
						);
					}),
			),
		);
		const statuses = results.map((r) => (JSON.parse(r) as { status: string }).status);
		expect(statuses.filter((x) => x === "created")).toHaveLength(1);
		expect(statuses.filter((x) => x === "ready")).toHaveLength(5);
		expect(keyFiles()).toHaveLength(2);
	}, 60_000); // timing: 60 s test budget for six child processes; the test took 0.36-0.43 s when measured (3 runs), over 100x headroom.
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

	it("two key files in one directory keep separate public copies (anchor and anchor.pem)", () => {
		const dir = tmp("anchor-setup-inj-");
		const a = initAnchorIdentity(vaultRoot(), { keyFile: join(dir, "anchor") });
		const b = initAnchorIdentity(vaultRoot(), { keyFile: join(dir, "anchor.pem") });
		expect(a.publicKeyPem).not.toBe(b.publicKeyPem);
		expect(readFileSync(join(dir, "anchor.pub"), "utf-8")).toBe(a.publicKeyPem);
		expect(readFileSync(join(dir, "anchor.pub.pem"), "utf-8")).toBe(b.publicKeyPem);
		// positive control: the mapping is the one the test names
		expect(publicKeyCopyPath(join(dir, "anchor"))).toBe(join(dir, "anchor.pub"));
		expect(publicKeyCopyPath(join(dir, "anchor.pem"))).toBe(join(dir, "anchor.pub.pem"));
	});

	it("replaces a stale public copy left beside an earlier key at the same path", () => {
		const root = vaultRoot();
		const dir = tmp("anchor-setup-kf-");
		const target = join(dir, "k.anchor.pem");
		const earlier = initAnchorIdentity(vaultRoot(), {
			keyFile: join(tmp("anchor-setup-earlier-"), "e.pem"),
		});
		writeFileSync(join(dir, "k.anchor.pub.pem"), earlier.publicKeyPem);
		const made = initAnchorIdentity(root, { keyFile: target });
		expect(readFileSync(join(dir, "k.anchor.pub.pem"), "utf-8")).toBe(made.publicKeyPem);
		expect(made.publicKeyPem).not.toBe(earlier.publicKeyPem);
	});

	it("leaves a PRIVATE key that sits at the .pub.pem path byte-identical (and still makes the vault)", () => {
		const root = vaultRoot();
		const dir = tmp("anchor-setup-kf-");
		const other = initAnchorIdentity(vaultRoot(), {
			keyFile: join(tmp("anchor-setup-ok-"), "o.pem"),
		});
		const privatePem = readFileSync(other.keyFile, "utf-8");
		const pubPath = join(dir, "k.anchor.pub.pem");
		writeFileSync(pubPath, privatePem, { mode: 0o600 });
		const made = initAnchorIdentity(root, { keyFile: join(dir, "k.anchor.pem") });
		expect(readFileSync(pubPath, "utf-8")).toBe(privatePem);
		expect(readFileSync(made.keyFile, "utf-8")).toContain("PRIVATE KEY");
	});

	it("a .pub.pem symlink to the key file cannot clobber the new private key", () => {
		const root = vaultRoot();
		const dir = tmp("anchor-setup-kf-");
		const keyFile = join(dir, "k.anchor.pem");
		symlinkSync(keyFile, join(dir, "k.anchor.pub.pem"));
		const made = initAnchorIdentity(root, { keyFile });
		expect(readFileSync(keyFile, "utf-8")).toContain("PRIVATE KEY");
		expect(resolveSigner({ type: "pem", file: keyFile }).keyId).toBe(made.identity.keyId);
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

	it("pubkey refuses a path or unknown option (exit 2) and prints no key", async () => {
		const root = vaultRoot();
		process.chdir(root);
		const c = capture();
		await anchorRun(["init"], { json: true });
		for (const extra of [["/some/other/vault"], ["-vault"]]) {
			c.out.length = 0;
			c.lines.length = 0;
			process.exitCode = 0;
			await anchorRun(["pubkey", ...extra], {});
			expect(process.exitCode).toBe(2);
			expect(c.out.join("")).not.toContain("BEGIN PUBLIC KEY");
			expect(c.lines.join("\n")).not.toContain("BEGIN PUBLIC KEY");
		}
		// positive control: with no extra argument the same call prints the key
		process.exitCode = 0;
		await anchorRun(["pubkey"], {});
		expect(c.out.join("")).toContain("BEGIN PUBLIC KEY");
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

	it("pubkey refuses a genesis key that is not a valid Ed25519 key for its keyId (no raw bytes printed)", async () => {
		const root = vaultRoot();
		const r = ensureAnchorIdentity(root);
		if (r.status !== "created") throw new Error("setup");
		const idPath = join(root, ".usertrust", "audit", "anchors", "identity.json");
		const original = JSON.parse(readFileSync(idPath, "utf-8"));
		process.chdir(root);
		for (const bad of ["\u001b[2Jhello", "AAAA"]) {
			const tampered = {
				...original,
				keyHistory: [{ ...original.keyHistory[0], publicKeySpki: bad }],
			};
			writeFileSync(idPath, JSON.stringify(tampered));
			const c = capture();
			process.exitCode = 0;
			await anchorRun(["pubkey"], {});
			expect(process.exitCode).toBe(1);
			expect(c.out.join("")).toBe("");
			expect(c.lines.join("\n")).not.toContain("\u001b[2J");
			vi.restoreAllMocks();
		}
		// A different but valid key under the recorded keyId is refused too.
		const other = ensureAnchorIdentity(vaultRoot());
		if (other.status !== "created") throw new Error("setup");
		const swapped = {
			...original,
			keyHistory: [{ ...original.keyHistory[0], publicKeySpki: other.identity.publicKeySpki }],
		};
		writeFileSync(idPath, JSON.stringify(swapped));
		const c2 = capture();
		process.exitCode = 0;
		await anchorRun(["pubkey"], {});
		expect(process.exitCode).toBe(1);
		expect(c2.out.join("")).toBe("");
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
