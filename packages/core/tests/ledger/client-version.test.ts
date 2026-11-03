// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isExactVersion, resolvedClientVersion } from "../../src/ledger/client-version.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** A project directory whose `node_modules` holds the given tigerbeetle-node copies (path under the project -> version). */
function project(copies: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "client-version-"));
	for (const [dir, version] of Object.entries(copies)) {
		const at = join(root, dir);
		mkdirSync(at, { recursive: true });
		writeFileSync(join(at, "package.json"), JSON.stringify({ name: "tigerbeetle-node", version }));
	}
	return root;
}

/** The pinned server release the CI job downloads, read from its `TIGERBEETLE_VERSION` line. */
function ciServerVersion(workflow: string): string | undefined {
	return workflow.match(/^\s*TIGERBEETLE_VERSION:\s*"([^"]+)"/m)?.[1];
}

describe("the client version a project resolves", () => {
	it("is read from the project's node_modules, not from the caller's own copy", () => {
		// The positive control: this test process carries its own tigerbeetle-node, so a reader that
		// resolved from the caller would report that version, never the fixture's.
		const own = JSON.parse(
			readFileSync(join(REPO_ROOT, "node_modules", "tigerbeetle-node", "package.json"), "utf-8"),
		) as { version: string };
		const fixture = own.version === "0.0.1" ? "0.0.2" : "0.0.1";
		const root = project({ "node_modules/tigerbeetle-node": fixture });
		expect(resolvedClientVersion(root)).toBe(fixture);
		expect(resolvedClientVersion(root)).not.toBe(own.version);
	});

	it("prefers the copy nested under the project's usertrust, the one usertrust itself would load", () => {
		const root = project({
			"node_modules/tigerbeetle-node": "0.17.8",
			"node_modules/usertrust/node_modules/tigerbeetle-node": "0.17.9",
		});
		expect(resolvedClientVersion(root)).toBe("0.17.9");
	});

	it("finds a copy hoisted into a parent directory's node_modules, as Node would", () => {
		const outer = project({ "node_modules/tigerbeetle-node": "0.17.7" });
		const inner = join(outer, "packages", "app");
		mkdirSync(inner, { recursive: true });
		expect(resolvedClientVersion(inner)).toBe("0.17.7");
	});

	it("says nothing when no copy is installed there yet, or the file is not a tigerbeetle-node package", () => {
		expect(
			resolvedClientVersion(mkdtempSync(join(tmpdir(), "client-version-empty-"))),
		).toBeUndefined();
		const root = mkdtempSync(join(tmpdir(), "client-version-wrong-"));
		mkdirSync(join(root, "node_modules", "tigerbeetle-node"), { recursive: true });
		writeFileSync(
			join(root, "node_modules", "tigerbeetle-node", "package.json"),
			JSON.stringify({ name: "something-else", version: "9.9.9" }),
		);
		expect(resolvedClientVersion(root)).toBeUndefined();
	});
});

describe("the pinned TigerBeetle client", () => {
	const manifest = JSON.parse(
		readFileSync(join(REPO_ROOT, "packages/core/package.json"), "utf-8"),
	) as {
		dependencies: Record<string, string>;
	};
	const pinned = manifest.dependencies["tigerbeetle-node"] ?? "";

	it("is an exact version in core's dependencies, never a range", () => {
		expect(isExactVersion(pinned), `tigerbeetle-node is "${pinned}"`).toBe(true);
		// the control: the checker refuses each way a range is written
		for (const range of ["^0.17.9", "~0.17.9", ">=0.17.9", "0.17", "latest", "0.17.x", "*"]) {
			expect(isExactVersion(range), range).toBe(false);
		}
	});

	it("is the server release CI downloads: client and server move together", () => {
		const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf-8");
		expect(ciServerVersion(workflow)).toBe(pinned);
		// the control: a workflow naming another release is seen as different
		expect(
			ciServerVersion(
				workflow.replace(`TIGERBEETLE_VERSION: "${pinned}"`, 'TIGERBEETLE_VERSION: "0.17.10"'),
			),
		).not.toBe(pinned);
	});

	it("is the version installed in this repository's own lockfile tree", () => {
		const installed = JSON.parse(
			readFileSync(join(REPO_ROOT, "node_modules", "tigerbeetle-node", "package.json"), "utf-8"),
		) as { version: string };
		expect(installed.version).toBe(pinned);
	});
});
