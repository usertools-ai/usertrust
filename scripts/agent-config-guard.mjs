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
//    In the change's tree, every agent-config path must be a regular file, and checked out
//    as it is stored: a link or a submodule there could carry config these rules never
//    read, and an attribute under which checkout rewrites a file (`working-tree-encoding`,
//    `filter`, `ident`) would hand an agent other bytes than the ones checked here. The
//    attributes are read as git reads them on either kind of filesystem, case-sensitive or
//    not; and so that every attributes file is read, one must be spelled `.gitattributes`.
//    No attributes file may give one of them the literal value `unset` or `unspecified`, a
//    macro's included: `check-attr` prints that as no value, where git looks for a filter
//    or an encoding of that name. And every attributes file, at any depth, is checked out as
//    it is stored too: one that checkout rewrote would give git other rules at checkout than
//    the ones read here (an encoding that adds NUL bytes ends git's read of the file there).
//    A submodule is another repository, and its own tree can hold agent config: one the
//    change adds, or moves to another commit, must be named by the allowlist, wherever it is.
// 2. Every Claude Code settings file in the change's tree (`.claude/settings*.json`, at
//    any depth), allowlisted or not, must be a JSON object holding only the permitted
//    keys: `$schema`, and `permissions` that only tighten (`deny`, `ask`). Any other
//    key fails, a key this guard has never heard of included: a list of the keys that
//    run something goes stale each time Claude Code ships a setting.
// 3. Every path the change adds, anywhere in the repository, must be one name to every
//    filesystem that checks it out:
//    - Its name is portable: each segment holds only `A-Z a-z 0-9 . _ - [ ]`. Each way
//      Unicode spells one name twice (a long s, a fullwidth letter, a code point HFS+
//      ignores, a combining mark) needs a code point outside that set, and so does each
//      pure-ASCII alias Windows makes: a stream (`settings.json:x`), a short name
//      (`CLAUDE~1`), a backslash, a trailing space. A path that must be spelled otherwise
//      is named by its exact bytes in the allowlist's own list, `nonportable`.
//    - No name it makes, itself or a directory above it, folds (`fold`) to another name in
//      the change's tree, a file's or a directory's, the change's other additions
//      included: a case-insensitive filesystem, or Windows, opens both as one.
// Rule 3 keeps each name in the tree its file's only spelling, so rule 1 compares paths as
// they are written: an entry names a spelling, and a pin holds for it. And a file the tree
// holds under another spelling of a pinned path fails, so that no pin is left naming an
// absent file that a case-insensitive filesystem would open as another. Agent config is
// still recognized as such a filesystem opens it (`.Claude/`, `.MCP.JSON`, `.claude./`), so
// every spelling of it is held to rules 1 and 2.
//
// The change is what `--event` says it is:
// - for a pull request, `base...head`, which the launcher makes what will land: `head` is
//   the merge commit GitHub tests, and `base` its first parent;
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
// Imported with `?library` on its URL, it checks nothing and exports its fold and its settings
// recognizer, so another test can recognize a path exactly as this does. No command line can
// add that query: run as a script, it always checks.
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
/**
 * The portable set, and the `/` between segments: what a path may hold with no allowlist
 * entry. POSIX's portable filename characters, and the brackets of a route's directory
 * (`[id]`).
 */
const PORTABLE = /[A-Za-z0-9._\-[\]/]/u;
/**
 * The attributes under which checkout writes a file other than its blob. Line-end conversion
 * (`text`, `eol`, and a machine's own `core.autocrlf`) is not one: it rewrites only the line
 * ends, as a Windows checkout does to any text file, and JSON reads both alike.
 */
const TRANSFORMS = ["working-tree-encoding", "filter", "ident"];
/**
 * An attributes-file assignment `check-attr` cannot tell from none: one of `TRANSFORMS` given
 * the literal value `unset` or `unspecified`, which it prints as that state.
 */
const AMBIGUOUS = new RegExp(`^(?:${TRANSFORMS.join("|")})=(?:unset|unspecified)$`, "u");

/** A run that cannot be checked: exit 2, never a pass. */
class Unusable extends Error {}

/** `git` in the repository's top level, its config held to what the checks need. */
function git(args, { encoding = "utf-8", config = [], input } = {}) {
	try {
		return execFileSync(
			"git",
			[
				...["diff.relative=false", "core.quotePath=true", ...config].flatMap((c) => ["-c", c]),
				...args,
			],
			{
				encoding,
				input,
				maxBuffer: 1 << 30,
				stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			},
		);
	} catch (err) {
		throw new Unusable(`git ${args[0]} failed: ${String(err?.stderr ?? err).trim()}`);
	}
}

/**
 * The code points HFS+ ignores in a name, git's own list (utf8.c `next_hfs_char`): the zero
 * width non-joiner, joiner and direction marks, the directional formatting characters, the
 * deprecated format characters, and U+FEFF. A name holding one opens as the name without it.
 */
const HFS_IGNORED = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/gu;

/**
 * A path segment as a case-insensitive filesystem, or Windows, resolves it: the code points
 * HFS+ ignores removed (`HFS_IGNORED`), compatibility forms folded (NFKC: `ﬁ` is `fi`, a
 * fullwidth `ｊ` is `j`), then case (`ſ` is `s`; lower, upper and lower again, so `ẞ` and `ß`
 * are both `ss`), and trailing dots and spaces dropped.
 */
const fold = (segment) =>
	segment
		.replace(HFS_IGNORED, "")
		.normalize("NFKC")
		.toLowerCase()
		.toUpperCase()
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[. ]+$/u, "");

/** A whole path, folded segment by segment (`fold`): two paths that fold alike are one file. */
const folded = (path) => path.split("/").map(fold).join("/");

/** The names a path makes: each directory above it, outermost first, then the path itself. */
function names(path) {
	const segments = path.split("/");
	return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** The code points of `path` outside the portable set (`PORTABLE`), each once, as U+XXXX. */
function unportable(path) {
	const outside = new Set();
	for (const c of path) {
		if (PORTABLE.test(c)) continue;
		outside.add(`U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
	}
	return [...outside];
}

/** Text as the log shows it: JSON, with each code point outside printable ASCII escaped. */
const shown = (text) =>
	JSON.stringify(text).replace(/[^ -~]/gu, (c) =>
		c
			.split("")
			.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join(""),
	);

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

/** One allowlist entry, held to its list's `fields`, a relative `path` and a `why`. */
function entry(value, where, fields) {
	if (!isObject(value)) throw new Unusable(`${where} is not an object`);
	for (const key of Object.keys(value)) {
		if (!fields.includes(key)) {
			throw new Unusable(`${where} has an unknown field ${shown(key)}`);
		}
	}
	const { path, why } = value;
	if (typeof path !== "string" || path === "" || path.startsWith("/")) {
		throw new Unusable(`${where} needs a "path" relative to the repository's root`);
	}
	if (typeof why !== "string" || why.trim() === "") {
		throw new Unusable(`${where} needs a "why"`);
	}
	return value;
}

/**
 * The allowlist at `commit`: its `allow` entries, each with its matcher, and the paths its
 * `nonportable` list names. Unusable when it is not one.
 */
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
	if (
		!isObject(value) ||
		!Array.isArray(value.allow) ||
		!Object.keys(value).every((key) => key === "allow" || key === "nonportable") ||
		(Object.hasOwn(value, "nonportable") && !Array.isArray(value.nonportable))
	) {
		throw new Unusable(
			`${ALLOWLIST} must be { "allow": [ ... ] }, with "nonportable": [ ... ] if any`,
		);
	}
	const allow = value.allow.map((item, i) => {
		const where = `${ALLOWLIST} entry ${i}`;
		const { path, sha256 } = entry(item, where, ["path", "why", "sha256"]);
		if (path.includes("\\")) {
			throw new Unusable(`${where} needs a "path" relative to the repository's root`);
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
	const nonportable = new Set(
		(value.nonportable ?? []).map((item, i) => {
			const where = `${ALLOWLIST} "nonportable" entry ${i}`;
			const { path } = entry(item, where, ["path", "why"]);
			if (unportable(path).length === 0) {
				throw new Unusable(`${where} names a portable path, which needs no entry`);
			}
			// Git's output is read as UTF-8, where bytes that are not UTF-8 become U+FFFD: an entry
			// holding one names no path exactly.
			if (path.includes("\uFFFD")) {
				throw new Unusable(`${where} holds U+FFFD, which stands for bytes that are not UTF-8`);
			}
			return path;
		}),
	);
	return { allow, nonportable };
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
					problems.push(`holds "permissions.${shown(rule).slice(1, -1)}", which is not permitted`);
				} else if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
					problems.push(`holds "permissions.${rule}" that is not a list of rules`);
				}
			}
		} else {
			problems.push(`holds the key ${shown(key)}, which is not permitted`);
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

const blob = (oid) => git(["cat-file", "blob", oid], { encoding: "buffer" });

/** How each event's change is read: a pull request from where it branched, a push tip to tip. */
const RANGE = { pull_request: "...", push: ".." };

/** The paths the change from `base` to `head` touches, each with its status (`A`, `M`, `D`, ...). */
function changes(event, base, head) {
	const fields = git([
		"diff",
		"--name-status",
		"--no-renames",
		"--no-ext-diff",
		"--ignore-submodules=none",
		"-z",
		`${base}${RANGE[event]}${head}`,
	]).split("\0");
	const touched = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		touched.push({ status: fields[i], path: fields[i + 1] });
	}
	return touched;
}

/**
 * Each attribute in `TRANSFORMS` that `commit`'s own `.gitattributes` files give one of
 * `paths`, as git matches their patterns with case (a case-sensitive filesystem) and without
 * (`core.ignorecase`, a case-insensitive one): a pattern can match a path on one and not the
 * other, and an agent may open a checkout of either.
 */
function transforms(commit, paths) {
	if (paths.length === 0) return [];
	const found = new Map();
	for (const ignoreCase of [false, true]) {
		const fields = git(["check-attr", `--source=${commit}`, "-z", "--stdin", ...TRANSFORMS], {
			config: [`core.ignorecase=${ignoreCase}`],
			input: `${paths.join("\0")}\0`,
		}).split("\0");
		for (let i = 0; i + 2 < fields.length; i += 3) {
			const [path, attribute, value] = fields.slice(i, i + 3);
			if (value === "unspecified" || value === "unset") continue;
			found.set(`${path}\0${attribute}\0${value}`, { path, attribute, value });
		}
	}
	return [...found.values()];
}

/** The failures of the change from `base` to `head` under the allowlist at `rules`. */
function check({ event, rules, base, head }) {
	const { allow, nonportable } = readAllowlist(rules);
	const changed = changes(event, base, head);
	const headTree = tree(head);
	const failures = [];
	const fail = (rule, path, reason) => failures.push({ rule, path, reason });
	// Every name in the change's tree, a file's or a directory's, by what it folds to.
	const spellings = new Map();
	for (const path of headTree.keys()) {
		for (const name of names(path)) {
			const key = folded(name);
			spellings.set(key, (spellings.get(key) ?? new Set()).add(name));
		}
	}
	let agentPaths = 0;
	for (const { status, path } of changed) {
		if (status === "A") {
			const outside = unportable(path);
			if (outside.length > 0 && !nonportable.has(path)) {
				fail(
					3,
					path,
					`holds ${outside.join(", ")}, outside the portable set (A-Z a-z 0-9 . _ - [ ]), and the allowlist's "nonportable" list does not name it`,
				);
			}
			// The outermost name that folds to another stands for the names inside it.
			for (const name of names(path)) {
				const others = [...spellings.get(folded(name))].filter((other) => other !== name);
				for (const other of others) {
					fail(
						3,
						path,
						`${name === path ? "" : `holds ${shown(name)}, which `}folds to ${shown(other)}, another name in the tree: a case-insensitive filesystem opens both as one`,
					);
				}
				if (others.length > 0) break;
			}
		}
		// A submodule's own tree is another repository's, and can hold agent config.
		if (
			status !== "D" &&
			headTree.get(path)?.mode === "160000" &&
			!allow.some((e) => e.matches(path))
		) {
			fail(
				1,
				path,
				"is a submodule, whose own tree can hold agent config, and the allowlist does not name it",
			);
		}
		if (!isAgentConfig(path)) continue;
		agentPaths += 1;
		if (!allow.some((e) => e.matches(path))) {
			fail(1, path, "is agent config, and the allowlist does not name it");
			continue;
		}
		// Every pin on this path holds, whatever else names it too.
		const pins = allow.filter((e) => e.sha256 !== undefined && e.path === path);
		if (pins.length === 0) continue;
		const now = headTree.get(path);
		if (now === undefined) {
			fail(1, path, "is pinned by the allowlist, and the change removes it");
			continue;
		}
		const hash = createHash("sha256").update(blob(now.oid)).digest("hex");
		if (pins.some((e) => e.sha256 !== hash)) {
			fail(1, path, "is pinned by the allowlist, and the change leaves other content");
		}
	}
	// Every pinned path, by what it folds to.
	const pinned = new Map();
	for (const { path, sha256 } of allow) {
		if (sha256 === undefined) continue;
		const key = folded(path);
		pinned.set(key, (pinned.get(key) ?? new Set()).add(path));
	}
	const agentTree = [];
	// The attributes files that are not agent config (those are in `agentTree`): each must be
	// checked out as stored, so that git reads at checkout the rules `transforms` reads here.
	const attributesTree = [];
	let settingsFiles = 0;
	for (const [path, { mode, oid }] of headTree) {
		for (const pin of pinned.get(folded(path)) ?? []) {
			if (pin === path) continue;
			fail(
				1,
				path,
				`folds to the pinned path ${shown(pin)}: a case-insensitive filesystem opens both as one file`,
			);
		}
		const leaf = path.split("/").at(-1);
		if (leaf !== ".gitattributes" && fold(leaf) === ".gitattributes") {
			fail(
				1,
				path,
				'is ".gitattributes" to a case-insensitive filesystem, and git reads it there, but not here: spell it ".gitattributes"',
			);
		}
		if (leaf === ".gitattributes" && mode !== "160000") {
			const text = blob(oid).toString("utf-8");
			// Git stops reading an attributes file at its first NUL; what follows is not the file
			// git reads, and a token cut short there is not the token git reads either.
			if (text.includes("\0")) {
				fail(
					1,
					path,
					"holds a NUL byte, where git stops reading it: this check could not read it as git does",
				);
			}
			const ambiguous = new Set();
			for (const line of text.split(/\r?\n/u)) {
				// A comment as git reads one: `#` after nothing but its blanks (space, tab, CR, LF).
				if (/^[ \t\r\n]*#/u.test(line)) continue;
				for (const token of line.split(/\s+/u)) if (AMBIGUOUS.test(token)) ambiguous.add(token);
			}
			for (const token of ambiguous) {
				fail(
					1,
					path,
					`holds ${shown(token)}: check-attr prints that as no value, so this check could not see it`,
				);
			}
			if (!isAgentConfig(path)) attributesTree.push(path);
		}
		if (!isAgentConfig(path)) continue;
		agentTree.push(path);
		if (!REGULAR.has(mode)) {
			fail(1, path, `is agent config that is not a regular file (mode ${mode})`);
		}
		if (!isSettings(path)) continue;
		settingsFiles += 1;
		for (const problem of settingsProblems(blob(oid).toString("utf-8"))) fail(2, path, problem);
	}
	for (const { path, attribute, value } of transforms(head, agentTree)) {
		fail(
			1,
			path,
			`is agent config that checkout rewrites (${attribute} ${shown(value)}): an agent would read other bytes than the ones checked here`,
		);
	}
	for (const { path, attribute, value } of transforms(head, attributesTree)) {
		fail(
			1,
			path,
			`is an attributes file that checkout rewrites (${attribute} ${shown(value)}): git would read other rules from it at checkout than the ones checked here`,
		);
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

/** The command line: check the change it names, and say how it went. */
function main() {
	try {
		const result = check(options(process.argv.slice(2)));
		for (const { rule, path, reason } of result.failures) {
			console.log(`agent-config: FAILED (rule ${rule}): ${shown(path)} ${reason}`);
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
}

if (!new URL(import.meta.url).searchParams.has("library")) main();

export { fold, folded, isSettings };
