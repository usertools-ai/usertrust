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
