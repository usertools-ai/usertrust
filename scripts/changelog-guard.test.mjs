// The CHANGELOG guard (changelog-guard.mjs) against fixture repositories: each row builds a base commit and a merged
// commit, or a real merge, and runs the guard on the pair as CI does. Run with
// `node --test scripts/changelog-guard.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const GUARD = join(import.meta.dirname, "changelog-guard.mjs");
const GUARD_SOURCE = readFileSync(GUARD, "utf8");

const scratch = mkdtempSync(join(tmpdir(), "changelog-guard-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ENV = {
	PATH: process.env.PATH,
	HOME: scratch,
	LANG: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
};

let counter = 0;
function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}
function newRepo() {
	const dir = join(scratch, `repo-${++counter}`);
	execFileSync("git", ["init", "-q", "-b", "master", dir], { env: ENV });
	return dir;
}
function commit(dir, text, message) {
	writeFileSync(join(dir, "CHANGELOG.md"), text);
	git(dir, "add", "CHANGELOG.md");
	git(dir, "commit", "-q", "--allow-empty", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}
function runGuard(dir, base, merged, guard = GUARD) {
	const r = spawnSync("node", [guard, base, merged], { cwd: dir, env: ENV, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
/** A base commit and a merged commit on top of it, graded as `base` -> `merged`. */
function pair(baseText, mergedText, guard) {
	const dir = newRepo();
	const base = commit(dir, baseText, "base");
	const merged = commit(dir, mergedText, "merged");
	return runGuard(dir, base, merged, guard);
}

const HEAD =
	"# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";
const R520 =
	"## [5.2.0] - 2026-10-26\n\n### Added\n\n- Old entry A.\n\n## [5.1.0] - 2026-10-18\n\n### Fixed\n\n- Old entry B.\n";
const log = (unreleased, ...released) =>
	`${HEAD}## [Unreleased]\n${unreleased}${released.join("")}`;

// The state before a cut: two entries under Unreleased.
const PRE_CUT = log("\n### Added\n\n- Feature A.\n- Feature B.\n\n", R520);
// The cut: the Unreleased body moves under a new heading, and Unreleased is empty.
const CUT = log("\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n- Feature B.\n\n", R520);

describe("a change that leaves CHANGELOG.md alone", () => {
	test("is skipped", () => {
		const r = pair(PRE_CUT, PRE_CUT);
		assert.equal(r.code, 0);
		assert.match(r.out, /nothing to check/);
	});
	test("is skipped when the repository has no CHANGELOG.md at all", () => {
		const dir = newRepo();
		writeFileSync(join(dir, "README.md"), "x\n");
		git(dir, "add", "README.md");
		git(dir, "commit", "-q", "-m", "a");
		writeFileSync(join(dir, "README.md"), "y\n");
		git(dir, "commit", "-q", "-am", "b");
		assert.equal(runGuard(dir, "HEAD~1", "HEAD").code, 0);
	});
});

describe("an entry under [Unreleased]", () => {
	test("is allowed (the normal pull request)", () => {
		const merged = log("\n### Added\n\n- Feature A.\n- Feature B.\n- Feature C.\n\n", R520);
		assert.equal(pair(PRE_CUT, merged).code, 0);
	});
	test("is allowed into an empty [Unreleased] after a cut", () => {
		const merged = log(
			"\n### Fixed\n\n- A fix.\n\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n- Feature B.\n\n",
			R520,
		);
		assert.equal(pair(CUT, merged).code, 0);
	});
	test("is refused when it changes the [Unreleased] heading itself", () => {
		const r = pair(PRE_CUT, PRE_CUT.replace("## [Unreleased]", "## [Unreleased] - soon"));
		assert.equal(r.code, 1);
		assert.match(r.out, /heading must be exactly/);
	});
	test("is refused when [Unreleased] is moved below a release", () => {
		const moved = `${HEAD}## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n- Feature B.\n\n## [Unreleased]\n\n${R520}`;
		const r = pair(CUT, moved);
		assert.equal(r.code, 1);
		assert.match(r.out, /first section/);
	});
	test("may remove or reword another entry still under [Unreleased]", () => {
		const merged = log("\n### Added\n\n- Feature A, reworded.\n\n", R520);
		assert.equal(pair(PRE_CUT, merged).code, 0);
	});
});

describe("the release cut", () => {
	test("is allowed: Unreleased becomes the new release, and Unreleased is left empty", () => {
		const r = pair(PRE_CUT, CUT);
		assert.equal(r.code, 0, r.out);
	});
	test("is recognised by its shape: the same cut is allowed whoever sends it", () => {
		assert.equal(pair(PRE_CUT, CUT).code, 0);
	});
	test("is allowed with notes added during the cut (upgrade notes, a known issue, a new class)", () => {
		const merged = log(
			"\n## [5.3.0] - 2026-11-01\n\n### Read before upgrading\n\n- A note.\n\n### Added\n\n- Feature A.\n- Feature B.\n- Another entry written during the cut.\n\n### Known issues\n\n- A known issue.\n\n",
			R520,
		);
		const r = pair(PRE_CUT, merged);
		assert.equal(r.code, 0, r.out);
	});
	test("is refused when an entry is reworded", () => {
		const merged = log(
			"\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A, reworded.\n- Feature B.\n\n",
			R520,
		);
		const r = pair(PRE_CUT, merged);
		assert.equal(r.code, 1);
		assert.match(r.out, /not a release cut/);
	});
	test("is refused when entries are reordered", () => {
		const merged = log(
			"\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature B.\n- Feature A.\n\n",
			R520,
		);
		assert.equal(pair(PRE_CUT, merged).code, 1);
	});
	test("is refused when the new release drops a line of the Unreleased body", () => {
		const merged = log("\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n\n", R520);
		assert.equal(pair(PRE_CUT, merged).code, 1);
	});
	test("is refused when Unreleased keeps entries", () => {
		const merged = log(
			"\n- Left behind.\n\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n- Feature B.\n\n",
			R520,
		);
		assert.equal(pair(PRE_CUT, merged).code, 1);
	});
	test("is refused when the heading is not a dated version", () => {
		const merged = log("\n## [next]\n\n### Added\n\n- Feature A.\n- Feature B.\n\n", R520);
		assert.equal(pair(PRE_CUT, merged).code, 1);
	});
	test("is refused when it also edits an older release", () => {
		const merged = CUT.replace("Old entry A.", "Old entry A, edited.");
		const r = pair(PRE_CUT, merged);
		assert.equal(r.code, 1);
		assert.match(r.out, /\[5\.2\.0\]/);
	});
	test("is refused when two releases are added at once", () => {
		const merged = log(
			"\n## [5.4.0] - 2026-11-02\n\n### Added\n\n- Feature A.\n- Feature B.\n\n## [5.3.0] - 2026-11-01\n\n- Extra.\n\n",
			R520,
		);
		assert.equal(pair(PRE_CUT, merged).code, 1);
	});
});

describe("a known issue recorded in a released section", () => {
	test("is allowed: a new ### Known issues block", () => {
		const merged = CUT.replace(
			"- Feature B.\n",
			"- Feature B.\n\n### Known issues\n\n- A known issue.\n",
		);
		const r = pair(CUT, merged);
		assert.equal(r.code, 0, r.out);
	});
	test("is allowed: a line appended to an existing ### Known issues block", () => {
		const withBlock = CUT.replace(
			"- Feature B.\n",
			"- Feature B.\n\n### Known issues\n\n- First issue.\n",
		);
		const merged = withBlock.replace("- First issue.\n", "- First issue.\n- Second issue.\n");
		assert.equal(pair(withBlock, merged).code, 0);
	});
	test("is allowed in an older release too", () => {
		const merged = CUT.replace(
			"- Old entry A.\n",
			"- Old entry A.\n\n### Known issues\n\n- Found after shipping.\n",
		);
		assert.equal(pair(CUT, merged).code, 0);
	});
	test("is refused: an added line under any other heading", () => {
		const merged = CUT.replace("- Feature B.\n", "- Feature B.\n- Slipped in.\n");
		const r = pair(CUT, merged);
		assert.equal(r.code, 1);
		assert.match(r.out, /outside "### Known issues"/);
	});
	test("is refused: a block inserted above existing lines of a plain-list section relabels them", () => {
		const plain = log("\n", "## [1.1.0] - 2026-01-01\n\n- plain entry x\n- plain entry y\n");
		const merged = log(
			"\n",
			"## [1.1.0] - 2026-01-01\n\n### Known issues\n\n- ki 1\n\n- plain entry x\n- plain entry y\n",
		);
		const r = pair(plain, merged);
		assert.equal(r.code, 1);
		assert.match(r.out, /different heading/);
	});
	test("is refused: a block inserted mid-list pulls the lines after it under Known issues", () => {
		const base = log("\n", "## [1.1.0] - 2026-01-01\n\n### Added\n\n- feature a\n- feature b\n");
		const merged = log(
			"\n",
			"## [1.1.0] - 2026-01-01\n\n### Added\n\n- feature a\n\n### Known issues\n\n- ki 1\n\n- feature b\n",
		);
		assert.equal(pair(base, merged).code, 1);
	});
	test("is allowed: a block at the end of a plain-list section", () => {
		const plain = log("\n", "## [1.1.0] - 2026-01-01\n\n- plain entry x\n- plain entry y\n");
		const merged = log(
			"\n",
			"## [1.1.0] - 2026-01-01\n\n- plain entry x\n- plain entry y\n\n### Known issues\n\n- ki 1\n",
		);
		const r = pair(plain, merged);
		assert.equal(r.code, 0, r.out);
	});
	test("is refused: a line added after the Known issues block ends", () => {
		const withBlock = CUT.replace(
			"- Feature B.\n",
			"- Feature B.\n\n### Known issues\n\n- First issue.\n",
		);
		const merged = withBlock.replace(
			"- First issue.\n",
			"- First issue.\n\n### Changed\n\n- Slipped in.\n",
		);
		assert.equal(pair(withBlock, merged).code, 1);
	});
	test("is refused: an existing line of the block is reworded", () => {
		const withBlock = CUT.replace(
			"- Feature B.\n",
			"- Feature B.\n\n### Known issues\n\n- First issue.\n",
		);
		assert.equal(
			pair(withBlock, withBlock.replace("First issue.", "First issue, reworded.")).code,
			1,
		);
	});
	test("is refused together with an edit to an existing line", () => {
		const merged = CUT.replace(
			"- Feature B.\n",
			"- Feature B, reworded.\n\n### Known issues\n\n- A known issue.\n",
		);
		assert.equal(pair(CUT, merged).code, 1);
	});
});

describe("an edit to a released section", () => {
	test("is refused: a changed line", () => {
		const r = pair(CUT, CUT.replace("Old entry B.", "Old entry B, edited."));
		assert.equal(r.code, 1);
		assert.match(r.out, /inside the released section \[5\.1\.0\]/);
	});
	test("is refused: an added line", () => {
		const r = pair(CUT, CUT.replace("- Feature A.\n", "- Feature A.\n- Added late.\n"));
		assert.equal(r.code, 1);
		assert.match(r.out, /\[5\.3\.0\]/);
	});
	test("is refused: a removed line", () => {
		assert.equal(pair(CUT, CUT.replace("- Feature B.\n", "")).code, 1);
	});
	test("is refused: a removed section", () => {
		const r = pair(CUT, CUT.replace(/## \[5\.1\.0\][\s\S]*$/, ""));
		assert.equal(r.code, 1);
		assert.match(r.out, /is gone/);
	});
	test("is refused: a changed heading date", () => {
		assert.equal(pair(CUT, CUT.replace("5.2.0] - 2026-10-26", "5.2.0] - 2026-10-27")).code, 1);
	});
	test("is refused together with a legitimate Unreleased entry", () => {
		const merged = CUT.replace("## [5.3.0]", "- A new entry.\n\n## [5.3.0]").replace(
			"Old entry B.",
			"Old entry B, edited.",
		);
		assert.equal(pair(CUT, merged).code, 1);
	});
	test("is refused: the text above the first section", () => {
		assert.equal(pair(PRE_CUT, PRE_CUT.replace("All notable", "Most notable")).code, 1);
	});
	test("is refused: released sections reordered", () => {
		const swapped = log(
			"\n",
			"## [5.1.0] - 2026-10-18\n\n### Fixed\n\n- Old entry B.\n\n",
			"## [5.2.0] - 2026-10-26\n\n### Added\n\n- Old entry A.\n",
		);
		assert.equal(pair(CUT, swapped).code, 1);
	});
});

describe("a pull request cut from a base that predates a cut (the case that put an entry under 5.3.0)", () => {
	// master: PRE_CUT, then the cut lands. The branch was cut from PRE_CUT and adds an entry at the end of Unreleased,
	// next to the heading the cut inserts. git merges the two cleanly, and the merge result holds the entry inside
	// the released section.
	function realMerge() {
		const dir = newRepo();
		const preCut = commit(dir, PRE_CUT, "pre-cut");
		git(dir, "branch", "pr");
		const cut = commit(dir, CUT, "cut");
		git(dir, "checkout", "-q", "pr");
		commit(
			dir,
			log("\n### Added\n\n- Feature A.\n- Feature B.\n- Entry from the late branch.\n\n", R520),
			"pr",
		);
		git(dir, "checkout", "-q", "master");
		git(dir, "merge", "--no-ff", "-q", "-m", "merge", "pr");
		const merged = git(dir, "rev-parse", "HEAD");
		return { dir, preCut, cut, merged };
	}

	test("git merges it cleanly into the released section (the precondition this row exists for)", () => {
		const { dir, merged } = realMerge();
		const text = git(dir, "show", `${merged}:CHANGELOG.md`);
		const at = text.indexOf("Entry from the late branch.");
		assert.ok(at > text.indexOf("## [5.3.0]"), "the entry landed below the 5.3.0 heading");
	});
	test("is refused when the merge result is graded against the base it merged into", () => {
		const { dir, cut, merged } = realMerge();
		const r = runGuard(dir, cut, merged);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /added to the released section \[5\.3\.0\] outside/);
	});
	test("would have passed if graded as the branch alone against its own base (why the merge result is read)", () => {
		const { dir, preCut } = realMerge();
		const branch = git(dir, "rev-parse", "pr");
		assert.equal(runGuard(dir, preCut, branch).code, 0);
	});
	test("is allowed once the branch is rebased onto the cut and the entry sits under [Unreleased]", () => {
		const merged = log(
			"\n### Added\n\n- Entry from the late branch.\n\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n- Feature B.\n\n",
			R520,
		);
		assert.equal(pair(CUT, merged).code, 0);
	});
});

describe("usage and failures", () => {
	test("wrong argument count exits 2", () => {
		const r = spawnSync("node", [GUARD], { cwd: scratch, env: ENV, encoding: "utf8" });
		assert.equal(r.status, 2);
	});
	test("a revision git cannot resolve exits 2, never 0", () => {
		const dir = newRepo();
		const a = commit(dir, PRE_CUT, "a");
		assert.equal(runGuard(dir, a, "nonexistent-rev").code, 2);
	});
});

describe("mutants: each rule, switched off, lets its refused row through", () => {
	function mutate(from, to) {
		assert.equal(GUARD_SOURCE.split(from).length - 1, 1, `anchor appears exactly once: ${from}`);
		const path = join(scratch, `mutant-${++counter}.mjs`);
		writeFileSync(path, GUARD_SOURCE.replace(from, to));
		return path;
	}
	const editReleased = [CUT, CUT.replace("Old entry B.", "Old entry B, edited.")];
	const addOutsideKnownIssues = [
		CUT,
		CUT.replace("- Feature B.\n", "- Feature B.\n- Slipped in.\n"),
	];
	const dropsAnEntry = [
		PRE_CUT,
		log("\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n\n", R520),
	];
	const leftBehind = [
		PRE_CUT,
		log(
			"\n- Left behind.\n\n## [5.3.0] - 2026-11-01\n\n### Added\n\n- Feature A.\n- Feature B.\n\n",
			R520,
		),
	];

	test("control: the unmutated guard refuses every row", () => {
		for (const rows of [editReleased, addOutsideKnownIssues, dropsAnEntry, leftBehind]) {
			assert.equal(pair(...rows).code, 1);
		}
	});
	test("M1: without the in-order match of a released section's lines, an edit to one is allowed", () => {
		const guard = mutate("problems.push(rewritten(b.key));", "void rewritten(b.key);");
		assert.equal(pair(...editReleased, guard).code, 0);
	});
	test("M2: without the Known issues limit, a line added anywhere in a released section is allowed", () => {
		const guard = mutate("!kept.has(i) && !region.has(i)", "false");
		assert.equal(pair(...addOutsideKnownIssues, guard).code, 0);
	});
	test("M3: without the every-entry rule, a cut that drops an entry is allowed", () => {
		const guard = mutate("return matchInOrder(wanted, lines) !== null;", "return true;");
		assert.equal(pair(...dropsAnEntry, guard).code, 0);
	});
	test("M5: without the heading check, a block inserted above existing lines relabels them", () => {
		const guard = mutate("headingAt(baseLines, j) !== headingAt(mergedLines, matched[j])", "false");
		const plain = log("\n", "## [1.1.0] - 2026-01-01\n\n- plain entry x\n- plain entry y\n");
		const merged = log(
			"\n",
			"## [1.1.0] - 2026-01-01\n\n### Known issues\n\n- ki 1\n\n- plain entry x\n- plain entry y\n",
		);
		assert.equal(pair(plain, merged).code, 1);
		assert.equal(pair(plain, merged, guard).code, 0);
	});
	test("M4: without the emptied-Unreleased rule, a cut that leaves entries behind is allowed", () => {
		const guard = mutate(
			"const emptied = contentLines(mergedUnreleased).length === 0;",
			"const emptied = true;",
		);
		assert.equal(pair(...leftBehind, guard).code, 0);
	});
});
