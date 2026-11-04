// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The receipt format reserves an `anchorEvidence` member for an external transparency anchor provided as a service. This
 * package never sets it: no source file outside the receipt verifier's read side mentions the member, and the only mentions
 * of the removed Rekor feature are the two refusals of an old bundle's `rekorReceipts` field.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = join(import.meta.dirname, "..", "..", "..");

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name !== "node_modules" && name !== "dist") sources(full, out);
		} else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
	}
	return out;
}

/** Every source file under each package's `src`, as `package/path` mapped to its text. */
function allSources(): Map<string, string> {
	const files = new Map<string, string>();
	for (const pkg of readdirSync(PACKAGES)) {
		const src = join(PACKAGES, pkg, "src");
		try {
			if (!statSync(src).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const file of sources(src)) {
			files.set(relative(PACKAGES, file), readFileSync(file, "utf-8"));
		}
	}
	return files;
}

describe("no source in this package writes transparency-anchor evidence", () => {
	const files = allSources();

	it("the scan sees the sources it is meant to guard (positive control)", () => {
		expect(files.size).toBeGreaterThan(50);
		expect(files.has(join("verify", "src", "receipt-verify.ts"))).toBe(true);
	});

	it("only the receipt verifier's read side mentions `anchorEvidence`", () => {
		const hits = [...files].filter(([, text]) => text.includes("anchorEvidence")).map(([f]) => f);
		expect(hits.sort()).toEqual([
			join("verify", "src", "receipt-cli.ts"),
			join("verify", "src", "receipt-verify.ts"),
		]);
	});

	it("the removed Rekor feature is mentioned only where an old bundle is refused", () => {
		const hits = [...files].filter(([, text]) => /rekor/i.test(text)).map(([f]) => f);
		expect(hits.sort()).toEqual([
			join("core", "src", "cli", "verify.ts"),
			join("verify", "src", "cli.ts"),
		]);
	});
});
