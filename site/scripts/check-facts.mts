/**
 * check-facts.mts — site prebuild gate: NO digit literals in marketing-section JSX.
 *
 * The dossier premise: every number a visitor sees traces to the facts
 * manifest (site/app/evidence/facts.json) or a captured fixture. Copy cannot
 * drift by construction.
 *
 * Line-based scan of site/app/components/sections/*.tsx:
 *   1. lines with no digits pass;
 *   2. a line that is nothing but a bare heading tag — closing (`</h1>`
 *      through `</h6>`) or a zero-attribute opening tag (`<h3` or `<h5>`),
 *      each with optional surrounding whitespace and nothing else — passes.
 *      Biome always isolates a closing tag onto its own line when the
 *      matching opening tag is too long to share it, and isolates a
 *      zero-attribute opening tag the same way when a long child forces the
 *      wrap or when enough attributes force one-per-line layout; either way
 *      the heading-level digit ends up alone with no other code around it.
 *      This is anchored to the WHOLE line, so it never exempts heading TEXT —
 *      a line like `<h2>99 problems</h2>` still falls through to step 4 —
 *      and never exempts an opening tag that carries attributes (`<h3
 *      className="...">` already rides through ALLOWLIST via its own
 *      `className=` syntax, so no broader opening-tag rule is needed);
 *   3. lines matching ALLOWLIST pass (attribute/property assignments, raw
 *      CSS values, Tailwind utility classes, import statements, any
 *      expression reading fixtures: facts. / receipt. / chain. / transcript.,
 *      and any line carrying a `data-code-sample` marker);
 *   4. on remaining lines, every digit token (e.g. "9", "20+", "$5.00",
 *      "50,000") must be in the sanctioned set — built from facts.json values
 *      plus ALWAYS_SANCTIONED — or the build fails with file:line.
 *
 * Sanctioned tokens are matched as WHOLE tokens (never substrings), so "22"
 * does not ride through on a sanctioned "2".
 *
 * Every ALLOWLIST fragment requires actual code syntax around the token — an
 * `=`/`:` assignment, an import statement, a digit glued to its CSS unit, or
 * a Tailwind utility's `-digit`/`-[` suffix — never a bare English word or
 * character. A bare `duration`, `width`, `from`, etc. would silently exempt
 * ordinary marketing-copy prose (e.g. "the settlement duration is 5 days")
 * from the lint, hiding exactly the rogue digit literals this gate exists to
 * catch. Do not loosen a fragment back to a plain substring match.
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

const ALLOWLIST = new RegExp(
	[
		// import statements: `import facts from "../../evidence/facts.json";`
		String.raw`^\s*import\b`,
		// JSX/SVG attribute or CSS-in-JS property assignments (name directly
		// followed by = or :) — never bare, so prose mentioning "width" or
		// "stroke" without the assignment syntax is not exempted.
		String.raw`\b(?:aria-[\w-]+|className|key|width|height|viewBox|stroke(?:[A-Z]\w*)?|d|cx|cy|r|x1?|y1?|x2|y2|rx|ry|points|transform|delay|duration)\s*[=:]`,
		// fixture/facts-derived expressions
		String.raw`\b(?:facts|receipt|chain|transcript)\.`,
		// explicit code-sample exemption (consumed by Task 7)
		"data-code-sample",
		// hex colors
		"#[0-9a-f]",
		// video/audio container format identifiers: a codec/container name, not
		// a marketing digit (e.g. `<source type="video/mp4" src=".../x.mp4" />`
		// — the Safari fallback source is unavoidably literal). Whole-word only,
		// so it never bleeds into an adjacent rogue digit on the same line.
		String.raw`\bmp4\b`,
		// raw CSS values: a digit glued directly to its unit, never bare "px"/
		// "rem"/"%" (those match inside ordinary words like "premium").
		String.raw`\d+(?:\.\d+)?(?:px|rem|em|vh|vw|deg|ms)\b`,
		String.raw`\d+(?:\.\d+)?%`,
		// Tailwind utility classes: known CSS-property prefix + "-" + a digit
		// or arbitrary-value bracket, e.g. "top-24", "z-10", "duration-300",
		// "delay-150" — the trailing dash alone is not enough ("top-tier" is
		// prose), so a digit/bracket must follow it.
		String.raw`\b(?:top|bottom|left|right|inset|z|duration|delay|w|h|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap|rounded|opacity|scale|rotate|stroke|translate-x|translate-y)-(?:\d|\[)`,
	].join("|"),
);

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

// Biome always isolates a closing tag onto its own line when the matching
// opening tag is too long to share the line — so `</h1>` through `</h6>`
// routinely end up alone on a line whose only "digit" is the heading level.
// The equivalent OPENING-tag-only shape is included too: verified that Biome
// produces a bare `<h3` line (no `>`, no attributes) when a heading has
// enough attributes to force one-per-line wrapping, and a bare
// `<h5>` line (immediate close, no attributes) when a single long child
// expression forces the tag onto its own line. Both are real, reachable
// artifacts of the >=100-char line-width formatter, not hypothetical.
//
// Anchored to the WHOLE line (never a substring), and the opening-tag branch
// requires NOTHING between the tag name and the optional `>` — so it only
// ever matches a heading tag with zero attributes on that line. The instant
// an attribute appears (e.g. `<h3 className="...">`), this regex no longer
// matches and the line falls through to ALLOWLIST, which already exempts it
// via the `className\s*[=:]` fragment. A line carrying heading TEXT with a
// rogue digit, e.g. `<h2>99 problems</h2>`, never matches either — it still
// falls through to the digit-token check below.
const BARE_HEADING_TAG_LINE = /^\s*<\/?h[1-6]>?\s*$/;

const violations: string[] = [];
for (const name of readdirSync(sectionsDir)
	.filter((f) => f.endsWith(".tsx"))
	.sort()) {
	const file = join(sectionsDir, name);
	readFileSync(file, "utf-8")
		.split("\n")
		.forEach((line, idx) => {
			if (!/\d/.test(line)) return;
			if (BARE_HEADING_TAG_LINE.test(line)) return;
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
