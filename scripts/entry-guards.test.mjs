// The "is this file the command being run?" guard of scripts/changelog-guard.mjs and scripts/tested-tree-verdict.mjs.
//
// import.meta.url is percent-encoded and has its symlinks resolved; process.argv[1] is neither. A plain comparison of the two is false under a
// path with a space or a symlinked directory (macOS /tmp and /var are symlinks), and then the script exits 0 WITHOUT RUNNING: a CI step that
// calls it passes whatever it was given. These rows run the REAL scripts, copied to a temp tree, from four paths: plain, with a space, through
// a symlink, and through a symlink to a path with a space. A bad input must exit non-zero with the script's own message, a good one must
// exit 0. The control rows put the OLD guard back and show it exits 0 silently, so the rows can fail.
//
// Run with `node --test scripts/entry-guards.test.mjs`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const SCRIPTS = ["changelog-guard.mjs", "tested-tree-verdict.mjs"];
// The OLD guards, as they stood before the fix.
const OLD = {
	"changelog-guard.mjs": 'import.meta.url === pathToFileURL(process.argv[1] ?? "").href',
	"tested-tree-verdict.mjs": `import.meta.url === \`file://\${process.argv[1]}\``,
};
// What the new guard text is replaced by to restore the old behaviour in a control copy.
const NEW_GUARD = "runAsCommand";

const root = realpathSync(mkdtempSync(join(tmpdir(), "entry-guards-")));
after(() => rmSync(root, { recursive: true, force: true }));

/** Copy the scripts into <dir>/scripts; with `old`, put the previous guard back. */
function install(dir, old) {
	mkdirSync(join(dir, "scripts"), { recursive: true });
	for (const name of SCRIPTS) {
		const from = new URL(`./${name}`, import.meta.url);
		const to = join(dir, "scripts", name);
		if (!old) {
			copyFileSync(from, to);
			continue;
		}
		const text = readFileSync(from, "utf8");
		const i = text.lastIndexOf("if (runAsCommand)");
		assert.notEqual(i, -1, `${name} has no runAsCommand guard`);
		const start = text.lastIndexOf("const runAsCommand", i);
		assert.notEqual(start, -1);
		writeFileSync(to, `${text.slice(0, start)}${text.slice(i).replace(NEW_GUARD, OLD[name])}`);
	}
}

/** The four ways to reach one install, each as a directory whose `scripts/` holds the files. */
function variants(tag, old) {
	const realPlain = join(root, `${tag}-real`);
	const realSpace = join(root, `${tag} real dir`);
	install(realPlain, old);
	install(realSpace, old);
	const linkPlain = join(root, `${tag}-link`);
	const linkSpace = join(root, `${tag} link dir`);
	symlinkSync(realPlain, linkPlain, "dir");
	symlinkSync(realSpace, linkSpace, "dir");
	return {
		plain: realPlain,
		space: realSpace,
		symlink: linkPlain,
		"symlink and space": linkSpace,
	};
}

const ENV = {
	PATH: process.env.PATH,
	HOME: root,
	LANG: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
};

// a repository whose CHANGELOG is the same at both revisions: the good input for changelog-guard
const repo = join(root, "fixture-repo");
mkdirSync(repo);
writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
for (const args of [
	["init", "-q"],
	["add", "CHANGELOG.md"],
	["commit", "-q", "-m", "x"],
]) {
	const r = spawnSync("git", args, { cwd: repo, env: ENV, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
}

const run = (script, args, env = {}, cwd = repo) =>
	spawnSync(process.execPath, [script, ...args], {
		cwd,
		env: { ...ENV, ...env },
		encoding: "utf8",
	});

const GOOD_RESULTS = JSON.stringify({ build: { result: "success" } });
const SHA = "a".repeat(40);

for (const [name, dir] of Object.entries(variants("new", false))) {
	describe(`the fixed guards, run from a ${name} path`, () => {
		test("changelog-guard: a bad call prints its usage and exits 2; a good one exits 0", () => {
			const script = join(dir, "scripts", "changelog-guard.mjs");
			const bad = run(script, []);
			assert.equal(bad.status, 2, `${bad.stdout}${bad.stderr}`);
			assert.match(bad.stderr, /usage: changelog-guard\.mjs <base> <merged>/);
			const good = run(script, ["HEAD", "HEAD"]);
			assert.equal(good.status, 0, good.stderr);
			assert.match(good.stdout, /nothing to check/);
		});

		test("tested-tree-verdict: unusable input exits 2 with its message; every job passing exits 0 with the stamp", () => {
			const script = join(dir, "scripts", "tested-tree-verdict.mjs");
			const bad = run(script, [], { RESULTS: "not json", REQUIRED: "build", TESTED_SHA: SHA });
			assert.equal(bad.status, 2, `${bad.stdout}${bad.stderr}`);
			assert.match(bad.stderr, /RESULTS is not JSON/);
			const failed = run(script, [], {
				RESULTS: JSON.stringify({ build: { result: "failure" } }),
				REQUIRED: "build",
				TESTED_SHA: SHA,
			});
			assert.equal(failed.status, 1);
			assert.match(failed.stdout, /NOT passed: build=failure/);
			const good = run(script, [], { RESULTS: GOOD_RESULTS, REQUIRED: "build", TESTED_SHA: SHA });
			assert.equal(good.status, 0, good.stderr);
			assert.match(good.stdout, new RegExp(`::notice title=tested-tree::tested-tree ${SHA}`));
		});
	});
}

// Positive control: the OLD guards. From the paths below they exit 0 and print NOTHING, even on input that must fail, which is the failure the
// rows above exist to catch. (The old changelog-guard handled a space, since pathToFileURL encodes it, and failed only through a symlink; the old
// tested-tree-verdict built `file://` by hand and failed on both.)
const OLD_SILENT = {
	"changelog-guard.mjs": ["symlink", "symlink and space"],
	"tested-tree-verdict.mjs": ["space", "symlink", "symlink and space"],
};
for (const [name, dir] of Object.entries(variants("old", true))) {
	describe(`the OLD guards, run from a ${name} path (positive control)`, () => {
		for (const script of SCRIPTS) {
			test(`${script} ${OLD_SILENT[script].includes(name) ? "exits 0 SILENTLY on a bad input" : "still runs"}`, () => {
				const file = join(dir, "scripts", script);
				const r =
					script === "changelog-guard.mjs"
						? run(file, [])
						: run(file, [], { RESULTS: "not json", REQUIRED: "build", TESTED_SHA: SHA });
				if (OLD_SILENT[script].includes(name)) {
					assert.equal(r.status, 0);
					assert.equal(r.stdout, "");
					assert.equal(r.stderr, "");
				} else {
					assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
				}
			});
		}
	});
}

// timing-thresholds.mts, typecheck-tests.mts and fleet-collector.mts had the same flaw in another spelling (`resolve(argv[1])` against a
// symlink-resolved path). timing-thresholds is the one that is cheap and prints on success, so it stands for the three: run it through a
// symlink to this repository's scripts/ directory, from a path with a space, and it must say so instead of exiting 0 in silence. (Before the
// fix the same run printed nothing at all.)
describe("the .mts entry guards", () => {
	test("timing-thresholds.mts, run through a symlinked path with a space, still runs", () => {
		const repoRoot = realpathSync(new URL("..", import.meta.url));
		const link = join(root, "mts link dir");
		symlinkSync(join(repoRoot, "scripts"), link, "dir");
		const r = spawnSync(
			process.execPath,
			["--import", "tsx", join(link, "timing-thresholds.mts")],
			{
				cwd: repoRoot,
				env: { ...ENV },
				encoding: "utf8",
			},
		);
		assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
		assert.match(r.stdout, /timing-thresholds: OK/);
	});
});
