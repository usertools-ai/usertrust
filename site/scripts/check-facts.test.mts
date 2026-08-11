import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runChecker(sectionsDir: string) {
	return spawnSync("npx", ["tsx", "scripts/check-facts.mts", sectionsDir], {
		cwd: SITE_ROOT,
		encoding: "utf-8",
	});
}

test("a rogue digit literal in a section fails the lint with file:line", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-bad-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			"export default function Docket() {\n\treturn <p>7 transfer codes</p>;\n}\n",
		);
		const r = runChecker(dir);
		assert.notEqual(r.status, 0, "rogue digit must fail the build");
		assert.match(r.stderr, /docket\.tsx:2/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("digits rendered from facts.json and sanctioned display strings pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-clean-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				'import facts from "../../evidence/facts.json";',
				"export default function Docket() {",
				"\treturn (",
				"\t\t<div>",
				"\t\t\t<p>{facts.facts.transferCodes.value} transfer codes</p>",
				"\t\t\t<span>copied · $0.00</span>",
				"\t\t</div>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(r.status, 0, `expected clean pass, got:\n${r.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rogue digit is still caught on a line using allowlist keywords as ordinary prose words", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-prose-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn (",
				"\t\t<p>The stroke width from the top-tier duration study reached 9999 times.</p>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.notEqual(
			r.status,
			0,
			`bare words like "stroke"/"width"/"from"/"top-"/"duration" must not exempt prose from the rogue-digit check, got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /docket\.tsx:3/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("genuine SVG attributes, Tailwind utility classes, and CSS units pass regardless of value", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-css-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				'\tconst classes = cn("top-24 z-10 duration-300 delay-150");',
				"\treturn (",
				'\t\t<svg className={classes} style={{ marginTop: "24px", width: "50%" }}>',
				'\t\t\t<rect width="24" height="16" stroke="#34d399" strokeWidth="2" />',
				"\t\t</svg>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(
			r.status,
			0,
			`expected structural CSS/SVG/Tailwind digits to pass, got:\n${r.stderr}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("digit literals on a data-code-sample line are exempt", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-code-sample-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn (",
				"\t\t<pre data-code-sample>npm install usertrust@3.2.1</pre>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(r.status, 0, `expected data-code-sample line to be exempt, got:\n${r.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a standalone bare closing heading tag line passes (Biome's own line-wrap artifact)", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-heading-close-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn (",
				'\t\t<h3 className="font-display font-bold lowercase leading-[0.92] tracking-tight text-white">',
				"\t\t\tthe docket",
				"\t\t</h3>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(
			r.status,
			0,
			`expected a bare </h3> line (Biome always isolates a long opening tag's closer) to pass, got:\n${r.stderr}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a standalone bare opening heading tag line passes (Biome's multi-attribute wrap artifact)", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-heading-open-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn (",
				"\t\t<h3",
				'\t\t\tclassName="font-display font-bold lowercase leading-[0.92] tracking-tight text-white"',
				'\t\t\tdata-testid="docket-heading"',
				'\t\t\tid="docket-heading-anchor"',
				"\t\t>",
				"\t\t\tthe docket",
				"\t\t</h3>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(
			r.status,
			0,
			`expected a bare <h3 line with no attributes (Biome breaks 3+ attributes one-per-line) to pass, got:\n${r.stderr}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rogue digit in heading TEXT still fails even with the closing-tag exemption in place", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-heading-text-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn (",
				"\t\t<h2>99 problems</h2>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.notEqual(
			r.status,
			0,
			`a rogue digit in heading text must still fail the gate, got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /docket\.tsx:3/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an allowlisted ATTRIBUTE no longer exempts the rest of its line (span-stripping)", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-span-"));
	try {
		// The whole-line allowlist let any line carrying `className=` through,
		// so a rogue claim sharing a line with one was invisible to the gate.
		// Only the attribute's own span is exempt now; the JSX TEXT beside it is
		// scanned like any other prose.
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				'\treturn <p className="mt-4 text-white/70">9999 customers</p>;',
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.notEqual(
			r.status,
			0,
			`className= must not exempt the text beside it, got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /docket\.tsx:2/);
		assert.match(r.stderr, /9999/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fixture expression no longer exempts a rogue digit sharing its line", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-fixture-span-"));
	try {
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				'import facts from "../../evidence/facts.json";',
				"export default function Docket() {",
				"\treturn <p>{facts.facts.transferCodes.value} codes and 4242 customers</p>;",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.notEqual(
			r.status,
			0,
			`a facts. expression must not exempt unrelated digits on its line, got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /4242/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a colon LABEL in JSX text does not exempt the prose after it", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-colon-label-"));
	try {
		// The object-property strip rule once ended in `[^,}\n]+`, so any `word:`
		// in JSX text swallowed the rest of the line — this exact line passed
		// while the identical claim without the label failed. The label must not
		// be a way to smuggle a digit past the gate.
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn <p>models: 9999 supported</p>;",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.notEqual(
			r.status,
			0,
			`a colon label must not exempt the prose beside it, got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /docket\.tsx:2/);
		assert.match(r.stderr, /9999/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("genuine object-literal properties and CSS functional notation still pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-object-props-"));
	try {
		// The shapes the object-property rule exists for — motion variants with
		// numeric values — plus the CSS functions that show up in comments about
		// arbitrary-value utilities.
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				"export default function Docket() {",
				"\treturn (",
				"\t\t<motion.span",
				"\t\t\texit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}",
				'\t\t\ttransition={{ type: "spring", stiffness: 550, damping: 42 }}',
				"\t\t\t// the rail column is already minmax(0,12rem), so a cap could never bind",
				'\t\t\tstyle={{ animationDelay: "150ms" }}',
				"\t\t/>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(
			r.status,
			0,
			`object-literal numerics and CSS functions must stay exempt, got:\n${r.stderr}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * SANCTIONED_PROSE. The corpus footnote names an upstream spec row and the
 * scenario it was folded into, and those two digits are provenance about a test
 * file rather than product claims with facts.json entries. They used to be
 * exempt by ADDRESS — the sentence lived in sections/lib, which the scan does
 * not walk — and an address is not a review. These two tests pin the
 * replacement: the exact sentence is sanctioned by name, and one digit off it
 * is not.
 */
test("a sentence on the SANCTIONED_PROSE list passes inside a scanned section", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-prose-ok-"));
	try {
		writeFileSync(
			join(dir, "exhibit-g.tsx"),
			[
				"export default function ExhibitG() {",
				"\treturn (",
				'\t\t<p className="mt-3">',
				"\t\t\tindexed by row · source test titles linked verbatim; their original spec-row prefixes",
				"\t\t\tare omitted (row 17 was folded into scenario 5 upstream).",
				"\t\t</p>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(r.status, 0, `the sanctioned footnote must pass, got:\n${r.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SANCTIONED_PROSE is an exact sentence, not a pattern: one digit off still fails", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-prose-near-miss-"));
	try {
		writeFileSync(
			join(dir, "exhibit-g.tsx"),
			[
				"export default function ExhibitG() {",
				"\treturn (",
				"\t\t<p>are omitted (row 18 was folded into scenario 5 upstream).</p>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.notEqual(
			r.status,
			0,
			`a near-miss of a sanctioned sentence must NOT inherit its exemption, got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /18/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stripping is span-scoped, not greedy: real section lines still pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-realistic-"));
	try {
		// Lines lifted from the shipped sections — each mixes an allowlisted span
		// with ordinary markup, and each must still pass after the change.
		writeFileSync(
			join(dir, "docket.tsx"),
			[
				'import facts from "../../evidence/facts.json";',
				"export default function Docket() {",
				"\treturn (",
				'\t\t<div className="mt-12 grid grid-cols-2 border border-[rgba(52,211,153,0.08)] md:grid-cols-4">',
				'\t\t\t<span style={{ left: "25%" }} />',
				'\t\t\t<circle cx={40} cy={130} r={5} className="die-pad" />',
				'\t\t\t<p className="text-[12px]">{facts.facts.policyOperators.value} policy operators</p>',
				"\t\t</div>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(r.status, 0, `realistic section lines must still pass, got:\n${r.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * THE FLEET GATE RUN (spec r2/C9). check-facts.mts resolves argv[2] against
 * the CWD, and npm scripts run with cwd = site/. So the prebuild's second
 * gate run must pass `app/fleet` — the plausible-looking `site/app/fleet`
 * resolves to site/site/app/fleet, a directory that never exists, and a
 * missing sectionsDir exits 0 by design (pre-section-build phase). That is a
 * gate wired to scan NOTHING, green forever. These two tests pin (a) that the
 * cwd-correct form actually scans a rogue digit planted in site/app/fleet,
 * (b) that the trap form really does scan nothing (why the wiring matters),
 * and (c) the prebuild wiring string itself, so a later "cleanup" to the
 * trap form fails in CI instead of silently disarming the gate.
 */
test("fleet gate run: argv `app/fleet` from cwd site/ scans the route; `site/app/fleet` scans nothing", () => {
	const fleetDir = join(SITE_ROOT, "app", "fleet");
	// Task 7 owns the real page; until it lands, the test supplies the minimal
	// directory presence and removes it again. If the page already exists, only
	// the planted rogue file is created and removed.
	const dirPreExisted = existsSync(fleetDir);
	if (!dirPreExisted) mkdirSync(fleetDir, { recursive: true });
	const rogue = join(fleetDir, "__fleet-gate-regression__.tsx");
	try {
		writeFileSync(
			rogue,
			"export default function Rogue() {\n\treturn <p>9999 agents in the fleet</p>;\n}\n",
		);
		// The wired form — relative to site/, exactly as the prebuild runs it.
		const hit = runChecker("app/fleet");
		assert.notEqual(hit.status, 0, "a rogue digit in site/app/fleet must fail the fleet gate run");
		assert.match(hit.stderr, /__fleet-gate-regression__\.tsx:2/);
		assert.match(hit.stderr, /9999/);
		// The trap form — same cwd, rogue file still planted: resolves to
		// site/site/app/fleet, scans nothing, exits 0. This is the r2/C9 failure
		// mode the wiring test below exists to keep out of package.json.
		const miss = runChecker("site/app/fleet");
		assert.equal(
			miss.status,
			0,
			`argv site/app/fleet must resolve to a missing dir and exit 0 (scanning nothing), got:\n${miss.stderr}`,
		);
		assert.match(miss.stdout, /does not exist yet/);
	} finally {
		rmSync(rogue, { force: true });
		if (!dirPreExisted) rmSync(fleetDir, { recursive: true, force: true });
	}
});

test("prebuild wires the fleet gate run with the cwd-correct argv form", () => {
	const pkg = JSON.parse(readFileSync(join(SITE_ROOT, "package.json"), "utf-8")) as {
		scripts: Record<string, string>;
	};
	assert.equal(
		pkg.scripts.prebuild,
		"tsx scripts/check-facts.mts && tsx scripts/check-facts.mts app/fleet",
		"prebuild must run the sections gate AND the fleet gate with argv `app/fleet` — " +
			"`site/app/fleet` resolves against cwd=site/ to a missing dir and exits 0, scanning nothing (r2/C9)",
	);
});
