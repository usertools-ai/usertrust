// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Removing the identity's temporary name is best effort. Once the identity is published,
 * a failure there must not roll back the key the identity names; on a lost race it must
 * not replace the "already exists" message.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAll, tmp } from "./fixtures.js";

let race = false;
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		linkSync: (...a: Parameters<typeof real.linkSync>) => {
			if (race) throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
			return real.linkSync(...a);
		},
		unlinkSync: (...a: Parameters<typeof real.unlinkSync>) => {
			if (String(a[0]).includes(".new-")) {
				throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
			}
			return real.unlinkSync(...a);
		},
	};
});

import { initAnchorIdentity, readAnchorIdentity } from "../../../src/audit/anchor.js";

afterEach(() => {
	race = false;
	cleanupAll();
});

describe("a temp name that cannot be removed", () => {
	it("after the identity is published, keeps the identity AND the key it names", () => {
		const root = tmp("anchor-tmpname-");
		const keyFile = join(tmp("anchor-tmpname-keys-"), "k.anchor.pem");
		const made = initAnchorIdentity(root, { keyFile });
		expect(existsSync(keyFile)).toBe(true);
		expect(readAnchorIdentity(root)?.keyHistory?.[0]?.keyId).toBe(
			made.identity.keyHistory?.[0]?.keyId,
		);
	});

	it("on a lost race, still reports that the identity already exists", () => {
		const root = tmp("anchor-tmpname-race-");
		const keyFile = join(tmp("anchor-tmpname-k-"), "k.anchor.pem");
		race = true; // the link finds the identity already published by someone else
		expect(() => initAnchorIdentity(root, { keyFile })).toThrow(/already exists/);
		expect(existsSync(keyFile)).toBe(false);
	});
});
