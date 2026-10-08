#!/usr/bin/env node
// The agent-config guard: ci.yml's `agent-config` job, through `.github/agent-config.sh`.
//
// Agent config is what a coding agent runs, or obeys, when it opens a checkout of this
// repository: Claude Code's `.claude/` (settings, hooks, commands), an MCP server list
// (`.mcp.json`), and the Grok and Codex CLIs' `.grok/` and `.codex/`, at any depth. A
// change that adds some runs on every machine that opens its checkout in an agent. So:
// 1. Every agent-config path the change touches must be on the allowlist
//    (`.github/agent-config-allowlist.json`), whatever its status: added, modified,
//    deleted, and both sides of a rename. An entry is a path or a glob (`*` within one
//    segment, `**` across them), with its `why`. An exact path may pin its `sha256`: a
//    change that leaves it any other content, or none, fails.
//    In the change's tree, every agent-config path must be a regular file: a link or a
//    submodule there could carry config these rules never read.
// 2. Every Claude Code settings file in the change's tree (`.claude/settings*.json`, at
//    any depth), allowlisted or not, must be a JSON object holding only the permitted
//    keys: `$schema`, and `permissions` that only tighten (`deny`, `ask`). Any other
//    key fails, a key this guard has never heard of included: a list of the keys that
//    run something goes stale each time Claude Code ships a setting.
// Agent-config paths are recognized as a case-insensitive filesystem, or Windows, opens
// them (`.Claude/`, `.MCP.JSON`, `.claude./`); allowlist entries match exactly.
//
// The change is what `--event` says it is:
// - for a pull request, `base...head`: its own changes, from where it branched;
// - for a push, `base..head`, tip to tip. A push that rewrites the branch removes what
//   the old tip had, and that counts too.
//
// The allowlist is read from `--rules`, which the launcher sets to the BASE, as it runs
// the base's copy of this script: a change is never graded by its own rules. Node
// built-ins and git only, so it runs before any dependency is installed.
//
// Usage: node agent-config-guard.mjs --event <pull_request|push> --rules <commit>
//                                    --base <commit> --head <commit>
// Exit 0 when the change passes; 1 when it fails, each failure named; 2 when it cannot be
// checked (a usage or git error, or an allowlist that is not valid).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ALLOWLIST = ".github/agent-config-allowlist.json";

/** Directories whose every file is agent config, at any depth. */
const AGENT_DIRS = new Set([".claude", ".grok", ".codex"]);
/** Files that are agent config wherever they are. */
const AGENT_FILES = new Set([".mcp.json"]);
/** The keys `permissions` may hold: rules that only ever make an agent ask, or refuse. */
const PERMISSION_KEYS = new Set(["deny", "ask"]);
/** A regular file's modes: anything else (a link, 120000; a submodule, 160000) is not one. */
const REGULAR = new Set(["100644", "100755"]);

/** A run that cannot be checked: exit 2, never a pass. */
class Unusable extends Error {}

/** `git` in the repository's top level, its config held to what the checks need. */
function git(args, encoding = "utf-8") {
	try {
		return execFileSync(
			"git",
			["-c", "diff.relative=false", "-c", "core.quotePath=true", ...args],
			{ encoding, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (err) {
		throw new Unusable(`git ${args[0]} failed: ${String(err?.stderr ?? err).trim()}`);
	}
}

/**
 * A path segment as a case-insensitive filesystem, or Windows, resolves it: case folded
 * (`ſ` is `s`), and trailing dots and spaces dropped.
 */
const fold = (segment) =>
	segment
		.normalize("NFC")
		.toUpperCase()
		.toLowerCase()
		.replace(/[. ]+$/u, "");

/** Whether `path` is agent config: under an agent directory, or an MCP server list. */
function isAgentConfig(path) {
	const segments = path.split("/").map(fold);
	return segments.some((s) => AGENT_DIRS.has(s)) || AGENT_FILES.has(segments.at(-1));
}

/** Whether `path` is a Claude Code settings file: `.claude/settings*.json`, at any depth. */
function isSettings(path) {
	const segments = path.split("/").map(fold);
	return (
		segments.length >= 2 &&
		segments.at(-2) === ".claude" &&
		/^settings[^/]*\.json$/u.test(segments.at(-1))
	);
}

/** A glob's matcher: `**` across segments, `*` within one, every other character itself. */
function globMatcher(glob) {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		if (glob[i] !== "*") {
			source += glob[i].replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
		} else if (glob[i + 1] !== "*") {
			source += "[^/]*";
		} else if (glob[i + 2] === "/") {
			source += "(?:.*/)?";
			i += 2;
		} else {
			source += ".*";
			i += 1;
		}
	}
	const pattern = new RegExp(`^${source}$`, "u");
	return (path) => pattern.test(path);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The allowlist at `commit`, each entry with its matcher; Unusable when it is not one. */
function readAllowlist(commit) {
	let text;
	try {
		text = execFileSync("git", ["cat-file", "blob", `${commit}:${ALLOWLIST}`], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		throw new Unusable(`the rules commit ${commit} has no ${ALLOWLIST}`);
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Unusable(`${ALLOWLIST} is not valid JSON`);
	}
	if (!isObject(value) || Object.keys(value).join() !== "allow" || !Array.isArray(value.allow)) {
		throw new Unusable(`${ALLOWLIST} must be exactly { "allow": [ ... ] }`);
	}
	return value.allow.map((entry, i) => {
		const where = `${ALLOWLIST} entry ${i}`;
		if (!isObject(entry)) throw new Unusable(`${where} is not an object`);
		for (const key of Object.keys(entry)) {
			if (!["path", "why", "sha256"].includes(key)) {
				throw new Unusable(`${where} has an unknown field ${JSON.stringify(key)}`);
			}
		}
		const { path, why, sha256 } = entry;
		if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\")) {
			throw new Unusable(`${where} needs a "path" relative to the repository's root`);
		}
		if (typeof why !== "string" || why.trim() === "") {
			throw new Unusable(`${where} needs a "why"`);
		}
		const glob = path.includes("*");
		if (
			sha256 !== undefined &&
			(glob || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256))
		) {
			throw new Unusable(`${where}: a "sha256" pin is 64 hex digits, on an exact path only`);
		}
		return { path, sha256, matches: glob ? globMatcher(path) : (p) => p === path };
	});
}

/** The problems with one settings file's text: none when it holds only permitted keys. */
function settingsProblems(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return ["is not valid JSON"];
	}
	if (!isObject(value)) return ["is not a JSON object"];
	const problems = [];
	for (const [key, inner] of Object.entries(value)) {
		if (key === "$schema") {
			if (typeof inner !== "string") problems.push('holds a "$schema" that is not a string');
		} else if (key === "permissions") {
			if (!isObject(inner)) {
				problems.push('holds "permissions" that is not an object');
				continue;
			}
			for (const [rule, list] of Object.entries(inner)) {
				if (!PERMISSION_KEYS.has(rule)) {
					problems.push(
						`holds "permissions.${JSON.stringify(rule).slice(1, -1)}", which is not permitted`,
					);
				} else if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
					problems.push(`holds "permissions.${rule}" that is not a list of rules`);
				}
			}
		} else {
			problems.push(`holds the key ${JSON.stringify(key)}, which is not permitted`);
		}
	}
	return problems;
}

/** Every entry of `commit`'s tree: path → { mode, oid }. */
function tree(commit) {
	const entries = new Map();
	for (const line of git(["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0")) {
		if (line === "") continue;
		const tab = line.indexOf("\t");
		const [mode, , oid] = line.slice(0, tab).split(" ");
		entries.set(line.slice(tab + 1), { mode, oid });
	}
	return entries;
}

const blob = (oid) => git(["cat-file", "blob", oid], "buffer");

/** How each event's change is read: a pull request from where it branched, a push tip to tip. */
const RANGE = { pull_request: "...", push: ".." };

/** The failures of the change from `base` to `head` under the allowlist at `rules`. */
function check({ event, rules, base, head }) {
	const allow = readAllowlist(rules);
	const changed = git([
		"diff",
		"--name-only",
		"--no-renames",
		"--no-ext-diff",
		"--ignore-submodules=none",
		"-z",
		`${base}${RANGE[event]}${head}`,
	])
		.split("\0")
		.filter((path) => path !== "");
	const headTree = tree(head);
	const failures = [];
	const fail = (rule, path, reason) => failures.push({ rule, path, reason });
	let agentPaths = 0;
	for (const path of changed) {
		if (!isAgentConfig(path)) continue;
		agentPaths += 1;
		const entries = allow.filter((e) => e.matches(path));
		if (entries.length === 0) {
			fail(1, path, "is agent config, and the allowlist does not name it");
			continue;
		}
		// Every pin that names the path holds, whatever else names it too.
		const pins = entries.filter((e) => e.sha256 !== undefined).map((e) => e.sha256);
		if (pins.length === 0) continue;
		const now = headTree.get(path);
		if (now === undefined) {
			fail(1, path, "is pinned by the allowlist, and the change removes it");
			continue;
		}
		const hash = createHash("sha256").update(blob(now.oid)).digest("hex");
		if (pins.some((pin) => pin !== hash)) {
			fail(1, path, "is pinned by the allowlist, and the change leaves other content");
		}
	}
	let settingsFiles = 0;
	for (const [path, { mode, oid }] of headTree) {
		if (isAgentConfig(path) && !REGULAR.has(mode)) {
			fail(1, path, `is agent config that is not a regular file (mode ${mode})`);
		}
		if (!isSettings(path)) continue;
		settingsFiles += 1;
		for (const problem of settingsProblems(blob(oid).toString("utf-8"))) fail(2, path, problem);
	}
	return { failures, changed: changed.length, agentPaths, settingsFiles };
}

/** `--name value` pairs; Unusable when one is missing, or names no event or commit. */
function options(argv) {
	const named = {};
	for (let i = 0; i < argv.length; i += 2) {
		const name = argv[i]?.replace(/^--/u, "");
		if (!["event", "rules", "base", "head"].includes(name) || argv[i + 1] === undefined) {
			throw new Unusable(
				"usage: agent-config-guard.mjs --event <pull_request|push> --rules <commit> --base <commit> --head <commit>",
			);
		}
		named[name] = argv[i + 1];
	}
	if (!Object.hasOwn(RANGE, named.event ?? "")) {
		throw new Unusable("--event is pull_request or push");
	}
	for (const name of ["rules", "base", "head"]) {
		if (named[name] === undefined) throw new Unusable(`--${name} is missing`);
		named[name] = git(["rev-parse", "--verify", "--quiet", `${named[name]}^{commit}`]).trim();
	}
	return named;
}

try {
	const result = check(options(process.argv.slice(2)));
	for (const { rule, path, reason } of result.failures) {
		console.log(`agent-config: FAILED (rule ${rule}): ${JSON.stringify(path)} ${reason}`);
	}
	const summary = `${result.changed} paths changed, ${result.agentPaths} of them agent config; ${result.settingsFiles} settings files in the tree`;
	if (result.failures.length > 0) {
		console.log(`agent-config: ${result.failures.length} failures (${summary})`);
		process.exitCode = 1;
	} else {
		console.log(`agent-config: OK (${summary})`);
	}
} catch (err) {
	if (!(err instanceof Unusable)) throw err;
	console.log(`agent-config: CANNOT CHECK: ${err.message}`);
	process.exitCode = 2;
}
