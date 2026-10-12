// One meter per session. This plugin was renamed from `usertrust-claude-code`; an install
// of the old name cannot be updated, and with both ENABLED every tool call is metered
// twice (both share one state dir). So the new plugin yields: when the old one is enabled
// it meters nothing and says so at SessionStart (launch.mjs `parent`).
//
// "Enabled" is read from Claude Code's documented `enabledPlugins` setting, keyed
// `<plugin>@<marketplace>` with a boolean (https://code.claude.com/docs/en/settings-reference
// `enabledPlugins`; https://code.claude.com/docs/en/plugins-reference "defaultEnabled"), in
// the files https://code.claude.com/docs/en/settings#settings-precedence lists, highest
// first: managed (https://code.claude.com/docs/en/managed-settings), project local
// (.claude/settings.local.json), shared project (.claude/settings.json), user
// (~/.claude/settings.json, or CLAUDE_CONFIG_DIR's). `claude plugin uninstall` refuses
// while a scope's settings still switch the plugin on (docs: plugin uninstall,
// `settings_still_on`), so a stale `true` for an uninstalled plugin is not expected.
//
// FAIL DIRECTION: a wrong "enabled" means NO meter at all (silent); a wrong "absent" means
// two meters (visible in the ledger). So only a clean reading of `true` yields. Anything
// unreadable or ambiguous is "unknown": the plugin meters, and warns.
//
// Not read, so a policy set only there is invisible to this check (declared residue): MDM
// and server-managed settings, `--settings`, managed-settings.d/, and the Windows managed
// path. A session that enables the old plugin only that way gets two meters.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { READ_BOUND, readRegular } from "./lib.mjs";

/** The retired plugin's name; the key is `<name>@<marketplace>`. */
export const PEER_PLUGIN = "usertrust-claude-code";

/** Whether `name` is the old plugin under any marketplace. */
const isPeerKey = (name) =>
	name.startsWith(`${PEER_PLUGIN}@`) && name.length > PEER_PLUGIN.length + 1;

/**
 * One settings file's say on the old plugin: `{ keys }` (each matching key -> its boolean), or
 * `{ unknown }` with why. A file that is not there says nothing; one that is there and cannot
 * be read as an object with an object `enabledPlugins` (or none) is unknown.
 */
async function readScope(path) {
	let text;
	try {
		text = await readRegular(path, READ_BOUND.record);
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { keys: new Map() };
		return { unknown: `${path}: ${err?.code ?? "unreadable"}` };
	}
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return { unknown: `${path}: not JSON` };
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		return { unknown: `${path}: not a settings object` };
	}
	const plugins = doc.enabledPlugins;
	if (plugins === undefined) return { keys: new Map() };
	if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) {
		return { unknown: `${path}: enabledPlugins is not an object` };
	}
	const keys = new Map();
	for (const [name, value] of Object.entries(plugins)) {
		if (!isPeerKey(name)) continue;
		if (typeof value !== "boolean") return { unknown: `${path}: ${name} is not true or false` };
		keys.set(name, value);
	}
	return { keys };
}

/**
 * Whether the old plugin is enabled for this session: `{ state: "enabled" | "absent" | "unknown",
 * why }`. Per key, the highest-precedence scope that states it wins; enabled when any key wins
 * `true`. `userDir` is the user settings directory (`~/.claude` or CLAUDE_CONFIG_DIR);
 * `projectDir` the project root, or null when the hook was not told one; `managed` the platform's
 * managed-settings file (config.mjs `managedSettingsFile`), or null where none is read.
 */
export async function peerMeter({ userDir, projectDir, managed }) {
	const scopes = [];
	if (managed !== null) scopes.push(managed);
	if (projectDir !== null) {
		scopes.push(join(projectDir, ".claude", "settings.local.json"));
		scopes.push(join(projectDir, ".claude", "settings.json"));
	}
	scopes.push(join(userDir, "settings.json"));
	const decided = new Map();
	const unknown = [];
	// Highest precedence first: a key keeps the first boolean it is given.
	for (const path of scopes) {
		const read = await readScope(path);
		if (read.unknown !== undefined) unknown.push(read.unknown);
		else
			for (const [name, value] of read.keys)
				if (!decided.has(name)) decided.set(name, { value, path });
	}
	if (projectDir === null) unknown.push("the project directory is not known");
	// A file that could not be read might hold the winning word: only "enabled" is certain.
	const winner = [...decided.values()].find((entry) => entry.value === true);
	if (winner !== undefined && unknown.length === 0) {
		return { state: "enabled", why: null, file: winner.path };
	}
	if (unknown.length > 0) return { state: "unknown", why: unknown.join("; ") };
	return { state: "absent", why: null };
}

/**
 * The directories a hook looks in. User: an absolute CLAUDE_CONFIG_DIR (Claude Code's own
 * override, https://code.claude.com/docs/en/settings), else `.claude` under the passwd home.
 * Project: CLAUDE_PROJECT_DIR (exported to hook processes, plugins-reference "Environment
 * variables"), else the payload's `cwd`, else none.
 */
export function settingsDirs({ env, payload, home }) {
	const configured = env.CLAUDE_CONFIG_DIR;
	const userDir =
		typeof configured === "string" && isAbsolute(configured)
			? configured
			: join(home ?? homedir(), ".claude");
	const candidates = [env.CLAUDE_PROJECT_DIR, payload?.cwd];
	const projectDir = candidates.find((dir) => typeof dir === "string" && isAbsolute(dir)) ?? null;
	return { userDir, projectDir };
}

/**
 * The line SessionStart shows when this plugin yields to the old one. It names the settings
 * file that enabled it: a `true` for a plugin that is not actually installed (a manual edit,
 * or managed settings written before the rename) leaves NO meter, and the remedy is there.
 */
export function yieldMessage(file) {
	return `usertrust: usertrust-claude-code is also enabled; this session is metered by it, not by usertools. Uninstall it: /plugin uninstall usertrust-claude-code@usertrust. If it is not actually installed, remove it from enabledPlugins in ${file}`;
}

/** The warning SessionStart prefixes when the old plugin's state could not be told. */
export function unknownWarning(why) {
	return `usertrust: could not tell whether usertrust-claude-code is also enabled (${why}); usertools meters this session, so a second meter may be running.`;
}

/** What `launch.mjs` found, for SessionStart (same process) to put first on its line. */
let warning = null;

/** Set by launch.mjs when the old plugin's state is unknown. */
export function setPeerWarning(text) {
	warning = text;
}

/** The warning to show once, or null. */
export function takePeerWarning() {
	const text = warning;
	warning = null;
	return text;
}
