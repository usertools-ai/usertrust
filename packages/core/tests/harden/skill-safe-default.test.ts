// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { expect, test } from "vitest";
import { TrustConfigSchema } from "../../src/shared/types.js";
import { createUnsignedManifest } from "../../src/supply-chain/manifest.js";
import { enforceSkillLoad } from "../../src/supply-chain/permissions.js";
import { generateKeyPair, signManifest } from "../../src/supply-chain/sign.js";

test("supply chain is fail-closed by default", () => {
	const config = TrustConfigSchema.parse({ budget: 1000 });
	expect(config.supplyChain.enabled).toBe(true);

	// An unregistered publisher's manifest is NOT auto-trusted under defaults.
	const keys = generateKeyPair();
	const signed = signManifest(
		createUnsignedManifest({
			id: "rando/x",
			name: "X",
			publisher: "rando",
			permissions: ["credential_access"],
			entrySource: "x",
		}),
		keys.privateKey,
	);
	expect(enforceSkillLoad(signed, config).valid).toBe(false);
});
