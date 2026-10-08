// The agent-config guard (agent-config-guard.mjs) and its launcher (.github/agent-config.sh),
// run against fixture repositories: each commit is built from a full file map through a
// temporary index, so no working tree is ever checked out. Run with
// `node --test scripts/agent-config-guard.test.mjs`; CI runs it before the guard itself.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

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
 */
function fixture() {
	const root = mkdtempSync(join(scratch, "repo-"));
	const git = (args, input) =>
		execFileSync("git", args, { cwd: root, env: ENV, input, encoding: "utf-8" }).trim();
	git(["init", "-q", "-b", "master"]);
	const snapshots = new Map();
	let n = 0;
	return {
		root,
		commit(changes, parent = null) {
			const files = new Map(parent === null ? [] : snapshots.get(parent));
			for (const [path, value] of Object.entries(changes)) {
				if (value === null) files.delete(path);
				else files.set(path, value);
			}
			const index = join(root, ".git", `fixture-index-${n++}`);
			const withIndex = (args, input) =>
				execFileSync("git", args, {
					cwd: root,
					env: { ...ENV, GIT_INDEX_FILE: index },
					input,
					encoding: "utf-8",
				}).trim();
			for (const [path, value] of files) {
				let mode = "100644";
				let oid;
				if (typeof value === "string") {
					oid = withIndex(["hash-object", "-w", "--stdin"], value);
				} else if (value.link !== undefined) {
					mode = "120000";
					oid = withIndex(["hash-object", "-w", "--stdin"], value.link);
				} else {
					mode = "160000";
					oid = value.submodule;
				}
				withIndex(["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
			}
			const tree = withIndex(["write-tree"]);
			const sha = git(
				["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", `fixture ${n}`],
				"",
			);
			snapshots.set(sha, files);
			return sha;
		},
	};
}

/** An allowlist file's text: `entries` are `{ path, why, sha256? }`. */
const allowlist = (entries = []) => JSON.stringify({ allow: entries });

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

/** The launcher, as ci.yml runs it, for a pull request unless `event` says otherwise. */
function launch(repo, base, head, event = "pull_request") {
	const run = spawnSync("bash", [LAUNCHER, event, base, head], {
		cwd: repo.root,
		env: ENV,
		encoding: "utf-8",
	});
	return { status: run.status, out: run.stdout + run.stderr };
}

/** A repository whose base holds `allow` and `files`, and a head with `changes` on top. */
function change(changes, { allow = [], files = {} } = {}) {
	const repo = fixture();
	const base = repo.commit({ "README.md": "hello\n", [ALLOWLIST]: allowlist(allow), ...files });
	const head = repo.commit(changes, base);
	return { repo, base, head, run: () => guard(repo, { rules: base, base, head }) };
}

/** Assert a run failed (exit 1), with a failure line naming `path` and holding `reason`. */
function fails({ status, out }, path, reason) {
	assert.equal(status, 1, out);
	const lines = out
		.split("\n")
		.filter(
			(line) =>
				line.startsWith("agent-config: FAILED (rule ") &&
				line.includes(`: ${JSON.stringify(path)} `),
		);
	assert.ok(
		lines.some((line) => line.includes(` ${reason}`)),
		`expected ${JSON.stringify(path)} ${reason}, in:\n${out}`,
	);
}

/** Assert a run passed (exit 0). */
function passes({ status, out }) {
	assert.equal(status, 0, out);
	assert.match(out, /agent-config: OK/, out);
}

const UNNAMED = "is agent config, and the allowlist does not name it";

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
	test("bad JSON, an unknown field, a pin on a glob, a bad pin, or no allowlist at all", () => {
		for (const text of [
			"{",
			JSON.stringify({ allow: [], extra: 1 }),
			JSON.stringify({ allow: [{ path: ".mcp.json", why: "t", note: "x" }] }),
			JSON.stringify({ allow: [{ path: ".claude/**", why: "t", sha256: sha256("x") }] }),
			JSON.stringify({ allow: [{ path: ".mcp.json", why: "t", sha256: "beef" }] }),
			JSON.stringify({ allow: [{ path: ".mcp.json", why: "" }] }),
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

	test("a base or head that is not a commit cannot be checked", () => {
		const repo = fixture();
		const base = repo.commit({ "README.md": "x", ...guardFiles() });
		for (const [b, h] of [
			["0000000000000000000000000000000000000000", base],
			[base, "0000000000000000000000000000000000000000"],
		]) {
			const { status, out } = launch(repo, b, h);
			assert.equal(status, 2, out);
			assert.match(out, /CANNOT CHECK: \w+ is not a commit here/);
		}
		const { status, out } = launch(repo, base, base, "merge_group");
		assert.equal(status, 2, out);
		assert.match(out, /usage: agent-config\.sh <pull_request\|push> <base> <head>/);
	});
});
