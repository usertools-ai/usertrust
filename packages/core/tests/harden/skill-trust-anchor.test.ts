// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { expect, test } from "vitest";
import { TrustConfigSchema } from "../../src/shared/types.js";
import { createUnsignedManifest } from "../../src/supply-chain/manifest.js";
import { enforceSkillLoad } from "../../src/supply-chain/permissions.js";
import { generateKeyPair, signManifest } from "../../src/supply-chain/sign.js";

test("attacker self-signing as a trusted publisher is rejected", () => {
	const legit = generateKeyPair(); // operator-registered key
	const attacker = generateKeyPair(); // attacker's own key

	const forged = signManifest(
		createUnsignedManifest({
			id: "trusted-co/evil",
			name: "Evil",
			publisher: "trusted-co",
			permissions: ["credential_access", "shell_command"],
			entrySource: "export const run = () => {}",
		}),
		attacker.privateKey,
	);

	const config = TrustConfigSchema.parse({
		budget: 1000,
		supplyChain: {
			enabled: true,
			requireSignature: true,
			trustedPublishers: ["trusted-co"],
			publisherKeys: { "trusted-co": [legit.publicKey] }, // attacker key NOT registered
		},
	});

	const result = enforceSkillLoad(forged, config);
	expect(result.valid).toBe(false);
	expect(result.error).toMatch(/signature|registered/i);
});

test("legit manifest signed with the registered key passes", () => {
	const legit = generateKeyPair();
	const signed = signManifest(
		createUnsignedManifest({
			id: "trusted-co/ok",
			name: "OK",
			publisher: "trusted-co",
			permissions: ["llm_call"],
			entrySource: "export const run = () => {}",
		}),
		legit.privateKey,
	);
	const config = TrustConfigSchema.parse({
		budget: 1000,
		supplyChain: {
			enabled: true,
			requireSignature: true,
			publisherKeys: { "trusted-co": [signed.publicKey] },
		},
	});
	expect(enforceSkillLoad(signed, config).valid).toBe(true);
});

test("valid signature with an UNREGISTERED publisher (no key) is rejected under requireSignature", () => {
	const keys = generateKeyPair();
	const signed = signManifest(
		createUnsignedManifest({
			id: "rando/x",
			name: "X",
			publisher: "rando",
			permissions: ["llm_call"],
			entrySource: "export const run = () => {}",
		}),
		keys.privateKey,
	);
	// requireSignature is true by default; publisher "rando" has no registered key.
	const config = TrustConfigSchema.parse({
		budget: 1000,
		supplyChain: { enabled: true, requireSignature: true },
	});
	const result = enforceSkillLoad(signed, config);
	expect(result.valid).toBe(false);
	expect(result.error).toMatch(/registered/i);
});
