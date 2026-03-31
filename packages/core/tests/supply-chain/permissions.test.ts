// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { SkillVerificationError } from "../../src/shared/errors.js";
import { TrustConfigSchema } from "../../src/shared/types.js";
import type { SkillManifest, TrustConfig } from "../../src/shared/types.js";
import { createUnsignedManifest } from "../../src/supply-chain/manifest.js";
import { checkPermissions, enforceSkillLoad } from "../../src/supply-chain/permissions.js";
import { generateKeyPair, signManifest, verifySignature } from "../../src/supply-chain/sign.js";

/** Helper: produce a valid signed manifest. */
function makeSignedManifest(
	overrides: Partial<{
		id: string;
		name: string;
		publisher: string;
		permissions: string[];
		entrySource: string;
	}> = {},
): { manifest: SkillManifest; publicKey: string; privateKey: string } {
	const keys = generateKeyPair();
	const unsigned = createUnsignedManifest({
		id: overrides.id ?? "acme/test",
		name: overrides.name ?? "Test",
		publisher: overrides.publisher ?? "acme",
		permissions: (overrides.permissions ?? ["llm_call"]) as SkillManifest["permissions"],
		entrySource: overrides.entrySource ?? "export default {}",
	});
	const manifest = signManifest(unsigned, keys.privateKey);
	return { manifest, ...keys };
}

/** Helper: build a TrustConfig with supply chain overrides. */
function makeConfig(overrides: Partial<TrustConfig["supplyChain"]> = {}): TrustConfig {
	return TrustConfigSchema.parse({
		budget: 1000,
		supplyChain: {
			enabled: true,
			trustedPublishers: [],
			allowedPermissions: ["llm_call", "tool_use", "file_read"],
			requireSignature: true,
			...overrides,
		},
	});
}

describe("checkPermissions", () => {
	it("allows all when permissions are subset of allowed", () => {
		const { manifest } = makeSignedManifest({ permissions: ["llm_call", "file_read"] });
		const config = makeConfig();
		const result = checkPermissions(manifest, config);
		expect(result.permissionsAllowed).toBe(true);
		expect(result.deniedPermissions).toEqual([]);
	});

	it("denies when requesting disallowed permission", () => {
		const { manifest } = makeSignedManifest({ permissions: ["shell_command"] });
		const config = makeConfig();
		const result = checkPermissions(manifest, config);
		expect(result.permissionsAllowed).toBe(false);
	});

	it("returns denied list", () => {
		const { manifest } = makeSignedManifest({
			permissions: ["llm_call", "shell_command", "network_access"],
		});
		const config = makeConfig();
		const result = checkPermissions(manifest, config);
		expect(result.deniedPermissions).toContain("shell_command");
		expect(result.deniedPermissions).toContain("network_access");
		expect(result.deniedPermissions).not.toContain("llm_call");
	});

	it("trusted publisher bypasses permission restrictions", () => {
		const { manifest } = makeSignedManifest({
			publisher: "trusted-co",
			permissions: ["shell_command", "credential_access"],
		});
		const config = makeConfig({ trustedPublishers: ["trusted-co"] });
		const result = checkPermissions(manifest, config);
		expect(result.permissionsAllowed).toBe(true);
		expect(result.deniedPermissions).toEqual([]);
	});
});

describe("enforceSkillLoad", () => {
	it("succeeds for valid signed manifest with allowed permissions", () => {
		const { manifest } = makeSignedManifest({ permissions: ["llm_call"] });
		const config = makeConfig();
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(true);
		expect(result.permissionsAllowed).toBe(true);
	});

	it("fails for invalid signature", () => {
		const { manifest } = makeSignedManifest();
		const tampered = { ...manifest, signature: "ff".repeat(64) };
		const config = makeConfig();
		const result = enforceSkillLoad(tampered, config);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid manifest signature");
	});

	it("fails for disallowed permissions even with valid signature", () => {
		const { manifest } = makeSignedManifest({ permissions: ["shell_command"] });
		const config = makeConfig();
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Denied permissions");
	});

	it("succeeds when publisher is trusted (all permissions allowed)", () => {
		const { manifest } = makeSignedManifest({
			publisher: "trusted-co",
			permissions: ["shell_command", "credential_access"],
		});
		const config = makeConfig({ trustedPublishers: ["trusted-co"] });
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(true);
		expect(result.permissionsAllowed).toBe(true);
	});

	it("with requireSignature:false skips signature check for untrusted publisher", () => {
		const { manifest } = makeSignedManifest();
		const tampered = { ...manifest, signature: "ff".repeat(64) };
		const config = makeConfig({ requireSignature: false });
		const result = enforceSkillLoad(tampered, config);
		// Should still pass because signature check is skipped for untrusted publishers
		expect(result.valid).toBe(true);
	});

	it("with empty trustedPublishers list enforces permissions", () => {
		const { manifest } = makeSignedManifest({ permissions: ["shell_command"] });
		const config = makeConfig({ trustedPublishers: [] });
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(false);
		expect(result.deniedPermissions).toContain("shell_command");
	});

	it("rejects manifest with schema validation errors", () => {
		const badManifest = {
			version: 1,
			id: "INVALID",
			name: "Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entryHash: "a".repeat(64),
			signedAt: "2026-03-15T12:00:00.000Z",
			signature: "ab".repeat(64),
			publicKey: "cd".repeat(32),
		} as unknown as SkillManifest;
		const config = makeConfig();
		expect(() => enforceSkillLoad(badManifest, config)).toThrow(SkillVerificationError);
	});

	it("untrusted publisher with restricted permissions blocked", () => {
		const { manifest } = makeSignedManifest({
			publisher: "untrusted",
			permissions: ["credential_access"],
		});
		const config = makeConfig({ trustedPublishers: ["acme"] });
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(false);
		expect(result.deniedPermissions).toContain("credential_access");
	});

	it("trusted publisher with any permissions allowed", () => {
		const { manifest } = makeSignedManifest({
			publisher: "acme",
			permissions: ["credential_access", "network_access", "shell_command"],
		});
		const config = makeConfig({ trustedPublishers: ["acme"] });
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(true);
		expect(result.permissionsAllowed).toBe(true);
		expect(result.deniedPermissions).toEqual([]);
	});

	it("config defaults work (enabled:false, default allowed permissions)", () => {
		const config = TrustConfigSchema.parse({ budget: 1000 });
		expect(config.supplyChain.enabled).toBe(false);
		expect(config.supplyChain.allowedPermissions).toEqual(["llm_call", "tool_use", "file_read"]);
		expect(config.supplyChain.requireSignature).toBe(true);
		expect(config.supplyChain.trustedPublishers).toEqual([]);
	});
});

describe("full pipeline", () => {
	it("generate keys -> create manifest -> sign -> enforce -> passes", () => {
		const keys = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/pipeline",
			name: "Pipeline Test",
			publisher: "acme",
			permissions: ["llm_call", "file_read"],
			entrySource: 'export function run() { return "ok"; }',
		});
		const signed = signManifest(unsigned, keys.privateKey);
		const config = makeConfig();
		const result = enforceSkillLoad(signed, config);
		expect(result.valid).toBe(true);
		expect(result.permissionsAllowed).toBe(true);
		expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("tampered manifest -> enforce -> fails", () => {
		const keys = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/pipeline",
			name: "Pipeline Test",
			publisher: "acme",
			permissions: ["llm_call"],
			entrySource: 'export function run() { return "ok"; }',
		});
		const signed = signManifest(unsigned, keys.privateKey);
		const tampered = { ...signed, name: "Evil Plugin" };
		const config = makeConfig();
		const result = enforceSkillLoad(tampered, config);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid manifest signature");
	});
});

describe("enforceSkillLoad — enabled guard", () => {
	it("returns valid when supplyChain.enabled is false", () => {
		const { manifest } = makeSignedManifest();
		const config = makeConfig({ enabled: false });
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(true);
		expect(result.permissionsAllowed).toBe(true);
		expect(result.deniedPermissions).toEqual([]);
		expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("enforceSkillLoad — trusted publisher forgery prevention", () => {
	it("requires valid signature for trusted publisher even with requireSignature:false", () => {
		const { manifest } = makeSignedManifest({ publisher: "trusted-co" });
		const tampered = { ...manifest, signature: "ff".repeat(64) };
		const config = makeConfig({
			requireSignature: false,
			trustedPublishers: ["trusted-co"],
		});
		const result = enforceSkillLoad(tampered, config);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid manifest signature");
	});

	it("allows trusted publisher with valid signature and requireSignature:false", () => {
		const { manifest } = makeSignedManifest({
			publisher: "trusted-co",
			permissions: ["shell_command", "credential_access"],
		});
		const config = makeConfig({
			requireSignature: false,
			trustedPublishers: ["trusted-co"],
		});
		const result = enforceSkillLoad(manifest, config);
		expect(result.valid).toBe(true);
		expect(result.permissionsAllowed).toBe(true);
	});
});

describe("verifySignature — malformed input", () => {
	it("returns false for malformed signature (too short)", () => {
		const { manifest } = makeSignedManifest();
		const malformed = { ...manifest, signature: "aa" };
		expect(verifySignature(malformed)).toBe(false);
	});

	it("returns false for empty signature", () => {
		const { manifest } = makeSignedManifest();
		const malformed = { ...manifest, signature: "" };
		expect(verifySignature(malformed)).toBe(false);
	});
});
