// A second meter is visible, a missing one is not. This plugin was renamed from
// `usertrust-claude-code`; an install of the old name cannot be updated, and with both
// loaded every tool call is metered twice (both share one state dir). SessionStart WARNS when
// the old plugin looks enabled, and this plugin always meters: settings files are evidence of
// what Claude Code loaded, not proof (--settings and --setting-sources, a change made after
// the session started, and a different home all make them wrong), and a wrong "enabled" that
// stopped metering would be a silent zero meter. A wrong reading costs a warning.
//
// "Enabled" is read from Claude Code's documented `enabledPlugins` setting, keyed
// `<plugin>@<marketplace>` with a boolean (https://code.claude.com/docs/en/settings-reference
// `enabledPlugins`; https://code.claude.com/docs/en/plugins-reference "defaultEnabled"), in
// the files https://code.claude.com/docs/en/settings#settings-precedence lists, highest
// first: managed (https://code.claude.com/docs/en/managed-settings), project local
// (.claude/settings.local.json), shared project (.claude/settings.json), user
// (~/.claude/settings.json, or CLAUDE_CONFIG_DIR's). A reading that cannot be made is
// "unknown", and warns too.
//
// Not read, so a plugin enabled only there may not warn: MDM and server-managed settings,
// `--settings`, managed-settings.d/, and the Windows managed path.
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
 * override, https://code.claude.com/docs/en/settings), else `.claude` under `os.homedir()`, which is where Claude Code reads it.
 * Project: CLAUDE_PROJECT_DIR (exported to hook processes, plugins-reference "Environment
 * variables"), else the payload's `cwd`, else none.
 */
export function settingsDirs({ env, payload }) {
	const configured = env.CLAUDE_CONFIG_DIR;
	const userDir =
		typeof configured === "string" && isAbsolute(configured)
			? configured
			: join(homedir(), ".claude");
	const candidates = [env.CLAUDE_PROJECT_DIR, payload?.cwd];
	const projectDir = candidates.find((dir) => typeof dir === "string" && isAbsolute(dir)) ?? null;
	return { userDir, projectDir };
}

/**
 * The warning SessionStart shows when the old plugin looks enabled. This plugin STILL meters:
 * the settings are evidence, not proof, of what Claude Code loaded. The file is named so a
 * `true` left for a plugin that is not installed can be removed.
 */
export function alsoEnabledWarning(file) {
	return `usertrust: usertrust-claude-code also appears to be enabled (${file}); if it is, every tool call is metered twice. Uninstall it: /plugin uninstall usertrust-claude-code@usertrust`;
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
