import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a video source's literal mp4 container/extension passes, but an unrelated bare digit does not", () => {
	const dir = mkdtempSync(join(tmpdir(), "check-facts-mp4-"));
	try {
		writeFileSync(
			join(dir, "hero-intro.tsx"),
			[
				"export default function HeroIntro() {",
				"\treturn (",
				"\t\t<video>",
				'\t\t\t<source src="/intro/intro-autoplay.mp4" type="video/mp4" />',
				"\t\t</video>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
		const r = runChecker(dir);
		assert.equal(r.status, 0, `expected the mp4 source line to pass, got:\n${r.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const rogueDir = mkdtempSync(join(tmpdir(), "check-facts-mp4-rogue-"));
	try {
		writeFileSync(
			join(rogueDir, "docket.tsx"),
			"export default function Docket() {\n\treturn <p>4 transfer codes</p>;\n}\n",
		);
		const r = runChecker(rogueDir);
		assert.notEqual(
			r.status,
			0,
			`the mp4 exemption must not sanction an unrelated bare "4", got:\n${r.stderr}`,
		);
		assert.match(r.stderr, /docket\.tsx:2/);
	} finally {
		rmSync(rogueDir, { recursive: true, force: true });
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
