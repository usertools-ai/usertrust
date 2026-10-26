// The tested-tree stamp: the verdict script's rule, and ci.yml's wiring of it (the job, the candidate/** trigger and
// its two folds, and the cancel rule). Each wiring pin has a mutant: a copy of ci.yml with that one thing changed must
// make the check report a problem.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { main, verdict } from "./tested-tree-verdict.mjs";

const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const SHA = "a".repeat(40);

// ── the verdict ────────────────────────────────────────────────────────────────────────────────────────────────
function run(results, required = "") {
	const out = [];
	const rc = main(
		{ RESULTS: JSON.stringify(results), TESTED_SHA: SHA, REQUIRED: required },
		(l) => out.push(l),
		() => {},
	);
	return { rc, out, stamps: out.filter((l) => l.startsWith("::notice title=tested-tree::")) };
}

test("every needed job succeeded: exactly one stamp naming the tested commit", () => {
	const r = run({ a: { result: "success" }, b: { result: "success" } }, "a b");
	assert.equal(r.rc, 0);
	assert.deepEqual(r.stamps, [`::notice title=tested-tree::tested-tree ${SHA}`]);
});

test("a failed, cancelled or absent required job: no stamp", () => {
	for (const results of [
		{ a: { result: "success" }, b: { result: "failure" } },
		{ a: { result: "success" }, b: { result: "cancelled" } },
		{ a: { result: "success" } },
	]) {
		const r = run(results, "a b");
		assert.equal(r.rc, 1);
		assert.deepEqual(r.stamps, []);
	}
});

test("a skipped job passes only when it is not required", () => {
	assert.equal(run({ a: { result: "success" }, b: { result: "skipped" } }, "a").rc, 0);
	assert.equal(run({ a: { result: "success" }, b: { result: "skipped" } }, "a b").rc, 1);
});

test("a short or non-hex TESTED_SHA is exit 2, never a stamp", () => {
	for (const sha of ["abc1234", "a".repeat(39), "A".repeat(40), `${"a".repeat(40)}0`]) {
		assert.equal(
			main(
				{ RESULTS: '{"a":{"result":"success"}}', TESTED_SHA: sha, REQUIRED: "a" },
				() => {},
				() => {},
			),
			2,
		);
	}
});

test("unusable input is exit 2, never a stamp", () => {
	assert.equal(
		main(
			{ RESULTS: "{", TESTED_SHA: SHA, REQUIRED: "" },
			() => {},
			() => {},
		),
		2,
	);
	assert.equal(
		main(
			{ RESULTS: "{}", TESTED_SHA: "HEAD", REQUIRED: "" },
			() => {},
			() => {},
		),
		2,
	);
	assert.deepEqual(verdict({}, []), ["no needed jobs"]);
});

// ── the wiring ─────────────────────────────────────────────────────────────────────────────────────────────────
// Top-level job ids: two-space-indented keys under `jobs:`.
function jobIds(text) {
	const body = text.slice(text.indexOf("\njobs:\n"));
	return [...body.matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]);
}
function jobBlock(text, id) {
	const start = text.indexOf(`\n  ${id}:\n`);
	if (start < 0) return "";
	const rest = text.slice(start + 1);
	const next = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\n/);
	return next < 0 ? rest : rest.slice(0, next + 1);
}
function wiringProblems(text) {
	const problems = [];
	if (
		!/^ {4}branches: \[master, 'candidate\/\*\*'\]$/m.test(
			text.slice(0, text.indexOf("  pull_request:")),
		)
	) {
		problems.push("push.branches lacks candidate/**");
	}
	if (
		!text.includes(
			`group: ci-\${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`,
		)
	) {
		problems.push("push runs share a concurrency group (a queued run cancels the pending one)");
	}
	if (!text.includes(`cancel-in-progress: \${{ github.event_name == 'pull_request' }}`)) {
		problems.push("a push can be cancelled by the next one");
	}
	if (!text.includes('case "$REF" in refs/heads/candidate/*) EVENT=pull_request ;; esac')) {
		problems.push("agent-config does not grade a candidate as a merge commit");
	}
	if (
		!text.includes(
			"if: github.event_name == 'pull_request' || startsWith(github.ref, 'refs/heads/candidate/')",
		)
	) {
		problems.push("the timing baseline check skips candidates");
	}
	const tt = jobBlock(text, "tested-tree");
	if (!tt) {
		problems.push("no tested-tree job");
		return problems;
	}
	const others = jobIds(text)
		.filter((j) => j !== "tested-tree")
		.sort();
	const needs = (tt.match(/^ {4}needs: \[(.*)\]$/m)?.[1] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.sort();
	if (JSON.stringify(needs) !== JSON.stringify(others))
		problems.push(`tested-tree needs [${needs}], not every job [${others}]`);
	const required = (tt.match(/^ {10}REQUIRED: (.*)$/m)?.[1] ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.sort();
	if (JSON.stringify(required) !== JSON.stringify(others))
		problems.push("REQUIRED is not every job");
	if (!/^ {4}name: tested-tree$/m.test(tt))
		problems.push("the stamp's name is not the stable `tested-tree`");
	if (/^ {4}permissions:/m.test(tt)) problems.push("the stamp job asks for permissions");
	if (
		!tt.includes(`RESULTS: \${{ toJSON(needs) }}`) ||
		!tt.includes(`TESTED_SHA: \${{ github.sha }}`)
	) {
		problems.push("the verdict does not get the needs results and github.sha");
	}
	if (!tt.includes("run: node scripts/tested-tree-verdict.mjs"))
		problems.push("the stamp job does not run the verdict");
	if (!tt.includes("if: always() && !cancelled()"))
		problems.push("the stamp job does not run after a failure");
	return problems;
}

test("ci.yml wires the stamp, the candidate trigger and folds, and the cancel rule", () => {
	assert.deepEqual(wiringProblems(CI), []);
});

const MUTANTS = [
	[
		"push runs share one group per ref",
		`group: ci-\${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`,
		`group: ci-\${{ github.ref }}`,
	],
	["no candidate trigger", "    branches: [master, 'candidate/**']", "    branches: [master]"],
	[
		"pushes cancel each other",
		`cancel-in-progress: \${{ github.event_name == 'pull_request' }}`,
		"cancel-in-progress: true",
	],
	[
		"candidate graded as a push",
		'case "$REF" in refs/heads/candidate/*) EVENT=pull_request ;; esac',
		":",
	],
	[
		"timing check skips candidates",
		"if: github.event_name == 'pull_request' || startsWith(github.ref, 'refs/heads/candidate/')",
		"if: github.event_name == 'pull_request'",
	],
	[
		"a job missing from needs",
		"needs: [agent-config, lint, typecheck,",
		"needs: [agent-config, lint,",
	],
	[
		"a job missing from REQUIRED",
		"REQUIRED: agent-config lint typecheck",
		"REQUIRED: agent-config lint",
	],
	["the stamp renamed", "    name: tested-tree\n", "    name: stamp\n"],
	["the verdict not run", "run: node scripts/tested-tree-verdict.mjs", "run: echo ok"],
	["the stamp skipped after a failure", "if: always() && !cancelled()", "if: success()"],
];
for (const [name, from, to] of MUTANTS) {
	test(`mutant: ${name} is reported`, () => {
		assert.equal(CI.split(from).length, 2, `the mutant's anchor occurs exactly once: ${from}`);
		assert.notDeepEqual(wiringProblems(CI.replace(from, to)), []);
	});
}
