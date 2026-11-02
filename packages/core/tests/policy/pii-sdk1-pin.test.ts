// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `pii-content-sdk-types.test-d.ts` compares the PII content schema with the installed SDKs'
 * request types: a provider request field the schema does not name fails the compile (AGENTS.md).
 * On the 0.116 floor that file compiles clean. On the 1.x line (the `sdk-1x` job) the schema lacks
 * seven of the 1.3.0 additions. That is a known gap, and under `pii: "redact"` PII in an unlisted
 * field refuses the call (LIMITATIONS section 11), so it fails closed.
 *
 * The 1.x leg does NOT exclude the file. It compiles the whole core type-test project and requires
 * the diagnostics to be EXACTLY the seven pinned in `pii-sdk1-known-diagnostics.json`, by assertion
 * name, file, line, column, code and message: any other diagnostic, and any pinned one that is gone,
 * fails. The rule therefore stays live on the line the README installs. Classifying the seven
 * fields removes the pin.
 *
 * The pin works per assertion, so it cannot see a NEW key inside one of the seven that already
 * fail: the diagnostic would not change. `pii-sdk1-exact-gaps.sdk1-d.ts` (compiled by the same 1.x
 * project) states each failing assertion's exact key sets, so a key the SDK adds changes a set and
 * fails the compile. The second positive control below proves that.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../..");
const is1x = process.env.USERTRUST_SDK_LINE === "1x";

interface Diagnostic {
	readonly assertion: string;
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly code: string;
	readonly message: string;
}

const pinFile = JSON.parse(
	readFileSync(join(import.meta.dirname, "pii-sdk1-known-diagnostics.json"), "utf8"),
) as { diagnostics: Diagnostic[] };
const PIN: readonly Diagnostic[] = pinFile.diagnostics;

const key = (d: Diagnostic): string =>
	`${d.file}:${d.line}:${d.column} ${d.code} ${d.assertion} ${d.message}`;

/** The `export type X = Assert<` that a diagnostic at `line` falls inside. */
const assertionAt = (file: string, line: number): string => {
	const lines = readFileSync(join(root, file), "utf8").split("\n");
	for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
		const m = /^export type (\w+) = Assert</.exec(lines[i] ?? "");
		if (m) return m[1] as string;
	}
	return "(outside any assertion)";
};

/** Parse `tsc --pretty false` output; continuation lines (indented) are not diagnostics. */
const parse = (out: string): Diagnostic[] => {
	const found: Diagnostic[] = [];
	for (const raw of out.split("\n")) {
		const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
		if (!m) continue;
		const file = relative(root, resolve(root, m[1] as string));
		const line = Number(m[2]);
		found.push({
			assertion: assertionAt(file, line),
			file,
			line,
			column: Number(m[3]),
			code: m[4] as string,
			message: (m[5] as string).trim(),
		});
	}
	return found;
};

/** What the compile produced that the pin does not list, and what the pin lists that it did not. */
const compare = (
	actual: readonly Diagnostic[],
	pin: readonly Diagnostic[],
): { unexpected: string[]; missing: string[] } => {
	const have = new Set(actual.map(key));
	const want = new Set(pin.map(key));
	return {
		unexpected: [...have].filter((k) => !want.has(k)).sort(),
		missing: [...want].filter((k) => !have.has(k)).sort(),
	};
};

const tsc = (project: string): Diagnostic[] => {
	const r = spawnSync(
		process.execPath,
		[join(root, "node_modules/typescript/bin/tsc"), "-p", project, "--pretty", "false"],
		{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (r.error) throw r.error;
	return parse(`${r.stdout}\n${r.stderr}`);
};

describe("the pin file itself", () => {
	it("pins seven diagnostics, each inside a named assertion that still exists in the type test", () => {
		expect(PIN).toHaveLength(7);
		for (const d of PIN) {
			expect(d.file).toBe("packages/core/tests/policy/pii-content-sdk-types.test-d.ts");
			expect(d.assertion, key(d)).not.toBe("(outside any assertion)");
		}
		expect(new Set(PIN.map(key)).size).toBe(7);
	});

	it("names the assertion each location sits in, as the type test has it today", () => {
		for (const d of PIN) expect(assertionAt(d.file, d.line), key(d)).toBe(d.assertion);
	});
});

describe("compare: the pin is exact in both directions", () => {
	it("an extra diagnostic the pin does not list is unexpected", () => {
		const extra: Diagnostic = {
			assertion: "ChatRoles",
			file: PIN[0]?.file as string,
			line: 297,
			column: 2,
			code: "TS2344",
			message: "Type 'false' does not satisfy the constraint 'true'.",
		};
		const r = compare([...PIN, extra], PIN);
		expect(r.unexpected).toEqual([key(extra)]);
		expect(r.missing).toEqual([]);
	});

	it("a pinned diagnostic that no longer occurs (a stale pin) is missing", () => {
		const r = compare(PIN.slice(1), PIN);
		expect(r.unexpected).toEqual([]);
		expect(r.missing).toEqual([key(PIN[0] as Diagnostic)]);
	});

	it("a diagnostic that moved a line is both: the old one missing, the new one unexpected", () => {
		const moved = { ...(PIN[0] as Diagnostic), line: (PIN[0] as Diagnostic).line + 1 };
		const r = compare([moved, ...PIN.slice(1)], PIN);
		expect(r.unexpected).toEqual([key(moved)]);
		expect(r.missing).toEqual([key(PIN[0] as Diagnostic)]);
	});

	it("the exact pin passes", () => {
		expect(compare(PIN, PIN)).toEqual({ unexpected: [], missing: [] });
	});
});

describe.skipIf(!is1x)("on the 1.x line: the real compile", () => {
	it("the core type-test project produces exactly the pinned diagnostics", () => {
		const r = compare(tsc("packages/core/tsconfig.type-tests.sdk1.json"), PIN);
		expect(r).toEqual({ unexpected: [], missing: [] });
		// timing: 180 s budget for one tsc compile of the core type-test project; each took 1.3 s on a 14-core test host (3 runs, 1.28-1.33 s), so the bound is over 100x the measured time.
	}, 180_000);

	it("positive control: one more request field the schema does not name turns the leg red", () => {
		// A temp project beside nothing the repo owns: it extends the real one and adds the fixture.
		const dir = mkdtempSync(join(tmpdir(), "pii-sdk1-control-"));
		const project = join(dir, "tsconfig.json");
		writeFileSync(
			project,
			JSON.stringify({
				extends: join(root, "packages/core/tsconfig.type-tests.json"),
				include: [
					join(root, "packages/core/tests/**/*.test-d.ts"),
					join(root, "packages/core/tests/policy/fixtures/pii-sdk1-extra-field.fixture-d.ts"),
				],
			}),
		);
		const r = compare(tsc(project), PIN);
		expect(r.missing).toEqual([]);
		expect(r.unexpected).toHaveLength(1);
		expect(r.unexpected[0]).toContain("UnlistedRequestField");
		// timing: 180 s budget for one tsc compile of the core type-test project; each took 1.3 s on a 14-core test host (3 runs, 1.28-1.33 s), so the bound is over 100x the measured time.
	}, 180_000);

	it("second positive control: a new key INSIDE an already-failing pinned assertion turns the leg red", () => {
		// The pin alone cannot see this: the assertion already fails, with the same line and column.
		// `pii-sdk1-exact-gaps.sdk1-d.ts` states each failing assertion's exact key set, and the fixture
		// is that file's Anthropic request assertion with `thread` left out, as if the SDK had just added it.
		const dir = mkdtempSync(join(tmpdir(), "pii-sdk1-control-key-"));
		const project = join(dir, "tsconfig.json");
		writeFileSync(
			project,
			JSON.stringify({
				extends: join(root, "packages/core/tsconfig.type-tests.json"),
				include: [
					join(root, "packages/core/tests/**/*.test-d.ts"),
					join(root, "packages/core/tests/policy/pii-sdk1-exact-gaps.sdk1-d.ts"),
					join(root, "packages/core/tests/policy/fixtures/pii-sdk1-extra-key.fixture-d.ts"),
				],
			}),
		);
		const r = compare(tsc(project), PIN);
		expect(r.missing).toEqual([]);
		expect(r.unexpected).toHaveLength(1);
		expect(r.unexpected[0]).toContain("UnaccountedKeyInsidePinnedAssertion");
		// timing: 180 s budget for one tsc compile of the core type-test project; each took 1.3 s on a 14-core test host (3 runs, 1.28-1.33 s), so the bound is over 100x the measured time.
	}, 180_000);
});
