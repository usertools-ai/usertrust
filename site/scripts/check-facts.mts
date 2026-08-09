/**
 * check-facts.mts — site prebuild gate: NO digit literals in marketing-section JSX.
 *
 * The dossier premise: every number a visitor sees traces to the facts
 * manifest (site/app/evidence/facts.json) or a captured fixture. Copy cannot
 * drift by construction.
 *
 * Line-based scan of site/app/components/sections/*.tsx:
 *   0. two WHOLE-LINE exemptions survive, and only two: an import statement,
 *      and any line carrying the explicit `data-code-sample` marker. Both are
 *      exemptions of the whole line by intent — a code sample's digits are the
 *      sample, and stripping only the marker would flag the very literals the
 *      marker exists to sanction;
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
 *   3. every ALLOWLISTED SPAN is STRIPPED OUT of the line — attribute
 *      assignments together with their values, raw CSS values, Tailwind
 *      utility classes, hex colours, and fixture expressions
 *      (facts. / receipt. / chain. / transcript.);
 *   4. on WHAT IS LEFT, every digit token (e.g. "9", "20+", "$5.00",
 *      "50,000") must be in the sanctioned set — built from facts.json values
 *      plus ALWAYS_SANCTIONED — or the build fails with file:line.
 *
 * STRIP, DON'T SKIP (Codex PR-88 P2). Step 3 used to PASS the whole line the
 * moment any fragment matched anywhere on it, which meant a single
 * `className=` exempted everything beside it: `<p className="x">9999
 * customers</p>` sailed through the gate this file exists to be. Stripping the
 * matched span and scanning the remainder keeps every structural digit exempt
 * — the class list, the coordinate, the CSS unit — while putting the JSX TEXT
 * back under the lint. It also retires the family of near-misses already
 * ledgered against the whole-line behaviour (colon-label prose, prose
 * percentages), because those only ever survived by sharing a line with an
 * allowlisted fragment.
 *
 * A full JSX parse would be stricter still and remains the post-launch
 * intention; span-stripping is the version that needs no parser and no new
 * dependency in a prebuild gate.
 *
 * Sanctioned tokens are matched as WHOLE tokens (never substrings), so "22"
 * does not ride through on a sanctioned "2".
 *
 * Every STRIP_SPANS fragment requires actual code syntax around the token — an
 * `=`/`:` assignment, a digit glued to its CSS unit, or a Tailwind utility's
 * `-digit`/`-[` suffix — never a bare English word or character. A bare
 * `duration`, `width`, `from`, etc. would silently exempt ordinary
 * marketing-copy prose (e.g. "the settlement duration is 5 days") from the
 * lint, hiding exactly the rogue digit literals this gate exists to catch. Do
 * not loosen a fragment back to a plain substring match, and do not turn one
 * back into a whole-line pass.
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

/**
 * Lines exempt in their ENTIRETY. Deliberately just two, and both are
 * exemptions of intent rather than of syntax: an import path's digits are a
 * filename, and a code sample's digits ARE the sample.
 */
const LINE_EXEMPT = new RegExp([String.raw`^\s*import\b`, "data-code-sample"].join("|"));

/**
 * Spans that are STRIPPED from a line before its digits are scanned. Each
 * fragment must consume the whole structural construct — an attribute together
 * with its value, a utility class together with its number — because anything
 * it leaves behind is scanned as prose.
 */
const STRIP_SPANS: RegExp[] = [
	// JSX/SVG attribute assignments, WITH their value: `className="..."`,
	// `d={...}`, `style={{ ... }}`, `viewBox="0 0 24 24"`. Any attribute name
	// qualifies — the point is no longer to enumerate safe names (the old list
	// was the bypass) but to remove the assignment and leave the text.
	/\b[A-Za-z_][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})/g,
	// CSS-in-JS / object-literal property assignments: `left: "25%"`,
	// `animationDelay: `${i * ROW_STAGGER_MS}ms``. Anchored on a property name
	// followed by a colon, up to the next comma or closing brace.
	/\b[A-Za-z_]\w*\s*:\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^,}\n]+)/g,
	// fixture/facts-derived expressions, including the property path that
	// follows them: `facts.facts.transferCodes.value`.
	/\b(?:facts|receipt|chain|transcript)\.[\w.?[\]]*/g,
	// Tailwind's opacity modifier on a colour utility: `bg-white/10`,
	// `text-white/70`, `border-ut/30`. A lowercase utility token, a slash, and
	// a number — a shape prose does not produce.
	/\b[a-z][a-z-]*\/\d{1,3}\b/g,
	// JSX tag names. `<h1` and `</h2` are markup, never prose — and the
	// heading-level digit is the single most common false positive there is.
	/<\/?[A-Za-z][\w.]*/g,
	// Property access on an identifier: `ln.x1`, `geometry.midNodeCy`. The dot
	// must be followed by a LETTER, so a decimal (`3.2`) is never eaten.
	/\.[A-Za-z_]\w*/g,
	// A bare NUMERIC-literal assignment: `const delay = 300;`, `step: 4,`. The
	// value must be a number and nothing else — a string assignment
	// (`const label = "9999 customers"`) stays under the lint, which is the
	// whole point.
	/=\s*-?\d+(?:\.\d+)?(?=\s*[;,)]|\s*$)/g,
	// CSS colour and gradient functions, wherever they appear — including on a
	// continuation line where the property name sits on the line above.
	/\b(?:rgba?|hsla?)\([^)]*\)/g,
	/\b(?:repeating-)?(?:linear|radial|conic)-gradient\([^)]*\)/g,
	// An attribute whose template-literal value OPENS on this line and does not
	// close on it (`className={`... ${`). Anchored on real attribute syntax, so
	// it strips a wrapped class list and nothing else.
	/\b[A-Za-z_][\w:-]*\s*=\s*\{?`[^`]*$/g,
	// hex colours
	/#[0-9a-fA-F]{3,8}\b/g,
	// raw CSS values: a digit glued directly to its unit, never bare "px"/
	// "rem"/"%" (those match inside ordinary words like "premium").
	/\d+(?:\.\d+)?(?:px|rem|em|vh|vw|deg|ms)\b/g,
	/\d+(?:\.\d+)?%/g,
	// Tailwind utility classes: known CSS-property prefix + "-" + a digit or
	// arbitrary-value bracket, e.g. "top-24", "z-10", "duration-300" — the
	// trailing dash alone is not enough ("top-tier" is prose), so a
	// digit/bracket must follow it. Consumes the whole utility token.
	/\b(?:top|bottom|left|right|inset|z|duration|delay|w|h|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap|rounded|opacity|scale|rotate|stroke|translate-x|translate-y)-(?:\[[^\]]*\]|[\w./%[\]-]*)/g,
];

/** Remove every allowlisted span, leaving the prose to be scanned. */
function strippedLine(line: string): string {
	let out = line;
	for (const re of STRIP_SPANS) out = out.replace(re, " ");
	return out;
}

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
	// totalSurprises — the dotted-leader punchline in open-ledger.tsx; the 0 is copy, not a fact.
	"TOTAL SURPRISES ··· 0",
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
			if (LINE_EXEMPT.test(line)) return;
			if (BARE_HEADING_TAG_LINE.test(line)) return;
			const rogue = (strippedLine(line).match(TOKEN) ?? []).filter((tok) => !sanctioned.has(tok));
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
