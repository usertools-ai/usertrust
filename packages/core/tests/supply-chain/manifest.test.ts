// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createUnsignedManifest,
	hashManifest,
	validateManifest,
} from "../../src/supply-chain/manifest.js";

const validManifest = {
	version: 1 as const,
	id: "acme/summarizer",
	name: "Summarizer",
	publisher: "acme",
	permissions: ["llm_call", "file_read"] as const,
	entryHash: "a".repeat(64),
	signedAt: "2026-03-15T12:00:00.000Z",
	signature: "ab".repeat(64),
	publicKey: "cd".repeat(32),
};

describe("validateManifest", () => {
	it("accepts a valid manifest", () => {
		const result = validateManifest(validManifest);
		expect(result.id).toBe("acme/summarizer");
		expect(result.version).toBe(1);
	});

	it("rejects skill ID without slash", () => {
		expect(() => validateManifest({ ...validManifest, id: "acme-summarizer" })).toThrow();
	});

	it("rejects skill ID with uppercase", () => {
		expect(() => validateManifest({ ...validManifest, id: "Acme/Summarizer" })).toThrow();
	});

	it("rejects skill ID with special characters", () => {
		expect(() => validateManifest({ ...validManifest, id: "acme/summa rizer" })).toThrow();
	});

	it("rejects entryHash with wrong length", () => {
		expect(() => validateManifest({ ...validManifest, entryHash: "abcd" })).toThrow();
	});

	it("rejects entryHash with non-hex characters", () => {
		expect(() => validateManifest({ ...validManifest, entryHash: "g".repeat(64) })).toThrow();
	});

	it("rejects invalid permissions", () => {
		expect(() => validateManifest({ ...validManifest, permissions: ["fly_to_moon"] })).toThrow();
	});

	it("rejects missing required field (name)", () => {
		const { name, ...rest } = validManifest;
		expect(() => validateManifest(rest)).toThrow();
	});

	it("rejects missing required field (publisher)", () => {
		const { publisher, ...rest } = validManifest;
		expect(() => validateManifest(rest)).toThrow();
	});

	it("rejects empty name", () => {
		expect(() => validateManifest({ ...validManifest, name: "" })).toThrow();
	});

	it("rejects invalid version", () => {
		expect(() => validateManifest({ ...validManifest, version: 2 })).toThrow();
	});

	it("rejects invalid signedAt (not ISO 8601)", () => {
		expect(() => validateManifest({ ...validManifest, signedAt: "not-a-date" })).toThrow();
	});

	it("rejects invalid publicKey (wrong length)", () => {
		expect(() => validateManifest({ ...validManifest, publicKey: "abcd" })).toThrow();
	});
});

describe("createUnsignedManifest", () => {
	it("computes correct SHA-256 hash of entry source", () => {
		const source = 'export function run() { return "hello"; }';
		const expected = createHash("sha256").update(source).digest("hex");
		const manifest = createUnsignedManifest({
			id: "acme/greeter",
			name: "Greeter",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: source,
		});
		expect(manifest.entryHash).toBe(expected);
	});

	it("returns manifest with correct fields", () => {
		const manifest = createUnsignedManifest({
			id: "acme/greeter",
			name: "Greeter",
			publisher: "acme",
			permissions: ["llm_call", "tool_use"],
			entrySource: "code",
		});
		expect(manifest.version).toBe(1);
		expect(manifest.id).toBe("acme/greeter");
		expect(manifest.name).toBe("Greeter");
		expect(manifest.publisher).toBe("acme");
		expect(manifest.permissions).toEqual(["llm_call", "tool_use"]);
		expect(manifest).not.toHaveProperty("signature");
		expect(manifest).not.toHaveProperty("publicKey");
		expect(manifest).not.toHaveProperty("signedAt");
	});
});

describe("hashManifest", () => {
	it("produces deterministic output for the same manifest", () => {
		const manifest = {
			version: 1 as const,
			id: "acme/summarizer",
			name: "Summarizer",
			publisher: "acme",
			permissions: ["llm_call" as const],
			entryHash: "a".repeat(64),
			signedAt: "2026-03-15T12:00:00.000Z",
			publicKey: "cd".repeat(32),
		};
		const h1 = hashManifest(manifest);
		const h2 = hashManifest(manifest);
		expect(h1).toBe(h2);
	});

	it("excludes signature field from hash computation", () => {
		const base = {
			version: 1 as const,
			id: "acme/summarizer",
			name: "Summarizer",
			publisher: "acme",
			permissions: ["llm_call" as const],
			entryHash: "a".repeat(64),
			signedAt: "2026-03-15T12:00:00.000Z",
			publicKey: "cd".repeat(32),
		};
		const withSig = { ...base, signature: "ff".repeat(64) };
		// hashManifest only takes Omit<SkillManifest, "signature"> but we can
		// pass the full manifest and the signature field should be ignored
		const h1 = hashManifest(base);
		const h2 = hashManifest(withSig as Omit<typeof withSig, "signature">);
		expect(h1).toBe(h2);
	});
});
