// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Unit coverage for emitter/verifier helpers not exercised by the adversarial
 * corpus: signer resolution, sink construction, identity/resume error paths,
 * legacy-vault snapshots, the scheduler happy path, and the alg-agile
 * signature helper (spec reconciliation R2 — ECDSA P-256 for Phase 2).
 */

import {
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
	generateKeyPairSync,
} from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAnchorEmitter,
	createSink,
	defaultKeyPath,
	initAnchorIdentity,
	mintSuccessorKey,
	readAnchorIdentity,
	resolveSigner,
	resumeAnchorMirror,
} from "../../../src/audit/anchor.js";
import {
	keyIdFromKeyObject,
	publicKeyFromPem,
	publicKeyFromSpkiBase64,
	verifySignatureRaw,
} from "../../../src/audit/anchor-verify.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import { VAULT_DIR } from "../../../src/shared/constants.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	storeRecords,
	tmp,
} from "./fixtures.js";

afterEach(() => {
	// vi.stubEnv/unstubAllEnvs actually REMOVE the vars again — a plain
	// `process.env.X = undefined` would store the string "undefined" and
	// poison later signer resolution.
	vi.unstubAllEnvs();
	cleanupAll();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("resolveSigner", () => {
	function pemPair(): { privatePem: string; keyId: string } {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		return {
			privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
			keyId: keyIdFromKeyObject(publicKey),
		};
	}

	it("resolves an inline PEM from the default env var", async () => {
		const { privatePem, keyId } = pemPair();
		vi.stubEnv("USERTRUST_ANCHOR_KEY", privatePem);
		const signer = resolveSigner({ type: "pem" });
		expect(signer.keyId).toBe(keyId);
		const sig = await signer.sign("payload");
		expect(Buffer.from(sig, "base64").length).toBe(64);
	});

	it("resolves a key-file path from a custom env var", () => {
		const { privatePem, keyId } = pemPair();
		const dir = tmp("signer-env-");
		const file = join(dir, "k.pem");
		writeFileSync(file, privatePem);
		vi.stubEnv("TEST_ANCHOR_KEY_ALT", file);
		const signer = resolveSigner({ type: "pem", env: "TEST_ANCHOR_KEY_ALT" });
		expect(signer.keyId).toBe(keyId);
	});

	it("throws a helpful error when no key source exists", () => {
		vi.stubEnv("USERTRUST_ANCHOR_KEY", undefined);
		expect(() => resolveSigner({ type: "pem" })).toThrow(/USERTRUST_ANCHOR_KEY/);
	});

	it("external signer: keyId must match its publicKeySpki (defense against misconfig)", async () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const spki = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
		const keyId = keyIdFromKeyObject(publicKey);
		expect(() =>
			resolveSigner({
				type: "external",
				keyId: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
				publicKeySpki: spki,
				sign: () => Promise.resolve(new Uint8Array(64)),
			}),
		).toThrow(/does not match/);

		const ok = resolveSigner({
			type: "external",
			keyId,
			publicKeySpki: spki,
			sign: (pre) => Promise.resolve(cryptoSign(null, Buffer.from(pre), privateKey)),
		});
		expect(ok.keyId).toBe(keyId);
		const sig = await ok.sign("data");
		expect(verifySignatureRaw("ed25519", "data", publicKey, sig)).toBe(true);
	});
});

describe("sinks", () => {
	it("command sink pipes the canonical record to stdin and honors exit codes", async () => {
		const s = await makeAnchoredVault(2);
		const r1 = await anchorOnce(s);
		const dir = tmp("cmd-sink-");
		const out = join(dir, "out.jsonl");
		const okSink = createSink({ type: "command", argv: ["/bin/sh", "-c", `cat >> ${out}`] });
		await okSink.publish(r1);
		expect(readFileSync(out, "utf-8").trim()).toBe(canonicalize(r1));

		const failSink = createSink({ type: "command", argv: ["/bin/sh", "-c", "exit 3"] });
		await expect(failSink.publish(r1)).rejects.toThrow(/exited 3/);

		// A command that exits 0 WITHOUT reading stdin must still resolve —
		// the stdin EPIPE is a symptom, never the verdict (and never an
		// unhandled error).
		const earlyExit = createSink({ type: "command", argv: ["/bin/sh", "-c", "exit 0"] });
		await earlyExit.publish(r1);

		const emptySink = createSink({ type: "command", argv: [] });
		await expect(emptySink.publish(r1)).rejects.toThrow(/empty argv/);
	});

	it("file sink appends canonical lines", async () => {
		const s = await makeAnchoredVault(2);
		const r1 = await anchorOnce(s);
		const dir = tmp("file-sink-");
		const out = join(dir, "a.jsonl");
		const sink = createSink({ type: "file", path: out });
		await sink.publish(r1);
		await sink.publish(r1);
		expect(readFileSync(out, "utf-8").trim().split("\n").length).toBe(2);
	});
});

describe("identity / resume", () => {
	it("init refuses a second identity and a key path inside the vault", async () => {
		const s = await makeAnchoredVault(1);
		expect(() => initAnchorIdentity(s.root)).toThrow(/already exists/);
		const fresh = tmp("init-invault-");
		await appendEvents(fresh, 1);
		expect(() => initAnchorIdentity(fresh, { keyFile: join(fresh, VAULT_DIR, "k.pem") })).toThrow(
			/inside the vault/,
		);
	});

	it("readAnchorIdentity returns null for corrupt identity.json", async () => {
		const s = await makeAnchoredVault(1);
		writeFileSync(join(s.vaultPath, "audit", "anchors", "identity.json"), "{corrupt");
		expect(readAnchorIdentity(s.root)).toBeNull();
	});

	it("defaultKeyPath is namespaced by vaultId", () => {
		expect(defaultKeyPath("abc")).toMatch(/abc\.anchor\.pem$/);
	});

	it("resume validates the supplied record and re-seeds the mirror tail", async () => {
		const s = await makeAnchoredVault(2);
		const r1 = await anchorOnce(s);
		expect(() => resumeAnchorMirror(s.root, "{nope")).toThrow(/invalid/);
		const other = await makeAnchoredVault(1);
		const foreign = await anchorOnce(other);
		expect(() => resumeAnchorMirror(s.root, canonicalize(foreign))).toThrow(/vaultId/);
		expect(() => resumeAnchorMirror(s.root, canonicalize(r1))).toThrow(/already at anchorSeq/);

		// Simulate mirror loss, then re-seed from the store's newest record.
		unlinkSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"));
		const seeded = resumeAnchorMirror(s.root, canonicalize(r1));
		expect(seeded.anchorSeq).toBe(1);
		// Emission resumes cleanly after re-seeding.
		await appendEvents(s.root, 1, 3);
		const r2 = await anchorOnce(s);
		expect(r2.anchorSeq).toBe(2);
	});

	it("mintSuccessorKey writes the new private key outside the vault", () => {
		const successor = mintSuccessorKey("some-vault");
		expect(successor.keyId).toMatch(/^sha256:/);
		const priv = createPrivateKey(readFileSync(successor.keyFile, "utf-8"));
		expect(keyIdFromKeyObject(createPublicKey(priv))).toBe(successor.keyId);
		unlinkSync(successor.keyFile);
	});
});

describe("emitter edge paths", () => {
	it("legacy vault without .meta anchors from the ordered segment tail", async () => {
		const s = await makeAnchoredVault(3);
		unlinkSync(join(s.vaultPath, "audit", "events.jsonl.meta"));
		const r1 = await anchorOnce(s);
		expect(r1.treeSize).toBe(3);
	});

	it("empty vault is a no-op; rotate on an empty vault refuses", async () => {
		const root = tmp("empty-vault-");
		const store = tmp("empty-store-");
		const keyFile = join(store, "k.pem");
		initAnchorIdentity(root, { keyFile });
		const emitter = createAnchorEmitter(root, { signer: { type: "pem", file: keyFile } });
		const result = await emitter.anchorNow();
		expect(result.emitted).toBe(false);
		expect(result.reason).toBe("empty");
		await emitter.stop();
	});

	it("unreadable .meta (zero-length) skips the cycle after retries", async () => {
		const s = await makeAnchoredVault(2);
		writeFileSync(join(s.vaultPath, "audit", "events.jsonl.meta"), "");
		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
		});
		const result = await emitter.anchorNow();
		await emitter.stop();
		expect(result.emitted).toBe(false);
		expect(result.reason).toBe("snapshot-unstable");
		expect(emitter.status().anchorSkips).toBeGreaterThan(0);
	});

	it("scheduler emits on the everyEvents trigger and stop() is idempotent", async () => {
		const s = await makeAnchoredVault(3);
		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
			// The internal tick interval is max(250, min(everyMs, 5000)) — keep
			// everyMs small so a tick fires within the test window.
			cadence: { everyEvents: 1, everyMs: 300 },
		});
		emitter.start();
		emitter.start(); // second start is a no-op
		await sleep(900); // past the 250ms tick floor
		await emitter.stop();
		await emitter.stop();
		expect(storeRecords(s).length).toBeGreaterThanOrEqual(1);
		expect(emitter.exportSince(0).length).toBeGreaterThanOrEqual(1);
		expect(emitter.exportSince(999)).toEqual([]);
	});

	it("no-sinks (pull mode) leaves no outbox residue; status reports the tail", async () => {
		const s = await makeAnchoredVault(2);
		const emitter = createAnchorEmitter(s.root, { signer: { type: "pem", file: s.keyFile } });
		const r = await emitter.anchorNow();
		await emitter.stop();
		expect(r.emitted).toBe(true);
		const status = emitter.status();
		expect(status.outboxDepth).toBe(0);
		expect(status.lastAnchor?.anchorSeq).toBe(1);
		expect(status.eventsSinceLastAnchor).toBe(0);
		expect(status.msSinceLastAnchor).not.toBeNull();
	});
});

describe("verifySignatureRaw alg agility (R2)", () => {
	it("verifies ECDSA P-256 (Phase 2 transparency-log checkpoints) and rejects garbage", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const data = "checkpoint body";
		const sigDer = cryptoSign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" });
		expect(verifySignatureRaw("ecdsa-p256", data, publicKey, sigDer.toString("base64"))).toBe(true);
		const sigP1363 = cryptoSign("sha256", Buffer.from(data), {
			key: privateKey,
			dsaEncoding: "ieee-p1363",
		});
		expect(verifySignatureRaw("ecdsa-p256", data, publicKey, sigP1363.toString("base64"))).toBe(
			true,
		);
		expect(verifySignatureRaw("ecdsa-p256", "tampered", publicKey, sigDer.toString("base64"))).toBe(
			false,
		);
		expect(verifySignatureRaw("ecdsa-p256", data, publicKey, "")).toBe(false);
	});

	it("key-parsing helpers fail closed on garbage", () => {
		expect(publicKeyFromPem("not a pem")).toBeNull();
		expect(publicKeyFromSpkiBase64("bm90IGEga2V5")).toBeNull();
	});
});

describe("parseAnchorRecord strictness matrix (both packages)", () => {
	it("rejects every malformed-field variant with a code-prefixed error, in core AND verify copies", async () => {
		const { parseAnchorRecord: coreParse, verifyAnchorSignature } = await import(
			"../../../src/audit/anchor-verify.js"
		);
		const { parseAnchorRecord: pkgParse } = await import("../../../../verify/src/index.js");
		const s = await makeAnchoredVault(2);
		const r1 = await anchorOnce(s);
		const base = JSON.parse(canonicalize(r1)) as Record<string, unknown>;
		const variants: [Record<string, unknown> | string, RegExp][] = [
			["not json", /malformed-anchor/],
			['["array"]', /malformed-anchor/],
			[{ ...base, v: 2 }, /unsupported version/],
			[{ ...base, vaultId: "" }, /vaultId/],
			[{ ...base, prevAnchorHash: "xyz" }, /prevAnchorHash/],
			[{ ...base, lastHash: "short" }, /lastHash/],
			[{ ...base, merkleRoot: 42 }, /merkleRoot/],
			[{ ...base, timestamp: "" }, /timestamp/],
			[{ ...base, keyId: "md5:abc" }, /keyId/],
			[{ ...base, sig: "" }, /sig/],
			[{ ...base, rotation: "not-an-object" }, /rotation must be an object/],
			[
				{ ...base, rotation: { nextKeyId: r1.keyId, nextPublicKeySpki: "x", extra: 1 } },
				/unknown rotation field/,
			],
			[{ ...base, rotation: { nextKeyId: "bad", nextPublicKeySpki: "aGk=" } }, /nextKeyId/],
			[{ ...base, rotation: { nextKeyId: r1.keyId, nextPublicKeySpki: "" } }, /nextPublicKeySpki/],
		];
		for (const [variant, pattern] of variants) {
			const raw = typeof variant === "string" ? variant : JSON.stringify(variant);
			for (const parse of [coreParse, pkgParse]) {
				const { record, error } = parse(raw);
				expect(record, raw).toBeNull();
				expect(error, raw).toMatch(pattern);
			}
		}
		// A well-formed record still parses in both copies.
		expect(coreParse(canonicalize(r1)).record).not.toBeNull();
		expect(pkgParse(canonicalize(r1)).record).not.toBeNull();

		// verifyAnchorSignature error paths: unparseable candidate, no keyId match.
		const noMatch = verifyAnchorSignature(r1, ["-----BEGIN GARBAGE-----"]);
		expect(noMatch.ok).toBe(false);
		expect(noMatch.errors.join(" ")).toMatch(/no candidate key matches/);
		const other = await makeAnchoredVault(1);
		const wrongKey = verifyAnchorSignature(r1, [other.rootPem]);
		expect(wrongKey.ok).toBe(false);
	});
});
