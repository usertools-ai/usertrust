// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// npm pack cannot include a file from outside a package directory, so each published
// package carries a committed copy of the root LICENSE and NOTICE. The root NOTICE holds
// attribution that Apache-2.0 section 4(d) requires to travel with every redistribution,
// so the copies must stay byte-identical to the root files.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PUBLISHED = ["core", "verify", "openclaw", "server", "acs-adapter", "ui"] as const;
const SHIPPED = ["LICENSE", "NOTICE"] as const;

describe("published packages ship the root LICENSE and NOTICE", () => {
	for (const dir of PUBLISHED) {
		describe(`packages/${dir}`, () => {
			for (const file of SHIPPED) {
				it(`${file} is byte-identical to the root ${file}`, () => {
					const root = readFileSync(join(ROOT, file));
					const copy = readFileSync(join(ROOT, "packages", dir, file));
					expect(
						copy.equals(root),
						`packages/${dir}/${file} differs from the root ${file}: copy it again`,
					).toBe(true);
				});
			}

			it("lists LICENSE and NOTICE in its files allow-list", () => {
				const pkg = JSON.parse(
					readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
				) as {
					files?: string[];
				};
				expect(pkg.files, `packages/${dir} files allow-list`).toEqual(
					expect.arrayContaining([...SHIPPED]),
				);
			});
		});
	}
});
