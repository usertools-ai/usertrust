// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A failure that is NOT a lost race (the identity cannot be published: EACCES, ENOSPC,
 * EIO) must not leave the new private key behind: with an explicit --key-file the retry
 * would otherwise refuse as "existing". link(2) is forced to fail once, then allowed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAll, tmp } from "./fixtures.js";

let failNext = true;
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		linkSync: (...a: Parameters<typeof real.linkSync>) => {
			if (failNext) {
				failNext = false;
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			}
			return real.linkSync(...a);
		},
	};
});

import { initAnchorIdentity } from "../../../src/audit/anchor.js";

afterEach(() => {
	failNext = true;
	cleanupAll();
});

describe("a failure before the identity is published", () => {
	it("removes the key and the public copy it made, rethrows, and a retry with the same --key-file succeeds", () => {
		const root = tmp("anchor-fail-");
		const dir = tmp("anchor-fail-keys-");
		const keyFile = join(dir, "k.anchor.pem");
		expect(() => initAnchorIdentity(root, { keyFile })).toThrow(/EACCES/);
		expect(existsSync(keyFile)).toBe(false);
		expect(existsSync(join(dir, "k.anchor.pub.pem"))).toBe(false);
		const made = initAnchorIdentity(root, { keyFile });
		expect(readFileSync(made.keyFile, "utf-8")).toContain("PRIVATE KEY");
	});
});
