// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// npm pack cannot include a file from outside a package directory, so each package that npm can
// publish carries a committed copy of the root LICENSE and NOTICE. The root NOTICE holds
// attribution that Apache-2.0 section 4(d) requires to travel with compiled (derivative) packages,
// so the copies must stay byte-identical to the root files.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PACKAGES = join(ROOT, "packages");
const SHIPPED = ["LICENSE", "NOTICE"] as const;

interface Manifest {
	private?: boolean;
	files?: string[];
}

function manifestOf(dir: string): Manifest {
	return JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8")) as Manifest;
}

// The workspace packages whose manifest does not say "private": true. npm can publish these, so
// each one must ship the root files.
function publishablePackageDirs(): string[] {
	return readdirSync(PACKAGES, { withFileTypes: true })
		.filter(
			(entry) => entry.isDirectory() && existsSync(join(PACKAGES, entry.name, "package.json")),
		)
		.map((entry) => entry.name)
		.filter((dir) => manifestOf(dir).private !== true)
		.sort();
}

const PUBLISHED = publishablePackageDirs();

describe("publishable packages ship the root LICENSE and NOTICE", () => {
	it("derives a non-empty list of publishable packages that includes core", () => {
		expect(PUBLISHED.length, "publishable packages").toBeGreaterThan(0);
		expect(PUBLISHED).toContain("core");
	});

	it("excludes a private package", () => {
		// claude-code-plugin is private in its own manifest, so it must not be in the list.
		expect(manifestOf("claude-code-plugin").private).toBe(true);
		expect(PUBLISHED).not.toContain("claude-code-plugin");
	});

	it("checks every publishable package, so none drops out of the list", () => {
		// The rows below are built from PUBLISHED. This compares it with a fresh derivation, so a
		// hard-coded list that omits a publishable package (monte-cristo, say) fails here.
		expect(PUBLISHED).toEqual(publishablePackageDirs());
	});

	for (const dir of PUBLISHED) {
		describe(`packages/${dir}`, () => {
			for (const file of SHIPPED) {
				it(`${file} is byte-identical to the root ${file}`, () => {
					const root = readFileSync(join(ROOT, file));
					const copy = readFileSync(join(PACKAGES, dir, file));
					expect(
						copy.equals(root),
						`packages/${dir}/${file} differs from the root ${file}: copy it again`,
					).toBe(true);
				});
			}

			it("lists LICENSE and NOTICE in its files allow-list", () => {
				expect(manifestOf(dir).files, `packages/${dir} files allow-list`).toEqual(
					expect.arrayContaining([...SHIPPED]),
				);
			});
		});
	}
});
