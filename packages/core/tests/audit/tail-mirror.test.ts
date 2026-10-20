// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit tail's classification, its acquisition and the stable read exist in BOTH packages: the
 * zero-dependency `usertrust-verify` cannot import core (AGENTS.md, the parity contract), and one
 * classifier must decide every verdict the two verifiers give. The copies are pinned byte for byte,
 * import lines aside, by the same rule as `anchor-verify.ts`'s.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const strip = (s: string): string =>
	s
		.split("\n")
		.filter((l) => !l.includes('from "'))
		.join("\n");

describe("mirror parity: the audit tail's modules are byte-identical across packages, import lines aside", () => {
	for (const file of ["tail-state.ts", "tail-read.ts", "stable-read.ts"]) {
		it(file, () => {
			const core = readFileSync(join(ROOT, "core", "src", "audit", file), "utf-8");
			const pkg = readFileSync(join(ROOT, "verify", "src", file), "utf-8");
			expect(strip(core)).toBe(strip(pkg));
		});
	}

	it("CONTROL: the rule sees a difference outside the import lines", () => {
		const core = readFileSync(join(ROOT, "core", "src", "audit", "tail-state.ts"), "utf-8");
		expect(strip(core)).not.toBe(strip(core.replace("FRESH", "FRESHER")));
	});
});
