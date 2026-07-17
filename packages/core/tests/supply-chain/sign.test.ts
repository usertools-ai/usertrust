// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createUnsignedManifest } from "../../src/supply-chain/manifest.js";
import { generateKeyPair, signManifest, verifySignature } from "../../src/supply-chain/sign.js";

describe("generateKeyPair", () => {
	it("produces valid hex-encoded keys", () => {
		const { publicKey, privateKey } = generateKeyPair();
		expect(publicKey).toMatch(/^[a-f0-9]{64}$/);
		expect(privateKey).toMatch(/^[a-f0-9]+$/);
		expect(privateKey.length).toBeGreaterThan(0);
	});

	it("produces unique keys each call", () => {
		const k1 = generateKeyPair();
		const k2 = generateKeyPair();
		expect(k1.publicKey).not.toBe(k2.publicKey);
		expect(k1.privateKey).not.toBe(k2.privateKey);
	});
});

describe("signManifest", () => {
	it("produces valid signature", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		expect(signed.signature).toMatch(/^[a-f0-9]+$/);
		expect(signed.signature.length).toBeGreaterThan(0);
	});

	it("adds signedAt timestamp", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const before = new Date().toISOString();
		const signed = signManifest(unsigned, privateKey);
		const after = new Date().toISOString();
		expect(signed.signedAt).toBeDefined();
		expect(signed.signedAt >= before).toBe(true);
		expect(signed.signedAt <= after).toBe(true);
	});

	it("adds publicKey from keypair", () => {
		const { publicKey, privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		expect(signed.publicKey).toBe(publicKey);
	});
});

describe("verifySignature", () => {
	it("returns true for valid signature", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		expect(verifySignature(signed, [signed.publicKey])).toBe(true);
	});

	it("returns false for tampered manifest (changed name)", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		const tampered = { ...signed, name: "Tampered" };
		expect(verifySignature(tampered, [tampered.publicKey])).toBe(false);
	});

	it("returns false for tampered manifest (changed permissions)", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		const tampered = { ...signed, permissions: ["llm_call", "shell_command"] as const };
		expect(verifySignature(tampered, [tampered.publicKey])).toBe(false);
	});

	it("returns false for tampered manifest (changed entryHash)", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		const tampered = { ...signed, entryHash: "b".repeat(64) };
		expect(verifySignature(tampered, [tampered.publicKey])).toBe(false);
	});

	it("returns false when the signing key is not in the registered trustedKeys (SC-1)", () => {
		const { privateKey } = generateKeyPair();
		const other = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, privateKey);
		// Signature is cryptographically valid, but the key is not registered → reject.
		expect(verifySignature(signed, [other.publicKey])).toBe(false);
		// Empty registry always fails closed.
		expect(verifySignature(signed, [])).toBe(false);
	});

	it("returns false for wrong public key", () => {
		const keys1 = generateKeyPair();
		const keys2 = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/test",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: "export default {}",
		});
		const signed = signManifest(unsigned, keys1.privateKey);
		const tampered = { ...signed, publicKey: keys2.publicKey };
		expect(verifySignature(tampered, [tampered.publicKey])).toBe(false);
	});
});

describe("round-trip", () => {
	it("create -> sign -> verify succeeds", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/roundtrip",
			name: "Round Trip",
			publisher: "acme",
			permissions: ["llm_call", "file_read"],
			entrySource: 'console.log("hello world");',
		});
		const signed = signManifest(unsigned, privateKey);
		expect(verifySignature(signed, [signed.publicKey])).toBe(true);
	});

	it("create -> sign -> tamper -> verify fails", () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/roundtrip",
			name: "Round Trip",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: 'console.log("hello world");',
		});
		const signed = signManifest(unsigned, privateKey);
		const tampered = { ...signed, publisher: "evil-corp" };
		expect(verifySignature(tampered, [tampered.publicKey])).toBe(false);
	});
});
