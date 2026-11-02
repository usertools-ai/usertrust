// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The native TigerBeetle client is pinned to ONE version, with no range.
 *
 * A client talks to a server of a release it accepts, and an evicted client cannot be released: a
 * caret range lets an install pick up a client the cluster the user formatted refuses, and the first
 * sign is a hang or a process that will not exit. The ledger this package fetches and the client it
 * bundles are meant to be one release (0.17.9), so the dependency is exact and the lockfile agrees.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

interface Manifest {
	dependencies?: Record<string, string>;
}
interface Lock {
	packages: Record<string, Manifest & { version?: string }>;
}

describe("tigerbeetle-node is pinned exactly", () => {
	const wanted = "0.17.9";

	it("packages/core/package.json names one version, not a range", () => {
		const range = (read("packages/core/package.json") as Manifest).dependencies?.[
			"tigerbeetle-node"
		];
		expect(range).toBe(wanted);
		expect(range).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("the lockfile asks for the same version, and installs it", () => {
		const lock = read("package-lock.json") as Lock;
		expect(lock.packages["packages/core"]?.dependencies?.["tigerbeetle-node"]).toBe(wanted);
		expect(lock.packages["node_modules/tigerbeetle-node"]?.version).toBe(wanted);
	});

	it("positive control: a caret range is not an exact pin", () => {
		expect("^0.17.9").not.toMatch(/^\d+\.\d+\.\d+$/);
	});
});
