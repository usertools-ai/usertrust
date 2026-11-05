// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The release manifest is the one place the TigerBeetle server version and its digests live. These
 * tests tie it to everything else that names the version: the exact `tigerbeetle-node` pin, the client
 * that is installed, and the CI job that downloads the server.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	MANIFEST,
	MAX_BINARY_BYTES,
	MAX_DOWNLOAD_BYTES,
} from "../../src/ledger/tigerbeetle-install.js";

const here = dirname(fileURLToPath(import.meta.url));
const corePackage = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as {
	dependencies: Record<string, string>;
};
const repoRoot = join(here, "../../../..");

describe("tigerbeetle-release.json", () => {
	it("pins the same version as the exact tigerbeetle-node dependency (no range)", () => {
		const pin = corePackage.dependencies["tigerbeetle-node"];
		expect(pin).toBe(MANIFEST.version);
		expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("names the version of the tigerbeetle-node client that is actually installed", () => {
		const installed = JSON.parse(
			readFileSync(join(repoRoot, "node_modules", "tigerbeetle-node", "package.json"), "utf8"),
		) as { version: string };
		expect(installed.version).toBe(MANIFEST.version);
	});

	it("has exactly the five supported platforms, each with a full-length sha256 and sane sizes", () => {
		expect(Object.keys(MANIFEST.assets).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-x64",
		]);
		for (const [key, a] of Object.entries(MANIFEST.assets)) {
			expect(a.sha256, key).toMatch(/^[0-9a-f]{64}$/);
			expect(a.bytes, key).toBeGreaterThan(0);
			expect(a.bytes, key).toBeLessThanOrEqual(MAX_DOWNLOAD_BYTES);
			expect(a.entryBytes, key).toBeGreaterThan(a.bytes / 2);
			expect(a.entryBytes, key).toBeLessThanOrEqual(MAX_BINARY_BYTES);
			expect(a.entry, key).toBe(key.startsWith("win32") ? "tigerbeetle.exe" : "tigerbeetle");
			expect(a.file, key).toMatch(/^tigerbeetle-[a-z0-9_-]+\.zip$/);
		}
	});

	it("downloads over https from the tigerbeetle GitHub release, and the two macOS keys share one universal file", () => {
		expect(MANIFEST.baseUrl).toBe("https://github.com/tigerbeetle/tigerbeetle/releases/download");
		expect(MANIFEST.assets["darwin-arm64"]).toEqual(MANIFEST.assets["darwin-x64"]);
	});

	it("is what ci.yml installs: the tb-integration job reads its version and digest from the manifest, with no copy of either", () => {
		const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
		expect(ci).toContain("tigerbeetle-release.json");
		expect(ci).not.toContain(MANIFEST.assets["linux-x64"]?.sha256);
		expect(ci).not.toMatch(/TIGERBEETLE_VERSION: "\d/);
	});
});
