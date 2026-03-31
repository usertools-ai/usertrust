// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for vault key derivation — scrypt-based AES-256 key from passphrase + salt.
 */

import { describe, expect, it } from "vitest";
import { deriveKey, generateSalt } from "../../src/vault/derive.js";

describe("deriveKey()", () => {
	it("produces a 32-byte buffer", () => {
		const salt = generateSalt();
		const key = deriveKey("test-passphrase", salt);
		expect(Buffer.isBuffer(key)).toBe(true);
		expect(key.length).toBe(32);
	});

	it("is deterministic — same passphrase + salt produces same key", () => {
		const salt = generateSalt();
		const key1 = deriveKey("deterministic-test", salt);
		const key2 = deriveKey("deterministic-test", salt);
		expect(key1.equals(key2)).toBe(true);
	});

	it("produces different keys for different passphrases", () => {
		const salt = generateSalt();
		const key1 = deriveKey("passphrase-a", salt);
		const key2 = deriveKey("passphrase-b", salt);
		expect(key1.equals(key2)).toBe(false);
	});

	it("produces different keys for different salts", () => {
		const salt1 = generateSalt();
		const salt2 = generateSalt();
		const key1 = deriveKey("same-passphrase", salt1);
		const key2 = deriveKey("same-passphrase", salt2);
		expect(key1.equals(key2)).toBe(false);
	});

	it("handles empty passphrase", () => {
		const salt = generateSalt();
		const key = deriveKey("", salt);
		expect(Buffer.isBuffer(key)).toBe(true);
		expect(key.length).toBe(32);
	});

	it("handles unicode passphrase", () => {
		const salt = generateSalt();
		const key = deriveKey("パスワード🔑émojis", salt);
		expect(Buffer.isBuffer(key)).toBe(true);
		expect(key.length).toBe(32);
	});
});

describe("generateSalt()", () => {
	it("produces a 16-byte buffer", () => {
		const salt = generateSalt();
		expect(Buffer.isBuffer(salt)).toBe(true);
		expect(salt.length).toBe(16);
	});

	it("produces unique values on successive calls", () => {
		const salt1 = generateSalt();
		const salt2 = generateSalt();
		expect(salt1.equals(salt2)).toBe(false);
	});
});
