// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ONE decider for "does this model have a 1-hour cache-write tier?" (#203).
 *
 * The question has one answer, `supportsCacheWrite1h` in ledger/pricing.ts, and every
 * consumer must ask it through that predicate or through a wrapper that does
 * (`holdInputRate`, `holdCacheWriteRate`, `withSupported1hTier`, `supported1hTokens`,
 * `scopedAnomalyCostCalculator`). Six review rounds each found another consumer that
 * had decided it for itself (a hold, a settle, the anomaly pricing, the pricing CLI,
 * the OpenShell gate, the fleet renderer), and each disagreement under- or over-charged
 * a successful call. This test makes the class converge instead of being enumerated:
 *
 *  RULE 1. The tier-DECIDING identifiers (the per-model 1-hour rate and the functions
 *          that read or derive it) may appear, outside comments, only in the files on
 *          the allowlist below. A new file that reads `cacheWrite1hPer1k` fails until a
 *          human adds it here on purpose.
 *  RULE 2. A file that passes a 1-hour token count into a cost function
 *          (`costFromRates` / `costFromRatesUnfloored`) must also route that count
 *          through the predicate (`withSupported1hTier` or `supported1hTokens`), unless
 *          it is on the allowlist with its reason.
 *  RULE 3. Display code that calls `effectiveCacheWrite1hRate` must guard it with
 *          `supportsCacheWrite1h` in the same file.
 *
 * The scanner is a pure function over {path: source}; the positive controls below plant
 * a direct per-model check (and a raw 1-hour count into a cost function) and require it
 * to turn the scan red, so a scanner that stops seeing anything cannot pass silently.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Identifiers that DECIDE the tier: they read the per-model rate or derive it. */
const DECIDERS = ["cacheWrite1hPer1k", "effectiveCacheWrite1hRate", "hold1hWriteRate"] as const;

/** Files allowed to mention each decider, with why. Anything else is a second decider. */
const DECIDER_ALLOWLIST: Record<string, readonly string[]> = {
	// The definitions: the row field, the predicate's own reads, the resolver, the hold helpers.
	"packages/core/src/ledger/pricing.ts": [...DECIDERS],
	// The config schema for an operator's customRates row (declares the field, decides nothing).
	"packages/core/src/shared/types.ts": ["cacheWrite1hPer1k"],
	// The `usertrust init` wizard writes / shows an operator-set 1-hour rate.
	"packages/core/src/cli/init.ts": ["cacheWrite1hPer1k"],
	// The pricing CLI shows the resolved rate, guarded by supportsCacheWrite1h (RULE 3).
	"packages/core/src/cli/pricing.ts": ["effectiveCacheWrite1hRate"],
	// The gate validates the operator's override like the other cache rates (a key list).
	"packages/openshell/src/gate.ts": ["cacheWrite1hPer1k"],
};

/**
 * RULE 2 exemptions: only the file that DEFINES the cost functions. Every consumer,
 * OpenShell's settlement included, routes a 1-hour count through the predicate.
 */
const COST_CALL_ALLOWLIST = new Set([
	"packages/core/src/ledger/pricing.ts", // defines the cost functions
]);

/** Strip // and block comments (a scan for identifiers must not trip on prose). */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const has = (code: string, word: string): boolean => new RegExp(`\\b${word}\\b`).test(code);

/** The text of each `costFromRates(...)` / `costFromRatesUnfloored(...)` call (parens balanced). */
function costCalls(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(/\bcostFromRates(?:Unfloored)?\s*\(/g)) {
		let depth = 1;
		let i = (m.index ?? 0) + m[0].length;
		const start = i;
		for (; i < code.length && depth > 0; i++) {
			if (code[i] === "(") depth++;
			else if (code[i] === ")") depth--;
		}
		out.push(code.slice(start, i - 1));
	}
	return out;
}

export function scanOneHourTier(files: Record<string, string>): string[] {
	const violations: string[] = [];
	for (const [path, source] of Object.entries(files)) {
		const code = stripComments(source);

		// RULE 1
		const allowed = DECIDER_ALLOWLIST[path] ?? [];
		for (const word of DECIDERS) {
			if (has(code, word) && !allowed.includes(word)) {
				violations.push(`RULE 1: ${path} decides the 1-hour tier itself via \`${word}\``);
			}
		}

		// RULE 2: every cost call that carries a 1-hour count must carry it THROUGH the predicate:
		// wrapped in `supported1hTokens(...)`, or read off the metering snapshot
		// (`usageSnapshot.cacheWrite1hTokens`), and every `const usageSnapshot =` in the file
		// must be built by `withSupported1hTier(...)`.
		if (!COST_CALL_ALLOWLIST.has(path)) {
			const snapshotsFiltered = [...code.matchAll(/const usageSnapshot =\s*([\w.]+)\(/g)].every(
				(m) => m[1] === "withSupported1hTier",
			);
			// Names bound to a snapshot that withSupported1hTier built (`const metered = ...`).
			const filteredNames = new Set(
				[...code.matchAll(/const (\w+) =\s*withSupported1hTier\(/g)].map((m) => m[1] as string),
			);
			for (const call of costCalls(code)) {
				const counts = call.match(/[\w.]*1hTokens\b/g) ?? [];
				if (counts.length === 0) continue;
				const wrapped = /\bsupported1hTokens\s*\(/.test(call);
				const fromSnapshot = counts.every((c) => {
					const [owner, field] = c.split(".");
					return field === "cacheWrite1hTokens" && filteredNames.has(owner ?? "");
				});
				if (!(wrapped || (fromSnapshot && snapshotsFiltered))) {
					violations.push(
						`RULE 2: ${path} prices a 1-hour count without routing it through supportsCacheWrite1h`,
					);
					break;
				}
			}
		}

		// RULE 3
		if (has(code, "effectiveCacheWrite1hRate") && !has(code, "supportsCacheWrite1h")) {
			if (path !== "packages/core/src/ledger/pricing.ts") {
				violations.push(
					`RULE 3: ${path} shows a 1-hour rate without guarding it with supportsCacheWrite1h`,
				);
			}
		}
	}
	return violations;
}

function walk(dir: string, out: string[], accept: (p: string) => boolean): void {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === ".next") continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out, accept);
		else if (accept(full)) out.push(full);
	}
}

/** Everything that SHIPS or renders: package sources, the plugin's hooks, the fleet scripts and page. */
function shippedFiles(): Record<string, string> {
	const paths: string[] = [];
	const isCode = (p: string) =>
		/\.(?:ts|tsx|mts|mjs)$/.test(p) && !/\.(?:test|test-d)\.[^.]+$/.test(p);
	for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
		const src = join(REPO_ROOT, "packages", pkg, "src");
		try {
			walk(src, paths, isCode);
		} catch {
			// a package with no src/ (the plugin ships hooks/)
		}
	}
	walk(join(REPO_ROOT, "packages", "claude-code-plugin", "hooks"), paths, isCode);
	walk(join(REPO_ROOT, "scripts"), paths, isCode);
	walk(join(REPO_ROOT, "site", "app", "fleet"), paths, isCode);
	const files: Record<string, string> = {};
	for (const p of paths)
		files[relative(REPO_ROOT, p).split("\\").join("/")] = readFileSync(p, "utf-8");
	return files;
}

describe("the 1-hour tier has ONE decider (supportsCacheWrite1h)", () => {
	it("the shipped tree has no second decider", () => {
		const files = shippedFiles();
		// The scan actually looked at the consumers (a vacuous empty tree would pass).
		for (const must of [
			"packages/core/src/ledger/pricing.ts",
			"packages/core/src/govern.ts",
			"packages/core/src/headless.ts",
			"packages/core/src/cli/pricing.ts",
			"packages/openshell/src/gate.ts",
			"packages/claude-code-plugin/hooks/transcript.mjs",
			"site/app/fleet/fleet-lib.ts",
		]) {
			expect(Object.keys(files), must).toContain(must);
		}
		expect(scanOneHourTier(files)).toEqual([]);
	});

	it("the allowlisted files really do mention their deciders (a stale allowlist is a lie)", () => {
		const files = shippedFiles();
		for (const [path, words] of Object.entries(DECIDER_ALLOWLIST)) {
			const code = stripComments(files[path] ?? "");
			for (const word of words) expect(has(code, word), `${path} should use ${word}`).toBe(true);
		}
		expect(
			has(stripComments(files["packages/core/src/cli/pricing.ts"] ?? ""), "supportsCacheWrite1h"),
		).toBe(true);
		for (const path of COST_CALL_ALLOWLIST) expect(files[path], path).toBeDefined();
	});

	describe("positive controls: a planted second decider turns the scan red", () => {
		const base = shippedFiles();

		it("RULE 1: a direct read of the per-model rate in a new file", () => {
			const planted = {
				...base,
				"packages/core/src/planted/direct-check.ts":
					"export const has1h = (r: { cacheWrite1hPer1k?: number }) => r.cacheWrite1hPer1k !== undefined;\n",
			};
			expect(scanOneHourTier(planted)).toEqual([
				"RULE 1: packages/core/src/planted/direct-check.ts decides the 1-hour tier itself via `cacheWrite1hPer1k`",
			]);
		});

		it("RULE 1: a decider added to an allowlisted file that is not allowed that word", () => {
			const planted = {
				...base,
				"packages/core/src/cli/init.ts": `${base["packages/core/src/cli/init.ts"]}\nconst x = effectiveCacheWrite1hRate;\n`,
			};
			expect(scanOneHourTier(planted)).toContain(
				"RULE 1: packages/core/src/cli/init.ts decides the 1-hour tier itself via `effectiveCacheWrite1hRate`",
			);
		});

		it("RULE 2: a raw 1-hour count passed into a cost function", () => {
			const planted = {
				...base,
				"packages/core/src/planted/raw-cost.ts":
					"export const c = (u: { cacheWrite1hTokens: number }) => costFromRates(r, 0, 0, 0, 10, u.cacheWrite1hTokens);\n",
			};
			expect(scanOneHourTier(planted)).toEqual([
				"RULE 2: packages/core/src/planted/raw-cost.ts prices a 1-hour count without routing it through supportsCacheWrite1h",
			]);
		});

		it("RULE 3: display code showing the derived rate without the guard", () => {
			const planted = {
				...base,
				"packages/core/src/planted/show.ts":
					"export const s = (r: unknown) => effectiveCacheWrite1hRate(r);\n",
			};
			const v = scanOneHourTier(planted);
			expect(v.some((m) => m.startsWith("RULE 3: packages/core/src/planted/show.ts"))).toBe(true);
		});

		it("comments and prose never trip it; the same words in code do", () => {
			const ok = {
				...base,
				"packages/core/src/planted/prose.ts":
					"// uses cacheWrite1hPer1k\n/* effectiveCacheWrite1hRate */\nexport {};\n",
			};
			expect(scanOneHourTier(ok)).toEqual([]);
		});
	});
});
