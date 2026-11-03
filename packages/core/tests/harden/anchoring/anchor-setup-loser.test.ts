// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The race loser's cleanup: when the exclusive identity create reports EEXIST, the call
 * removes only the files IT wrote. link(2) is forced to fail here because a real race
 * cannot be steered from a single thread (the 6-process test covers the real thing).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAll, tmp } from "./fixtures.js";

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		linkSync: () => {
			throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
		},
	};
});

import { initAnchorIdentity } from "../../../src/audit/anchor.js";

afterEach(() => cleanupAll());

describe("race-loser cleanup", () => {
	it("removes the key and the public copy it wrote, and says the identity exists", () => {
		const root = tmp("anchor-loser-");
		const dir = tmp("anchor-loser-keys-");
		const keyFile = join(dir, "k.anchor.pem");
		expect(() => initAnchorIdentity(root, { keyFile })).toThrow(/already exists/);
		expect(existsSync(keyFile)).toBe(false);
		expect(existsSync(join(dir, "k.anchor.pub.pem"))).toBe(false);
	});

	it("leaves a pre-existing file at the .pub.pem path alone (it did not write it)", () => {
		const root = tmp("anchor-loser-");
		const dir = tmp("anchor-loser-keys-");
		const pub = join(dir, "k.anchor.pub.pem");
		writeFileSync(pub, "not a key, but not ours to remove\n");
		expect(() => initAnchorIdentity(root, { keyFile: join(dir, "k.anchor.pem") })).toThrow(
			/already exists/,
		);
		expect(existsSync(join(dir, "k.anchor.pem"))).toBe(false);
		expect(readFileSync(pub, "utf-8")).toBe("not a key, but not ours to remove\n");
	});
});
