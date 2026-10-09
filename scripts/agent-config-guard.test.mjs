// The agent-config guard (agent-config-guard.mjs) and its launcher (.github/agent-config.sh),
// run against fixture repositories: each commit is built from a full file map through a
// temporary index, so no working tree is ever checked out. Run with
// `node --test scripts/agent-config-guard.test.mjs`; CI runs it AFTER the guard itself, as
// the workflow tests below pin: these tests are the change's own code.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

const GUARD = join(import.meta.dirname, "agent-config-guard.mjs");
const LAUNCHER = join(import.meta.dirname, "..", ".github", "agent-config.sh");
const ALLOWLIST = ".github/agent-config-allowlist.json";

const scratch = mkdtempSync(join(tmpdir(), "agent-config-guard-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** git with no user or system config, so a developer's settings never change a result. */
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

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * A fixture repository. `commit(changes, parent)` makes a commit holding the parent's
 * files with `changes` applied: a path maps to its content, `{ link }` for a symlink,
 * `{ submodule }` for a gitlink, or null to delete it. Returns the commit's sha.
 * `merge(base, head)` makes the merge commit a pull request is tested as.
 */
function fixture() {
	const root = mkdtempSync(join(scratch, "repo-"));
	const git = (args, input, env = ENV) =>
		execFileSync("git", args, { cwd: root, env, input, encoding: "utf-8" }).trim();
	git(["init", "-q", "-b", "master"]);
	const snapshots = new Map();
	const blobs = new Map();
	/** The blob holding `content`, written once. */
	const object = (content) => {
		if (!blobs.has(content)) blobs.set(content, git(["hash-object", "-w", "--stdin"], content));
		return blobs.get(content);
	};
	let n = 0;
	return {
		root,
		commit(changes, parent = null) {
			const files = new Map(parent === null ? [] : snapshots.get(parent));
			for (const [path, value] of Object.entries(changes)) {
				if (value === null) files.delete(path);
				else files.set(path, value);
			}
			let entries = "";
			for (const [path, value] of files) {
				let entry;
				if (typeof value === "string") entry = `100644 ${object(value)}`;
				else if (value.link !== undefined) entry = `120000 ${object(value.link)}`;
				else entry = `160000 ${value.submodule}`;
				entries += `${entry}\t${path}\0`;
			}
			const env = { ...ENV, GIT_INDEX_FILE: join(root, ".git", `fixture-index-${n++}`) };
			git(["update-index", "-z", "--add", "--index-info"], entries, env);
			const tree = git(["write-tree"], undefined, env);
			const sha = git(
				["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", `fixture ${n}`],
				"",
			);
			snapshots.set(sha, files);
			return sha;
		},
		/** The merge commit GitHub tests for a pull request of `head` into `base`: base first. */
		merge(base, head) {
			const tree = git(["merge-tree", "--write-tree", base, head]).split("\n")[0];
			return git(["commit-tree", tree, "-p", base, "-p", head, "-m", `merge ${n++}`], "");
		},
		/** A file's content at a commit (`<commit>:<path>`), as it is. */
		blob(spec) {
			return execFileSync("git", ["cat-file", "blob", spec], {
				cwd: root,
				env: ENV,
				encoding: "utf-8",
			});
		},
	};
}

/** An allowlist file's text: `entries` are `{ path, why, sha256? }`, `nonportable` `{ path, why }`. */
const allowlist = (entries = [], nonportable = undefined) =>
	JSON.stringify(nonportable === undefined ? { allow: entries } : { allow: entries, nonportable });

/** The guard, its launcher and an allowlist, as this repository has them. */
const guardFiles = (entries = []) => ({
	"scripts/agent-config-guard.mjs": readFileSync(GUARD, "utf-8"),
	".github/agent-config.sh": readFileSync(LAUNCHER, "utf-8"),
	[ALLOWLIST]: allowlist(entries),
});

/** The guard run directly, its rules (the allowlist) read from `rules`. */
function guard(repo, { rules, base, head, event = "pull_request" }) {
	const run = spawnSync(
		process.execPath,
		[GUARD, "--event", event, "--rules", rules, "--base", base, "--head", head],
		{ cwd: repo.root, env: ENV, encoding: "utf-8" },
	);
	return { status: run.status, out: run.stdout + run.stderr };
}

/** The launcher, run with `args`. */
function launcher(repo, ...args) {
	const run = spawnSync("bash", [LAUNCHER, ...args], {
		cwd: repo.root,
		env: ENV,
		encoding: "utf-8",
	});
	return { status: run.status, out: run.stdout + run.stderr };
}

/**
 * The launcher, as ci.yml runs it: for a pull request (unless `event` says otherwise), the
 * merge commit GitHub tests, `head` merged into `base`; for a push, `base` to `head`.
 */
function launch(repo, base, head, event = "pull_request") {
	return event === "pull_request"
		? launcher(repo, event, repo.merge(base, head))
		: launcher(repo, event, base, head);
}

/** A repository whose base holds `allow`, `nonportable` and `files`, and a head with `changes`. */
function change(changes, { allow = [], nonportable = undefined, files = {} } = {}) {
	const repo = fixture();
	const base = repo.commit({
		"README.md": "hello\n",
		[ALLOWLIST]: allowlist(allow, nonportable),
		...files,
	});
	const head = repo.commit(changes, base);
	return { repo, base, head, run: () => guard(repo, { rules: base, base, head }) };
}

/** Text as the guard's log shows it: JSON, with each code point outside printable ASCII escaped. */
const shown = (text) =>
	JSON.stringify(text).replace(/[^ -~]/gu, (c) =>
		c
			.split("")
			.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join(""),
	);

/** Assert a run failed (exit 1), with a failure line naming `path` and holding `reason`. */
function fails({ status, out }, path, reason) {
	assert.equal(status, 1, out);
	const lines = out
		.split("\n")
		.filter(
			(line) =>
				line.startsWith("agent-config: FAILED (rule ") && line.includes(`: ${shown(path)} `),
		);
	assert.ok(
		lines.some((line) => line.includes(` ${reason}`)),
		`expected ${shown(path)} ${reason}, in:\n${out}`,
	);
}

/** Assert a run passed (exit 0). */
function passes({ status, out }) {
	assert.equal(status, 0, out);
	assert.match(out, /agent-config: OK/, out);
}

const UNNAMED = "is agent config, and the allowlist does not name it";
/** Rule 3's reason for an added name holding `codePoints` outside the portable set. */
const outside = (...codePoints) =>
	`holds ${codePoints.join(", ")}, outside the portable set (A-Z a-z 0-9 . _ - [ ]), and the allowlist's "nonportable" list does not name it`;
/** Rule 3's reason for an added name that folds to `other`. */
const another = (other) => `folds to ${shown(other)}, another name in the tree`;
/** Rule 3's reason for an added path whose directory `name` folds to `other`. */
const within = (name, other) =>
	`holds ${shown(name)}, which folds to ${shown(other)}, another name in the tree`;

describe("rule 1: agent config the allowlist does not name fails, in every status", () => {
	test("an added .claude/ file fails", () => {
		fails(change({ ".claude/settings.json": "{}" }).run(), ".claude/settings.json", UNNAMED);
	});

	test("an added .mcp.json fails, at the root and nested", () => {
		const { run } = change({ ".mcp.json": "{}", "packages/x/.mcp.json": "{}" });
		const result = run();
		fails(result, ".mcp.json", UNNAMED);
		fails(result, "packages/x/.mcp.json", UNNAMED);
	});

	test("an added .grok/ file fails", () => {
		fails(change({ ".grok/sandbox.toml": "x" }).run(), ".grok/sandbox.toml", UNNAMED);
	});

	test("an added .codex/ file fails", () => {
		fails(change({ ".codex/config.toml": "x" }).run(), ".codex/config.toml", UNNAMED);
	});

	test("agent config nested at any depth fails", () => {
		fails(change({ "a/b/.claude/commands/x.md": "x" }).run(), "a/b/.claude/commands/x.md", UNNAMED);
	});

	test("a case or trailing-dot variant, as a case-insensitive filesystem or Windows opens it, fails", () => {
		const result = change({
			".Claude/settings.json": "{}",
			"pkg/.MCP.JSON": "{}",
			".claude./hooks/x.sh": "x",
			".grok /x": "x",
		}).run();
		for (const path of [
			".Claude/settings.json",
			"pkg/.MCP.JSON",
			".claude./hooks/x.sh",
			".grok /x",
		]) {
			fails(result, path, UNNAMED);
		}
	});

	test("a compatibility spelling counts as the name it folds to (NFKC): a fullwidth \uFF4A", () => {
		fails(change({ "pkg/.mcp.\uFF4Ason": "{}" }).run(), "pkg/.mcp.\uFF4Ason", UNNAMED);
	});

	// HFS+ ignores these code points in a name, as git's own list has them: each range's first
	// and last, inside `.mcp.json`, still names an MCP server list.
	for (const [range, first, last] of [
		["U+200C to U+200F", "\u200C", "\u200F"],
		["U+202A to U+202E", "\u202A", "\u202E"],
		["U+206A to U+206F", "\u206A", "\u206F"],
		["U+FEFF", "\uFEFF", "\uFEFF"],
	]) {
		test(`a code point HFS+ ignores (${range}) counts as the name without it`, () => {
			const paths = [`pkg/.mcp.j${first}son`, `.mc${last}p.json`];
			const result = change(Object.fromEntries(paths.map((path) => [path, "{}"]))).run();
			for (const path of paths) fails(result, path, UNNAMED);
		});
	}

	test("an edit to agent config that was already there fails", () => {
		const { run } = change(
			{ ".codex/config.toml": "after" },
			{ files: { ".codex/config.toml": "before" } },
		);
		fails(run(), ".codex/config.toml", UNNAMED);
	});

	test("a deletion of agent config fails", () => {
		const { run } = change(
			{ ".claude/commands/x.md": null },
			{ files: { ".claude/commands/x.md": "x" } },
		);
		fails(run(), ".claude/commands/x.md", UNNAMED);
	});

	test("a rename into agent config fails, and one out of it", () => {
		const into = change(
			{ "docs/x.json": null, ".claude/settings.json": '{"a":1}\n'.repeat(20) },
			{
				files: { "docs/x.json": '{"a":1}\n'.repeat(20) },
			},
		);
		fails(into.run(), ".claude/settings.json", UNNAMED);
		const out = change(
			{ ".claude/x.md": null, "docs/x.md": "same\n".repeat(20) },
			{
				files: { ".claude/x.md": "same\n".repeat(20) },
			},
		);
		fails(out.run(), ".claude/x.md", UNNAMED);
	});

	test("control: the same changes on allowlisted paths pass, by an exact path and by a glob", () => {
		passes(
			change(
				{ ".mcp.json": "{}", ".claude/commands/x.md": "x", ".claude/commands/deep/y.md": "y" },
				{
					allow: [
						{ path: ".mcp.json", why: "test" },
						{ path: ".claude/commands/**", why: "test" },
					],
				},
			).run(),
		);
	});

	test("control: a change that touches no agent config passes", () => {
		passes(
			change({
				"docs/claude.md": "x",
				"src/mcp.json": "{}",
				".claude-plugin/plugin.json": "{}",
			}).run(),
		);
	});

	test("agent config that is a link or a submodule fails, allowlisted or not", () => {
		const repo = fixture();
		const other = repo.commit({ "x.md": "x" });
		const base = repo.commit({
			"README.md": "x",
			[ALLOWLIST]: allowlist([{ path: ".claude/**", why: "test" }]),
		});
		const head = repo.commit(
			{ ".claude/settings.json": { link: "../evil.json" }, ".grok": { submodule: other } },
			base,
		);
		const result = guard(repo, { rules: base, base, head });
		fails(
			result,
			".claude/settings.json",
			"is agent config that is not a regular file (mode 120000)",
		);
		fails(result, ".grok", "is agent config that is not a regular file (mode 160000)");
	});
});

describe("an allowlist entry may pin an exact file's sha256", () => {
	test("a pinned file edited fails; the same edit, with the pin updated in the rules, passes", () => {
		const repo = fixture();
		const pin = (text) => [{ path: ".mcp.json", why: "test", sha256: sha256(text) }];
		const base = repo.commit({ ".mcp.json": "v1", [ALLOWLIST]: allowlist(pin("v1")) });
		const head = repo.commit({ ".mcp.json": "v2" }, base);
		fails(
			guard(repo, { rules: base, base, head }),
			".mcp.json",
			"is pinned by the allowlist, and the change leaves other content",
		);
		const repinned = repo.commit({ [ALLOWLIST]: allowlist(pin("v2")) }, base);
		passes(guard(repo, { rules: repinned, base, head }));
	});

	test("a pin holds even when a glob before it names the same file", () => {
		const repo = fixture();
		const base = repo.commit({
			".grok/sandbox.toml": "v1",
			[ALLOWLIST]: allowlist([
				{ path: ".grok/**", why: "test" },
				{ path: ".grok/sandbox.toml", why: "test", sha256: sha256("v1") },
			]),
		});
		const head = repo.commit({ ".grok/sandbox.toml": "v2", ".grok/plugins/x.sh": "x" }, base);
		const result = guard(repo, { rules: base, base, head });
		fails(
			result,
			".grok/sandbox.toml",
			"is pinned by the allowlist, and the change leaves other content",
		);
		assert.doesNotMatch(result.out, /"\.grok\/plugins\/x\.sh"/u, result.out);
	});

	test("a pinned file removed fails", () => {
		const repo = fixture();
		const base = repo.commit({
			".grok/sandbox.toml": "v1",
			[ALLOWLIST]: allowlist([{ path: ".grok/sandbox.toml", why: "test", sha256: sha256("v1") }]),
		});
		const head = repo.commit({ ".grok/sandbox.toml": null }, base);
		fails(
			guard(repo, { rules: base, base, head }),
			".grok/sandbox.toml",
			"is pinned by the allowlist, and the change removes it",
		);
	});

	test("a pinned file changed on the base after the change branched, not by the change, passes: the change is base...head", () => {
		const repo = fixture();
		const pin = (text) => allowlist([{ path: ".mcp.json", why: "test", sha256: sha256(text) }]);
		const fork = repo.commit({ ".mcp.json": "v1", [ALLOWLIST]: pin("v1") });
		const base = repo.commit({ ".mcp.json": "v2", [ALLOWLIST]: pin("v2") }, fork);
		const head = repo.commit({ "README.md": "x" }, fork);
		passes(guard(repo, { rules: base, base, head }));
	});
});

describe("a pin holds for its path as written, and no file may stand for it under another spelling", () => {
	// U+017F, LATIN SMALL LETTER LONG S, folds to `s`: macOS's filesystem opens `.mcp.jſon`
	// as `.mcp.json`, so writing one writes the other.
	const ALIAS = ".grok/plugins/x/.mcp.j\u017Fon";
	const PINNED = ".grok/plugins/x/.mcp.json";
	/** A glob that names both spellings, and a pin on one of them. */
	const rules = (content) => [
		{ path: ".grok/plugins/**", why: "test" },
		{ path: PINNED, why: "test", sha256: sha256(content) },
	];
	const standsFor = (pin) =>
		`folds to the pinned path ${shown(pin)}: a case-insensitive filesystem opens both as one file`;

	test("a spelling of a pinned file added beside it fails, by its name and as the pinned file", () => {
		const { run } = change(
			{ [ALIAS]: "replaced" },
			{ allow: rules("pinned"), files: { [PINNED]: "pinned" } },
		);
		const result = run();
		fails(result, ALIAS, outside("U+017F"));
		fails(result, ALIAS, another(PINNED));
		fails(result, ALIAS, standsFor(PINNED));
	});

	test("a spelling of an absent pinned file fails, with the pinned content, named by its exact bytes", () => {
		const result = change(
			{ [ALIAS]: "pinned" },
			{ allow: rules("pinned"), nonportable: [{ path: ALIAS, why: "test" }] },
		).run();
		fails(result, ALIAS, standsFor(PINNED));
		assert.doesNotMatch(
			result.out,
			/outside the portable set|another name in the tree/u,
			result.out,
		);
	});

	test("a spelling of a pinned file already in the tree fails, whatever the change touches", () => {
		// It came in before the pin did: it fails every change until one removes it.
		const { run } = change(
			{ "README.md": "edited" },
			{ allow: rules("pinned"), files: { [ALIAS]: "pinned" } },
		);
		fails(run(), ALIAS, standsFor(PINNED));
	});

	test("an ASCII spelling of an absent pinned file fails too", () => {
		const { run } = change(
			{ ".Grok/plugins/x/.mcp.json": "replaced" },
			{ allow: [{ path: "**", why: "test" }, ...rules("pinned")] },
		);
		fails(run(), ".Grok/plugins/x/.mcp.json", standsFor(PINNED));
	});

	test("control: the pinned file at its pinned content passes, and so does removing its other spelling", () => {
		passes(change({ [PINNED]: "pinned" }, { allow: rules("pinned") }).run());
		passes(
			change({ [ALIAS]: null }, { allow: rules("pinned"), files: { [ALIAS]: "pinned" } }).run(),
		);
	});
});

describe("rule 3: every path a change adds is one name to every filesystem, anywhere in the repository", () => {
	test("an added file that folds to another file by ASCII case fails, agent config or not", () => {
		const { run } = change(
			{ "docs/guide.md": "two", ".claude/hooks/Run.sh": "two" },
			{
				allow: [{ path: ".claude/hooks/**", why: "test" }],
				files: { "docs/Guide.md": "one", ".claude/hooks/run.sh": "one" },
			},
		);
		const result = run();
		fails(result, "docs/guide.md", another("docs/Guide.md"));
		fails(result, ".claude/hooks/Run.sh", another(".claude/hooks/run.sh"));
	});

	test("an added file that folds to a directory fails, and so does a directory that folds to a file or a directory", () => {
		// A case-insensitive checkout holds one of the two: when the file wins, the directory's
		// files are absent, a pinned MCP server list among them, and its pin cannot object.
		const MCP = "apps/session-bus/plugin/.mcp.json";
		const overDir = change(
			{ "apps/Session-Bus": "x" },
			{ allow: [{ path: MCP, why: "test", sha256: sha256("{}") }], files: { [MCP]: "{}" } },
		);
		fails(overDir.run(), "apps/Session-Bus", another("apps/session-bus"));
		const overFile = change({ "notes/todo/x.md": "x" }, { files: { "notes/Todo": "x" } });
		fails(overFile.run(), "notes/todo/x.md", within("notes/todo", "notes/Todo"));
		const dirOverDir = change({ "src/lib/b.ts": "x" }, { files: { "src/Lib/a.ts": "x" } });
		fails(dirOverDir.run(), "src/lib/b.ts", within("src/lib", "src/Lib"));
	});

	test("an added name outside the portable set fails, unless the allowlist names it by its exact bytes: a long s over a directory, a fullwidth letter", () => {
		const { run } = change(
			{ ".grok/plugins/session-bu\u017F": "x", "docs/\uFF52eadme.md": "x" },
			{
				allow: [{ path: ".grok/plugins/**", why: "test" }],
				files: { ".grok/plugins/session-bus/.mcp.json": "{}" },
			},
		);
		const result = run();
		fails(result, ".grok/plugins/session-bu\u017F", outside("U+017F"));
		fails(result, "docs/\uFF52eadme.md", outside("U+FF52"));
	});

	test("a name the allowlist names by its exact bytes fails all the same when it folds to another: by case, by NFKC, or by a code point HFS+ ignores", () => {
		const added = [".grok/plugins/session-bu\u017F", "docs/\uFF52eadme.md", "docs/gu\u200Cide.md"];
		const { run } = change(Object.fromEntries(added.map((path) => [path, "x"])), {
			allow: [{ path: ".grok/plugins/**", why: "test" }],
			nonportable: added.map((path) => ({ path, why: "test" })),
			files: {
				".grok/plugins/session-bus/.mcp.json": "{}",
				"docs/readme.md": "x",
				"docs/guide.md": "x",
			},
		});
		const result = run();
		fails(result, added[0], another(".grok/plugins/session-bus"));
		fails(result, added[1], another("docs/readme.md"));
		fails(result, added[2], another("docs/guide.md"));
		assert.doesNotMatch(result.out, /outside the portable set/u, result.out);
	});

	test("a name the allowlist names by its exact bytes, folding to no other, passes; the same name in other bytes does not", () => {
		const nonportable = [{ path: "docs/caf\u00E9.md", why: "test" }];
		passes(change({ "docs/caf\u00E9.md": "x" }, { nonportable }).run());
		// Decomposed (NFD), it is the same name in other bytes, which the entry does not name.
		fails(
			change({ "docs/cafe\u0301.md": "x" }, { nonportable }).run(),
			"docs/cafe\u0301.md",
			outside("U+0301"),
		);
	});

	test("control: an added portable name that folds to no other passes, and so does a case-only rename, of a file or a directory", () => {
		passes(change({ "site/app/r/[id]/page-2_v1.0.tsx": "x" }).run());
		passes(
			change(
				{
					".claude/hooks/Run.sh": null,
					".claude/hooks/run.sh": "one",
					"src/Lib/a.ts": null,
					"src/lib/a.ts": "a",
				},
				{
					allow: [{ path: ".claude/hooks/**", why: "test" }],
					files: { ".claude/hooks/Run.sh": "one", "src/Lib/a.ts": "a" },
				},
			).run(),
		);
	});

	test("a Windows short name fails: ~ is outside the portable set, so CLAUDE~1/settings.json cannot stand for .claude/settings.json", () => {
		const { run } = change({ "CLAUDE~1/settings.json": "{}" });
		fails(run(), "CLAUDE~1/settings.json", outside("U+007E"));
	});

	test("two added names that fold alike fail, each against the other: what is checked is the change's own tree", () => {
		const result = change({
			"docs/A.md": "1",
			"docs/a.md": "2",
			"x/One/a": "1",
			"x/one/b": "2",
		}).run();
		fails(result, "docs/A.md", another("docs/a.md"));
		fails(result, "docs/a.md", another("docs/A.md"));
		fails(result, "x/One/a", within("x/One", "x/one"));
		fails(result, "x/one/b", within("x/one", "x/One"));
	});

	test("an alternate data stream, a backslash, a space or a control character in a name fails", () => {
		const result = change(
			{
				".claude/settings.json:x": "{}",
				"docs\\x.md": "x",
				"docs/a b.md": "x",
				"docs/a\tb.md": "x",
			},
			{ allow: [{ path: ".claude/**", why: "test" }] },
		).run();
		fails(result, ".claude/settings.json:x", outside("U+003A"));
		fails(result, "docs\\x.md", outside("U+005C"));
		fails(result, "docs/a b.md", outside("U+0020"));
		fails(result, "docs/a\tb.md", outside("U+0009"));
	});

	/**
	 * Every path of `paths` added in one change, under the allowlist `rules` (its text) with
	 * every path allowlisted and the rest of it kept, its `nonportable` list included.
	 */
	function reAdd(paths, rules) {
		const repo = fixture();
		const everything = { ...JSON.parse(rules), allow: [{ path: "**", why: "test" }] };
		const base = repo.commit({ [ALLOWLIST]: JSON.stringify(everything) });
		const head = repo.commit(Object.fromEntries(paths.map((path) => [path, "{}"])), base);
		return guard(repo, { rules: base, base, head });
	}

	test("control: every path this repository holds passes when a change adds it", () => {
		const here = (args) =>
			execFileSync("git", args, { cwd: import.meta.dirname, env: ENV, encoding: "utf-8" });
		const paths = here(["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"])
			.split("\0")
			.filter((path) => path !== "");
		assert.ok(paths.length > 100, `${paths.length} paths: not this repository's tree`);
		const result = reAdd(paths, here(["cat-file", "blob", `HEAD:${ALLOWLIST}`]));
		passes(result);
		assert.match(result.out, new RegExp(`OK \\(${paths.length} paths changed`, "u"), result.out);
	});

	test("the re-add keeps the allowlist's own nonportable list: a tree with a name it lists passes", () => {
		const name = "docs/caf\u00E9.md";
		const listed = JSON.stringify({ allow: [], nonportable: [{ path: name, why: "test" }] });
		passes(reAdd(["README.md", name], listed));
		// Control: the same tree, the name unlisted, fails on it.
		fails(reAdd(["README.md", name], JSON.stringify({ allow: [] })), name, outside("U+00E9"));
	});
});

describe("agent config is checked out as it is stored: no attribute may rewrite it", () => {
	const ALLOW = [{ path: "**", why: "test" }];
	const FILES = { ".claude/settings.json": "{}", ".mcp.json": "{}", ".claude/hooks/run.sh": "x" };
	const rewrites = (attribute, value) =>
		`is agent config that checkout rewrites (${attribute} ${shown(value)})`;
	const rewritten = (attribute, value) =>
		`is an attributes file that checkout rewrites (${attribute} ${shown(value)})`;

	test("working-tree-encoding, a filter, or ident, set by a .gitattributes the change adds, fails", () => {
		const { run } = change(
			{
				".gitattributes":
					".claude/settings.json working-tree-encoding=UTF-16\n.mcp.json filter=lfs\n.claude/hooks/* ident\n",
			},
			{ allow: ALLOW, files: FILES },
		);
		const result = run();
		fails(result, ".claude/settings.json", rewrites("working-tree-encoding", "UTF-16"));
		fails(result, ".mcp.json", rewrites("filter", "lfs"));
		fails(result, ".claude/hooks/run.sh", rewrites("ident", "set"));
	});

	test("a pattern that matches only with case, or only without it, counts: an agent may open either kind of checkout", () => {
		const { run } = change(
			{
				".gitattributes":
					"* filter=x\n.CLAUDE/** -filter\n.CLAUDE/settings.json working-tree-encoding=UTF-16\n",
			},
			{ allow: ALLOW, files: FILES },
		);
		const result = run();
		// With case, `.CLAUDE/**` misses, so `* filter=x` holds; without it, the encoding does.
		fails(result, ".claude/settings.json", rewrites("filter", "x"));
		fails(result, ".claude/settings.json", rewrites("working-tree-encoding", "UTF-16"));
	});

	test("a .gitattributes in a directory counts, and so does a macro", () => {
		const { run } = change(
			{
				".gitattributes": "[attr]evil filter=x\n",
				".claude/hooks/.gitattributes": "run.sh evil\n",
			},
			{ allow: ALLOW, files: FILES },
		);
		fails(run(), ".claude/hooks/run.sh", rewrites("filter", "x"));
	});

	test("an attributes file holding a NUL byte fails: git stops reading it there, so this check could not read it as git does", () => {
		// Git reads this line as `.claude/settings.json filter=unset`, which check-attr prints as no
		// filter, and the literal scan reads one token running on past the NUL.
		const { run } = change(
			{ ".gitattributes": ".claude/settings.json filter=unset\0x\n" },
			{ allow: ALLOW, files: FILES },
		);
		fails(run(), ".gitattributes", "holds a NUL byte, where git stops reading it");
	});

	test("an attributes file spelled otherwise fails: a case-insensitive filesystem opens it as .gitattributes", () => {
		const { run } = change(
			{ "pkg/.GitAttributes": "* filter=x\n" },
			{ allow: ALLOW, files: FILES },
		);
		fails(run(), "pkg/.GitAttributes", 'is ".gitattributes" to a case-insensitive filesystem');
	});

	test("an attributes file that gives one of them the literal value unset or unspecified fails, a macro's included: check-attr prints that as no value", () => {
		const { run } = change(
			{
				".gitattributes": [
					".claude/settings.json filter=unset",
					".mcp.json working-tree-encoding=unspecified",
					"[attr]quiet ident=unset",
					".claude/hooks/* quiet",
					"# ident=unspecified is a comment, not an assignment",
					"  # working-tree-encoding=unset after blanks is a comment too",
					// A vertical tab is no blank to git: this line's pattern is "\v#x", and it assigns.
					"\v#x filter=unspecified",
					"* text=unset",
					"",
				].join("\n"),
			},
			{ allow: ALLOW, files: FILES },
		);
		const result = run();
		const literal = (token) => `holds ${shown(token)}: check-attr prints that as no value`;
		for (const token of [
			"filter=unset",
			"working-tree-encoding=unspecified",
			"ident=unset",
			"filter=unspecified",
		]) {
			fails(result, ".gitattributes", literal(token));
		}
		// Exactly those four: not the comments', and not `text`, which rewrites no bytes here.
		const lines = result.out.split("\n").filter((line) => line.includes("check-attr prints that"));
		assert.equal(lines.length, 4, result.out);
	});

	test("an attributes file that checkout rewrites fails, nested or not, with no agent config in the change", () => {
		const { run } = change({
			".gitattributes": "pkg/.gitattributes working-tree-encoding=UTF-16LE\n",
			"pkg/.gitattributes": "*.txt text\n",
		});
		fails(run(), "pkg/.gitattributes", rewritten("working-tree-encoding", "UTF-16LE"));
	});

	test("an attributes file that gives itself a transform fails, by its own name or by a pattern", () => {
		const { run } = change({
			".gitattributes": "* ident\n",
			"pkg/.gitattributes": ".gitattributes filter=x\n",
		});
		const result = run();
		fails(result, ".gitattributes", rewritten("ident", "set"));
		fails(result, "pkg/.gitattributes", rewritten("filter", "x"));
		fails(result, "pkg/.gitattributes", rewritten("ident", "set"));
	});

	test("rules that checkout would rewrite cannot shield a pinned file: an encoded attributes file that unsets the encoding for the .mcp.json beside it fails", () => {
		// At checkout git writes plugin/.gitattributes as UTF-16LE, stops reading it at its first
		// NUL, and loses the override: a later restore of the pinned .mcp.json writes it UTF-16LE,
		// though its blob, and so its pin, never change. Read from the tree, the override holds, so
		// the .mcp.json alone passes; the attributes file is what fails.
		const mcp = '{"mcpServers":{}}\n';
		const { run } = change(
			{
				".gitattributes":
					"plugin/.gitattributes working-tree-encoding=UTF-16LE\nplugin/.mcp.json working-tree-encoding=UTF-16LE\n",
				"plugin/.gitattributes": ".mcp.json -working-tree-encoding\n",
			},
			{
				allow: [{ path: "plugin/.mcp.json", why: "test", sha256: sha256(mcp) }],
				files: { "plugin/.mcp.json": mcp },
			},
		);
		const result = run();
		fails(result, "plugin/.gitattributes", rewritten("working-tree-encoding", "UTF-16LE"));
		assert.ok(!result.out.includes(`${shown("plugin/.mcp.json")} is agent config`), result.out);
	});

	test("an attributes file that is not a regular file fails, at the root and nested: git before 2.32 reads a symlinked one through its link", () => {
		const { run } = change({
			".gitattributes": { link: "docs/rules.txt" },
			"docs/rules.txt": "*.json -filter\n",
			"pkg/.gitattributes": { link: "../docs/rules.txt" },
			"lib/.gitattributes": { submodule: "0123456789abcdef0123456789abcdef01234567" },
		});
		const result = run();
		const notRegular = (mode) => `is an attributes file that is not a regular file (mode ${mode})`;
		fails(result, ".gitattributes", notRegular("120000"));
		fails(result, "pkg/.gitattributes", notRegular("120000"));
		fails(result, "lib/.gitattributes", notRegular("160000"));
	});

	test("control: attributes files no transform applies to pass, at the root and nested, beside transforms of other paths", () => {
		passes(
			change({
				".gitattributes": "* text=auto eol=lf\ndocs/** filter=lfs ident\n",
				"pkg/.gitattributes": "*.bin -text\n",
				"docs/notes.md": "notes\n",
			}).run(),
		);
	});

	test("control: attributes that leave the bytes alone pass, and so do transforms of paths that are not agent config", () => {
		passes(
			change(
				{
					".gitattributes":
						"* text=auto eol=lf\n*.json -filter\n.claude/hooks/* -ident\ndocs/** filter=lfs working-tree-encoding=UTF-16 ident\n",
				},
				{ allow: ALLOW, files: FILES },
			).run(),
		);
	});
});

describe("a submodule is another repository: one a change adds or moves must be on the allowlist", () => {
	const SUBMODULE =
		"is a submodule, whose own tree can hold agent config, and the allowlist does not name it";

	test("a submodule the change adds fails unless the allowlist names it; a regular file at its path passes", () => {
		const repo = fixture();
		const inside = repo.commit({ ".claude/settings.json": JSON.stringify({ hooks: {} }) });
		const base = repo.commit({ "README.md": "x", [ALLOWLIST]: allowlist() });
		const added = repo.commit({ "vendor/tool": { submodule: inside } }, base);
		fails(guard(repo, { rules: base, base, head: added }), "vendor/tool", SUBMODULE);
		const named = repo.commit(
			{ [ALLOWLIST]: allowlist([{ path: "vendor/tool", why: "test" }]) },
			base,
		);
		passes(guard(repo, { rules: named, base, head: added }));
		// Control: a regular file at that path is no submodule.
		const file = repo.commit({ "vendor/tool": "x" }, base);
		passes(guard(repo, { rules: base, base, head: file }));
	});

	test("a submodule moved to another commit fails unless the allowlist names it; one removed passes", () => {
		const repo = fixture();
		const one = repo.commit({ "a.md": "1" });
		const two = repo.commit({ ".claude/settings.json": "{}" }, one);
		const base = repo.commit({
			"README.md": "x",
			[ALLOWLIST]: allowlist(),
			"vendor/tool": { submodule: one },
		});
		const moved = repo.commit({ "vendor/tool": { submodule: two } }, base);
		fails(guard(repo, { rules: base, base, head: moved }), "vendor/tool", SUBMODULE);
		const named = repo.commit(
			{ [ALLOWLIST]: allowlist([{ path: "vendor/**", why: "test" }]) },
			base,
		);
		passes(guard(repo, { rules: named, base, head: moved }));
		const removed = repo.commit({ "vendor/tool": null }, base);
		passes(guard(repo, { rules: base, base, head: removed }));
	});
});

describe("the guard as a module: imported with ?library it checks nothing, run as a script it checks", () => {
	test("imported with ?library, it exports its fold and checks nothing; run as a script, it checks", () => {
		const url = `${pathToFileURL(GUARD).href}?library`;
		const source = `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify([m.fold(".MCP.JSON"), m.folded("pkg/.Claude./settings.json")]));`;
		const imported = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
			env: ENV,
			encoding: "utf-8",
		});
		assert.equal(imported.status, 0, imported.stdout + imported.stderr);
		assert.equal(
			imported.stdout,
			`${JSON.stringify([".mcp.json", "pkg/.claude/settings.json"])}\n`,
		);
		// Control: the same file run as a script checks, and with no arguments cannot.
		const script = spawnSync(process.execPath, [GUARD], { env: ENV, encoding: "utf-8" });
		assert.equal(script.status, 2, script.stdout + script.stderr);
		assert.match(script.stdout, /^agent-config: CANNOT CHECK: /u);
	});
});

describe("rule 2: a committed Claude Code settings file holds only permitted keys", () => {
	const SETTINGS = [{ path: "**/.claude/settings*.json", why: "test" }];
	const settings = (value, path = ".claude/settings.json") =>
		change(
			{ [path]: typeof value === "string" ? value : JSON.stringify(value) },
			{ allow: SETTINGS },
		).run();

	test("a settings file holding any key that is not permitted fails, each key on its own", () => {
		for (const key of [
			"env",
			"hooks",
			"statusLine",
			"apiKeyHelper",
			"awsAuthRefresh",
			"awsCredentialExport",
			"otelHeadersHelper",
			"enabledPlugins",
			"extraKnownMarketplaces",
			"enableAllProjectMcpServers",
			"enabledMcpjsonServers",
			"fileSuggestion",
			"subagentStatusLine",
			"mcpServers",
			"aSettingClaudeCodeShipsNextYear",
		]) {
			fails(
				settings({ [key]: {} }),
				".claude/settings.json",
				`holds the key "${key}", which is not permitted`,
			);
		}
	});

	test("permissions that loosen fail: allow, defaultMode, additionalDirectories", () => {
		for (const key of ["allow", "defaultMode", "additionalDirectories"]) {
			fails(
				settings({ permissions: { deny: [], [key]: ["Bash"] } }),
				".claude/settings.json",
				`holds "permissions.${key}", which is not permitted`,
			);
		}
	});

	test("a settings file that is not valid JSON, or not a JSON object, fails", () => {
		fails(settings("{ // a comment\n}"), ".claude/settings.json", "is not valid JSON");
		fails(settings("[]"), ".claude/settings.json", "is not a JSON object");
	});

	test("a settings file at any depth, and settings.local.json, is checked", () => {
		fails(
			settings({ env: {} }, "pkg/.claude/settings.local.json"),
			"pkg/.claude/settings.local.json",
			'holds the key "env"',
		);
	});

	test("a settings file the change does not touch is checked too: the whole tree is", () => {
		const { run } = change(
			{ "README.md": "edited" },
			{ allow: SETTINGS, files: { ".claude/settings.json": JSON.stringify({ env: { A: "1" } }) } },
		);
		fails(run(), ".claude/settings.json", 'holds the key "env"');
	});

	test("a key or a permission holding a C1 control is named escaped, never raw", () => {
		const key = "x\u009B2J";
		const named = settings({ [key]: {} });
		fails(named, ".claude/settings.json", `holds the key ${shown(key)}, which is not permitted`);
		const rule = settings({ permissions: { [key]: [] } });
		fails(
			rule,
			".claude/settings.json",
			`holds "permissions.${shown(key).slice(1, -1)}", which is not permitted`,
		);
		for (const { out } of [named, rule]) assert.ok(!out.includes("\u009B"), out);
	});

	test("control: $schema, and permissions that only tighten (deny, ask), pass", () => {
		passes(
			settings({
				$schema: "https://json.schemastore.org/claude-code-settings.json",
				permissions: { deny: ["Bash(rm:*)"], ask: ["WebFetch"] },
			}),
		);
	});
});

describe("an allowlist that is not valid cannot check anything: exit 2", () => {
	test("bad JSON, an unknown field, a pin on a glob, a bad pin, a nonportable entry that is not one, or no allowlist at all", () => {
		for (const text of [
			"{",
			JSON.stringify({ allow: [], extra: 1 }),
			JSON.stringify({ allow: [{ path: ".mcp.json", why: "t", note: "x" }] }),
			JSON.stringify({ allow: [{ path: ".claude/**", why: "t", sha256: sha256("x") }] }),
			JSON.stringify({ allow: [{ path: ".mcp.json", why: "t", sha256: "beef" }] }),
			JSON.stringify({ allow: [{ path: ".mcp.json", why: "" }] }),
			JSON.stringify({ nonportable: [] }),
			JSON.stringify({ allow: [], nonportable: {} }),
			JSON.stringify({ allow: [], nonportable: null }),
			JSON.stringify({ allow: [], nonportable: [{ path: "docs/x.md", why: "t" }] }),
			JSON.stringify({ allow: [], nonportable: [{ path: "docs/caf\u00E9.md", why: "" }] }),
			JSON.stringify({
				allow: [],
				nonportable: [{ path: "docs/caf\u00E9.md", why: "t", sha256: sha256("x") }],
			}),
			JSON.stringify({ allow: [], nonportable: [{ path: "docs/\uFFFD.md", why: "t" }] }),
			null,
		]) {
			const repo = fixture();
			const base = repo.commit({
				"README.md": "x",
				...(text === null ? {} : { [ALLOWLIST]: text }),
			});
			const head = repo.commit({ "README.md": "y" }, base);
			const { status, out } = guard(repo, { rules: base, base, head });
			assert.equal(status, 2, `${text}: ${out}`);
			assert.match(out, /CANNOT CHECK/, out);
		}
	});
});

describe("the launcher runs the guard and its allowlist as the BASE has them", () => {
	test("a change that adds agent config AND allowlists it fails: the base's allowlist decides", () => {
		const repo = fixture();
		const base = repo.commit({ "README.md": "x", ...guardFiles() });
		const head = repo.commit(
			{
				".claude/settings.json": "{}",
				[ALLOWLIST]: allowlist([{ path: ".claude/settings.json", why: "mine" }]),
			},
			base,
		);
		fails(launch(repo, base, head), ".claude/settings.json", UNNAMED);
	});

	test("control: the same file, allowlisted at the base, passes", () => {
		const repo = fixture();
		const base = repo.commit({
			"README.md": "x",
			...guardFiles([{ path: ".claude/settings.json", why: "test" }]),
		});
		const head = repo.commit({ ".claude/settings.json": "{}" }, base);
		passes(launch(repo, base, head));
	});

	test("a change that weakens the guard, and adds agent config, fails: the base's guard runs", () => {
		const repo = fixture();
		const base = repo.commit({ "README.md": "x", ...guardFiles() });
		const head = repo.commit(
			{ "scripts/agent-config-guard.mjs": "console.log('agent-config: OK');\n", ".mcp.json": "{}" },
			base,
		);
		fails(launch(repo, base, head), ".mcp.json", UNNAMED);
	});

	test("the change that introduces the guard runs its own copy: clean, it passes; with agent config, it fails", () => {
		const repo = fixture();
		const base = repo.commit({ "README.md": "x" });
		const clean = repo.commit(guardFiles(), base);
		const introduced = launch(repo, base, clean);
		passes(introduced);
		assert.match(introduced.out, /this change introduces it, and runs its own copy/);
		const dirty = repo.commit({ ...guardFiles(), ".claude/commands/x.md": "x" }, base);
		fails(launch(repo, base, dirty), ".claude/commands/x.md", UNNAMED);
	});

	test("a base that runs the check but has lost the guard fails, never falling back to the change's copy", () => {
		const repo = fixture();
		const files = guardFiles();
		delete files["scripts/agent-config-guard.mjs"];
		const base = repo.commit({ "README.md": "x", ...files });
		const head = repo.commit(
			{ "scripts/agent-config-guard.mjs": readFileSync(GUARD, "utf-8") },
			base,
		);
		const { status, out } = launch(repo, base, head);
		assert.equal(status, 1, out);
		assert.match(
			out,
			/FAILED: the base \(\w+\) runs this check, but has no scripts\/agent-config-guard\.mjs/,
		);
	});

	test("a push is checked from before to after", () => {
		const repo = fixture();
		const before = repo.commit({ "README.md": "x", ...guardFiles() });
		const after = repo.commit({ ".codex/config.toml": "x" }, before);
		fails(launch(repo, before, after, "push"), ".codex/config.toml", UNNAMED);
	});

	test("a push that rewrites the branch is checked tip to tip: agent config the old tip had, and the new one drops, counts", () => {
		const repo = fixture();
		const fork = repo.commit({
			"README.md": "x",
			...guardFiles([{ path: ".grok/sandbox.toml", why: "test", sha256: sha256("v1") }]),
		});
		const before = repo.commit({ ".grok/sandbox.toml": "v1" }, fork);
		const after = repo.commit({ "README.md": "rewritten" }, fork);
		fails(
			launch(repo, before, after, "push"),
			".grok/sandbox.toml",
			"is pinned by the allowlist, and the change removes it",
		);
		// Control: a pull request with the same commits is its own changes only, from where it branched.
		passes(launch(repo, before, after));
	});

	test("a pull request is checked as the merge commit GitHub tests: a pinned file both sides edited lands as content no pin names", () => {
		const repo = fixture();
		const entry = (text) => [{ path: ".grok/sandbox.toml", why: "test", sha256: sha256(text) }];
		const fork = repo.commit({
			"README.md": "x",
			".grok/sandbox.toml": "a\nb\nc\nd\ne\n",
			...guardFiles(entry("a\nb\nc\nd\ne\n")),
		});
		// After the fork, the base edits the file's first line in the two pull requests a pinned
		// file takes, then re-pins it to the content the branch's last line edit gives.
		const repinned = repo.commit({ [ALLOWLIST]: allowlist(entry("A\nb\nc\nd\ne\n")) }, fork);
		const edited = repo.commit({ ".grok/sandbox.toml": "A\nb\nc\nd\ne\n" }, repinned);
		const base = repo.commit({ [ALLOWLIST]: allowlist(entry("a\nb\nc\nd\nE\n")) }, edited);
		const head = repo.commit({ ".grok/sandbox.toml": "a\nb\nc\nd\nE\n" }, fork);
		// Control: graded on the branch's head alone, the change passes, as the base pins its file.
		passes(guard(repo, { rules: base, base, head }));
		// What lands is the merge of both edits, content no pin names.
		const merge = repo.merge(base, head);
		assert.equal(repo.blob(`${merge}:.grok/sandbox.toml`), "A\nb\nc\nd\nE\n");
		fails(
			launcher(repo, "pull_request", merge),
			".grok/sandbox.toml",
			"is pinned by the allowlist, and the change leaves other content",
		);
	});

	test("a guard that exits 0 without its OK line as its last word fails the launcher: it did not say it checked", () => {
		const OK_LINE =
			"agent-config: OK (1 paths changed, 0 of them agent config; 0 settings files in the tree)";
		const run = (stub) => {
			const repo = fixture();
			const base = repo.commit({
				"README.md": "x",
				...guardFiles(),
				"scripts/agent-config-guard.mjs": stub,
			});
			return launch(repo, base, repo.commit({ "README.md": "y" }, base));
		};
		for (const stub of [
			"process.exit(0);\n",
			"console.log('agent-config: OK');\n",
			`console.log(${JSON.stringify(OK_LINE)}); console.log("and then something else");\n`,
		]) {
			const { status, out } = run(stub);
			assert.equal(status, 1, `${stub}: ${out}`);
			assert.match(out, /agent-config: FAILED: the guard exited 0 without its OK line/u, out);
		}
		// Control: the OK line as its last word is what counts, whatever printed it.
		const { status, out } = run(`console.log(${JSON.stringify(OK_LINE)});\n`);
		assert.equal(status, 0, out);
	});

	test("a pull request that is not a merge commit, or a commit that is not here, cannot be checked", () => {
		const repo = fixture();
		const base = repo.commit({ "README.md": "x", ...guardFiles() });
		const head = repo.commit({ "README.md": "y" }, base);
		const missing = "0".repeat(40);
		for (const args of [
			["pull_request", missing],
			["push", missing, head],
			["push", base, missing],
		]) {
			const { status, out } = launcher(repo, ...args);
			assert.equal(status, 2, out);
			assert.match(out, new RegExp(`CANNOT CHECK: ${missing} is not a commit here`));
		}
		// The branch's head alone is never what is checked.
		const branch = launcher(repo, "pull_request", head);
		assert.equal(branch.status, 2, branch.out);
		assert.match(branch.out, /CANNOT CHECK: \w+ is not a merge commit/);
		for (const args of [
			["merge_group", base, head],
			["pull_request", base, head],
			["push", head],
		]) {
			const { status, out } = launcher(repo, ...args);
			assert.equal(status, 2, out);
			assert.match(
				out,
				/usage: agent-config\.sh pull_request <merge-commit> \| push <before> <after>/,
			);
		}
	});

	/** `origin` holding a pinned file the old tip had, the branch rewritten, and a clone of its refs. */
	function rewritten() {
		const origin = fixture();
		const fork = origin.commit({
			"README.md": "x",
			...guardFiles([{ path: ".grok/sandbox.toml", why: "test", sha256: sha256("v1") }]),
		});
		const before = origin.commit({ ".grok/sandbox.toml": "v1" }, fork);
		const after = origin.commit({ "README.md": "rewritten" }, fork);
		const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" });
		git(origin.root, "update-ref", "refs/heads/master", after);
		git(origin.root, "config", "uploadpack.allowAnySHA1InWant", "true");
		const clone = mkdtempSync(join(scratch, "clone-"));
		git(scratch, "clone", "--quiet", "--no-local", origin.root, clone);
		const has = (sha) =>
			spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: clone, env: ENV }).status ===
			0;
		return { clone: { root: clone }, before, after, has };
	}

	test("a push whose old tip is on no ref is fetched from origin by its sha, then checked tip to tip", () => {
		const { clone, before, after, has } = rewritten();
		// Control: the clone lacks the old tip, as a checkout of every ref does after the rewrite.
		assert.equal(has(before), false);
		fails(
			launch(clone, before, after, "push"),
			".grok/sandbox.toml",
			"is pinned by the allowlist, and the change removes it",
		);
		assert.equal(has(before), true);
	});

	test("a commit that origin does not have either cannot be checked: exit 2", () => {
		const { clone, after } = rewritten();
		const missing = "1".repeat(40);
		const { status, out } = launch(clone, missing, after, "push");
		assert.equal(status, 2, out);
		assert.match(out, new RegExp(`CANNOT CHECK: ${missing} is not a commit here`));
	});
});

describe("the workflow runs the guard before any code of the change, and only for a change", () => {
	const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");
	const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

	/** The `agent-config` job's lines, from whichever workflow defines it: exactly one does. */
	function job() {
		const found = [];
		for (const name of readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/u.test(n))) {
			const lines = readFileSync(join(WORKFLOWS, name), "utf-8").split("\n");
			const start = lines.indexOf("  agent-config:");
			if (start === -1) continue;
			const next = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:/u.test(line));
			found.push({ name, lines: lines.slice(start, next === -1 ? lines.length : next) });
		}
		assert.equal(
			found.length,
			1,
			`workflows defining an agent-config job: ${found.map((f) => f.name)}`,
		);
		return found[0].lines;
	}

	/** The job's steps, in order, each as its text. */
	function steps(lines) {
		const all = [];
		for (const line of lines) {
			if (line.startsWith("      - ")) all.push([line]);
			else if (all.length > 0 && line.startsWith("        ")) all.at(-1).push(line);
		}
		return all.map((step) => step.join("\n"));
	}

	/** The guard's step: the one that runs the launcher. */
	const guardStep = (all) => all.findIndex((step) => step.includes(".github/agent-config.sh"));

	test("only the checkout runs before the guard; the node setup and the guard's tests after it", () => {
		const all = steps(job());
		const guard = guardStep(all);
		assert.ok(guard > 0, `no guard step:\n${all.join("\n")}`);
		for (const step of all.slice(0, guard)) {
			assert.match(step, /^ {6}(- | {2})uses: actions\/checkout@v\d+$/mu, step);
			assert.doesNotMatch(step, /^ {8}run:/mu, step);
		}
		const setup = all.findIndex((step) => step.includes("actions/setup-node@"));
		assert.ok(setup > guard, `a node setup runs before the guard:\n${all.join("\n")}`);
		const tests = all.findIndex((step) => step.includes("node --test"));
		assert.ok(tests > guard, `the tests run before the guard:\n${all.join("\n")}`);
	});

	test("the launcher runs from the graded commit's object, never from the working tree", () => {
		const all = steps(job());
		const guard = all[guardStep(all)];
		assert.match(
			guard,
			/^ {10}git cat-file blob "\$SHA:\.github\/agent-config\.sh" > "\$launcher"$/mu,
			guard,
		);
		assert.match(guard, /^ {12}bash "\$launcher" pull_request "\$SHA"$/mu, guard);
		assert.match(guard, /^ {12}bash "\$launcher" push "\$BEFORE" "\$SHA"$/mu, guard);
		assert.doesNotMatch(guard, /bash \.github\/agent-config\.sh/u, guard);
	});

	test("no package-manager cache: every node setup in the job turns it off", () => {
		const setups = steps(job()).filter((step) => step.includes("actions/setup-node@"));
		assert.ok(setups.length > 0, "no node setup: the control cannot reach anything");
		for (const step of setups) {
			assert.match(step, /^ {10}package-manager-cache: false$/mu, step);
		}
	});

	test("an event that is not a change checks nothing, under a name branch protection does not require", () => {
		const lines = job();
		const change = "github.event_name == 'pull_request' || github.event_name == 'push'";
		assert.ok(
			lines.includes(
				`    name: \${{ (${change}) && 'agent-config' || 'agent-config (no change to check)' }}`,
			),
			lines.join("\n"),
		);
		const guard = steps(lines).find((step) => step.includes(".github/agent-config.sh"));
		assert.match(guard, new RegExp(`^        if: ${literal(change)}$`, "mu"), guard);
	});

	test("a pull request is checked as the merge commit GitHub tests (github.sha), never the branch's head", () => {
		const guard = steps(job()).find((step) => step.includes(".github/agent-config.sh"));
		assert.match(guard, /^ {10}SHA: \$\{\{ github\.sha \}\}$/mu, guard);
		assert.match(guard, /^ {12}bash "\$launcher" pull_request "\$SHA"$/mu, guard);
		assert.doesNotMatch(guard, /pull_request\.(head|base)\.sha/u, guard);
	});

	test("CODEOWNERS names an owner for the launcher, the allowlist, the guard and its tests", () => {
		const owners = readFileSync(join(import.meta.dirname, "..", ".github", "CODEOWNERS"), "utf-8");
		for (const path of [
			"/.github/",
			"/.github/agent-config-allowlist.json",
			"/scripts/agent-config-guard.mjs",
			"/scripts/agent-config-guard.test.mjs",
		]) {
			assert.match(owners, new RegExp(`^${literal(path)} @\\S+`, "mu"), path);
		}
	});
});
