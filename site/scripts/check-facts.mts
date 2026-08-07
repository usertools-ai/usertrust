/**
 * check-facts.mts — site prebuild gate: NO digit literals in marketing-section JSX.
 *
 * The dossier premise: every number a visitor sees traces to the facts
 * manifest (site/app/evidence/facts.json) or a captured fixture. Copy cannot
 * drift by construction.
 *
 * Line-based scan of site/app/components/sections/*.tsx:
 *   1. lines with no digits pass;
 *   2. lines matching ALLOWLIST pass (attributes, CSS values, imports, any
 *      expression reading fixtures: facts. / receipt. / chain. / transcript.,
 *      and any line carrying a `data-code-sample` marker);
 *   3. on remaining lines, every digit token (e.g. "9", "20+", "$5.00",
 *      "50,000") must be in the sanctioned set — built from facts.json values
 *      plus ALWAYS_SANCTIONED — or the build fails with file:line.
 *
 * Sanctioned tokens are matched as WHOLE tokens (never substrings), so "22"
 * does not ride through on a sanctioned "2".
 *
 * Usage: tsx scripts/check-facts.mts [sectionsDir]   (dir override for tests)
 * Exit 0 when sectionsDir does not exist yet (pre-section-build phase).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sectionsDir = process.argv[2]
	? resolve(process.argv[2])
	: join(SITE_ROOT, "app", "components", "sections");
const factsPath = join(SITE_ROOT, "app", "evidence", "facts.json");

const ALLOWLIST =
	/aria-|className|key=|width|height|viewBox|stroke|d=|delay|duration|top-|z-|px|rem|%|#[0-9a-f]|import|from|facts\.|receipt\.|chain\.|transcript\.|data-code-sample/;

/**
 * Digit tokens that are protocol/product names or fixed display strings, not
 * product claims: SHA-256, Ed25519, RFC 6962, Apache 2.0, CASE FILE 001, the
 * case-file $500 figure, and the copy-chit/pricing display strings.
 * Additions require editing this file — that review IS the gate.
 */
const ALWAYS_SANCTIONED = [
	"$0.00",
	"$5.00",
	"50,000",
	"$500",
	"256",
	"25519",
	"6962",
	"2.0",
	"001",
];

/** Matches "$0.00", "$500", "50,000", "20+", "9", "44" ... as whole tokens. */
const TOKEN = /\$\d+(?:[.,]\d+)*|\d[\d,]*(?:\.\d+)?\+?/g;

if (!existsSync(factsPath)) {
	console.error(
		`check-facts: ${factsPath} missing — run \`npm run evidence:capture\` at the repo root and commit the fixtures.`,
	);
	process.exit(1);
}

interface Fact {
	value: unknown;
	numeric?: number;
}
const manifest = JSON.parse(readFileSync(factsPath, "utf-8")) as { facts: Record<string, Fact> };

const sanctioned = new Set<string>(ALWAYS_SANCTIONED);
for (const fact of Object.values(manifest.facts)) {
	for (const v of [fact.value, fact.numeric]) {
		if (v === undefined) continue;
		const s = String(v);
		sanctioned.add(s);
		for (const tok of s.match(TOKEN) ?? []) sanctioned.add(tok);
	}
}

if (!existsSync(sectionsDir)) {
	console.log(`check-facts: ${sectionsDir} does not exist yet — nothing to lint.`);
	process.exit(0);
}

const violations: string[] = [];
for (const name of readdirSync(sectionsDir)
	.filter((f) => f.endsWith(".tsx"))
	.sort()) {
	const file = join(sectionsDir, name);
	readFileSync(file, "utf-8")
		.split("\n")
		.forEach((line, idx) => {
			if (!/\d/.test(line)) return;
			if (ALLOWLIST.test(line)) return;
			const rogue = (line.match(TOKEN) ?? []).filter((tok) => !sanctioned.has(tok));
			if (rogue.length > 0) {
				violations.push(
					`${file}:${idx + 1}: rogue digit literal(s) ${rogue.join(", ")} — render from facts.json instead\n    ${line.trim()}`,
				);
			}
		});
}

if (violations.length > 0) {
	console.error(`check-facts: ${violations.length} violation(s):\n${violations.join("\n")}`);
	process.exit(1);
}
console.log(
	`check-facts: OK — all digits in sections/ trace to facts.json (${sanctioned.size} sanctioned tokens).`,
);
