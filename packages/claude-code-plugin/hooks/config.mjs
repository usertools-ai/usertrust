// The plugin's settings, and the ONE place the hooks read the environment.
//
// UNCONFIGURED (no UT_CC_CONFIG in the environment): every setting comes from its
// UT_* variable, as it always has.
//
// CONFIGURED (UT_CC_CONFIG is in the environment, even empty): every setting comes
// from the one file it names, and no UT_* variable is read. The file is accepted
// only inside <passwd home>/.config/usertrust/ (the home the passwd database gives
// the user, never $HOME: that is environment too), only as a regular file the user
// owns with no group or other permission bits, and only when it holds every
// required field. Anything else, an empty UT_CC_CONFIG included, runs the plugin
// watch-only and KEY-LESS: no request is sent at all, every tool call is recorded
// as a gap with a fixed reason, and the session-start line says why. A configured
// session never falls back to the environment and never enforces on a refused file.
//
// Why: a project's settings can set environment variables for every hook. One quiet
// line (UT_SERVER_URL, UT_CC_MODE, UT_CC_STATE_DIR, ...) would otherwise send the
// tenant key elsewhere, switch the mode, turn content back on or move the state dir.
// A configured session ignores them all. What this does NOT stop is CODE from a
// project's settings: a hook, or a variable that loads code (NODE_OPTIONS, PATH).
// That code runs in the hook's own process and can read this file too. Only not
// starting a session in a checkout you have not reviewed stops it.
//
// Nor may the environment reroute the requests or change what TLS trusts: Node's own
// proxy support (NODE_USE_ENV_PROXY, --use-env-proxy) sends every fetch through
// HTTP_PROXY, and NODE_TLS_REJECT_UNAUTHORIZED=0, NODE_EXTRA_CA_CERTS, OpenSSL's
// certificate and config variables, or a CA-store option let someone else read an
// https one. NODE_OPTIONS may hold only a short list of options that do neither. A
// configured session whose environment breaks any of this is refused like a bad file
// (`environmentRefusal`).
//
// Nothing read from the file is ever written where it could be seen: a refusal is
// one of the fixed reasons below, naming only our own field names. (A JSON parse
// error quotes the input, and an OS error can carry a path, so neither is passed on.)
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, sep } from "node:path";

/** The variable that names the config file; its presence alone makes a session configured. */
const CONFIG_VARIABLE = "UT_CC_CONFIG";

/** Each setting's variable in an unconfigured session; the key is its field in the config file. */
const VARIABLES = {
	url: "UT_SERVER_URL",
	key: "UT_SERVER_KEY",
	mode: "UT_CC_MODE",
	failOpen: "UT_FAIL_OPEN",
	stateDir: "UT_CC_STATE_DIR",
	usage: "UT_CC_USAGE",
	model: "UT_CC_MODEL",
	sendContent: "UT_CC_SEND_CONTENT",
	unit: "UT_CC_UNIT",
	role: "UT_CC_ROLE",
};

/**
 * Variables Claude Code itself defines, which a hook may read in either kind of
 * session: none of them is a setting of this plugin.
 */
const HOST_VARIABLES = ["CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS"];

const DEFAULT_URL = "http://127.0.0.1:4519";
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Where a config file must be, under the passwd home. */
const ANCHOR = [".config", "usertrust"];

/** The largest config file read. */
const MAX_CONFIG_BYTES = 64 * 1024;

/** A key or a model: visible ASCII, so neither can break a header or a log line. */
const VISIBLE = /^[\x21-\x7e]{1,1024}$/;

/** The default state dir, under a given home. */
const defaultStateDir = (home) => join(home, ".claude", "usertrust-cc");

/** An unconfigured session's settings: every one from its variable, as before config files. */
function fromEnvironment(env) {
	const rawMode = (env.UT_CC_MODE ?? "").trim();
	return {
		configured: false,
		refused: null,
		url: env.UT_SERVER_URL ?? DEFAULT_URL,
		key: env.UT_SERVER_KEY ?? "",
		mode: rawMode.toLowerCase() === "enforce" ? "enforce" : "watch",
		unrecognizedMode:
			rawMode === "" || ["watch", "enforce"].includes(rawMode.toLowerCase()) ? undefined : rawMode,
		failOpen: env.UT_FAIL_OPEN === "1",
		stateDir:
			env.UT_CC_STATE_DIR ??
			join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "usertrust-cc"),
		usage: env.UT_CC_USAGE === "estimate" ? "estimate" : "transcript",
		model: env.UT_CC_MODEL ?? DEFAULT_MODEL,
		sendContent: env.UT_CC_SEND_CONTENT !== "0",
		unit: env.UT_CC_UNIT,
		role: env.UT_CC_ROLE,
	};
}

/**
 * A configured session whose file was refused: watch-only and key-less, with no
 * server to send to (`url: null`: lib.mjs `serverRequest` refuses before any
 * request), and the default state dir under the passwd home, so the gap records
 * still land somewhere the user owns. Without a passwd home, under `homedir()`.
 */
function refusedSettings(reason, passwdHome) {
	return {
		configured: true,
		refused: reason,
		url: null,
		key: "",
		mode: "watch",
		unrecognizedMode: undefined,
		failOpen: false,
		stateDir: defaultStateDir(passwdHome ?? homedir()),
		usage: "transcript",
		model: DEFAULT_MODEL,
		sendContent: false,
		unit: undefined,
		role: undefined,
	};
}

const missing = (field) => `config: field "${field}" missing`;
const invalid = (field) => `config: field "${field}" invalid`;

/**
 * An http or https url with no credentials in it: a fetch refuses a url that holds
 * a user or password, with an error that quotes the whole url, and that error
 * would reach stderr and the gap records.
 */
function isHttpUrl(value) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

/**
 * The NODE_OPTIONS a configured session may carry: each token must be one of these,
 * EXACTLY. Node also accepts its options quoted, with backslash escapes inside the
 * quotes, with `_` for `-` and with a value after `=`, so a list of what to refuse
 * misses spellings (it did, twice). Anything not on this list refuses. A token holding
 * a quote or a backslash matches none of these, so splitting on spaces is enough: Node
 * splits an unquoted string exactly the same way.
 */
const NODE_OPTIONS_ALLOWED = [
	/^--max-old-space-size=\d+$/,
	/^--max-semi-space-size=\d+$/,
	/^--enable-source-maps$/,
	/^--no-warnings$/,
	/^--no-deprecation$/,
	/^--trace-warnings$/,
	/^--trace-deprecation$/,
	/^--unhandled-rejections=(strict|warn|none|throw|warn-with-error-code)$/,
	/^--dns-result-order=(ipv4first|ipv6first|verbatim)$/,
];

/**
 * The node options that route a request or choose what TLS trusts, as they appear in
 * the hook's own command line: matched after lower-casing, dropping quotes and
 * backslashes, and reading `_` as `-`, so no spelling Node accepts slips by. The
 * command line comes from the plugin's own hooks.json, not the environment; this is the
 * same rule kept for it.
 */
const ROUTE_OR_TRUST_OPTIONS = [
	"--use-env-proxy",
	"--use-openssl-ca",
	"--use-system-ca",
	"--openssl-config",
];

/** Variables that change what TLS trusts, or load OpenSSL config or modules: refused when set. */
const TRUST_VARIABLES = [
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_USE_SYSTEM_CA",
	"OPENSSL_CONF",
	"OPENSSL_MODULES",
	"OPENSSL_ENGINES",
];

/**
 * Why this environment may not carry a configured session's requests, or null. Node
 * reroutes or exposes a fetch without any code:
 * - NODE_USE_ENV_PROXY (or --use-env-proxy) sends it through HTTP_PROXY /
 *   HTTPS_PROXY, key and all;
 * - NODE_TLS_REJECT_UNAUTHORIZED=0 trusts any certificate;
 * - NODE_EXTRA_CA_CERTS adds certificates to trust; SSL_CERT_FILE / SSL_CERT_DIR
 *   replace them, with no flag, on a build whose default store is OpenSSL's (as
 *   Homebrew's); NODE_USE_SYSTEM_CA and the CA-store options change the store; and
 *   OPENSSL_CONF / _MODULES / _ENGINES load OpenSSL config or code.
 * NODE_OPTIONS may hold only `NODE_OPTIONS_ALLOWED`. Each refusal names a variable or
 * an option, never a value.
 */
export function environmentRefusal(env, execArgv = []) {
	const set = (name) => (env[name] ?? "") !== "";
	const refused = (what) => `config: environment refused (${what})`;
	if (set("NODE_USE_ENV_PROXY")) return refused("NODE_USE_ENV_PROXY");
	const options = (env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t !== "");
	if (options.some((t) => !NODE_OPTIONS_ALLOWED.some((re) => re.test(t)))) {
		return refused("NODE_OPTIONS");
	}
	const argv = execArgv.join(" ").toLowerCase().replace(/["\\]/g, "").replaceAll("_", "-");
	for (const flag of ROUTE_OR_TRUST_OPTIONS) if (argv.includes(flag.slice(2))) return refused(flag);
	if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return refused("NODE_TLS_REJECT_UNAUTHORIZED");
	for (const name of TRUST_VARIABLES) if (set(name)) return refused(name);
	return null;
}

/**
 * A config file's text, checked field by field: the settings, or the fixed reason
 * it is refused. Required: `url` (http or https), `key`, `mode` (`watch` or
 * `enforce`) and an absolute `stateDir`. Optional: `failOpen` and `sendContent`
 * (booleans), `usage` (`transcript` or `estimate`), `model`, `unit` and `role`
 * (strings). Fields it does not know are ignored.
 */
export function parseConfig(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return "config: not valid JSON";
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return "config: not valid JSON";
	}
	const field = (name) => (Object.hasOwn(value, name) ? value[name] : undefined);
	const { url, key, mode, stateDir } = {
		url: field("url"),
		key: field("key"),
		mode: field("mode"),
		stateDir: field("stateDir"),
	};
	if (url === undefined) return missing("url");
	if (!isHttpUrl(url)) return invalid("url");
	if (key === undefined) return missing("key");
	if (typeof key !== "string" || !VISIBLE.test(key)) return invalid("key");
	if (mode === undefined) return missing("mode");
	if (mode !== "watch" && mode !== "enforce") return invalid("mode");
	if (stateDir === undefined) return missing("stateDir");
	if (typeof stateDir !== "string" || !isAbsolute(stateDir)) return invalid("stateDir");
	const optional = {
		failOpen: [false, (v) => typeof v === "boolean"],
		sendContent: [true, (v) => typeof v === "boolean"],
		usage: ["transcript", (v) => v === "transcript" || v === "estimate"],
		model: [DEFAULT_MODEL, (v) => typeof v === "string" && VISIBLE.test(v)],
		unit: [undefined, (v) => typeof v === "string"],
		role: [undefined, (v) => typeof v === "string"],
	};
	const settings = {
		configured: true,
		refused: null,
		url,
		key,
		mode,
		unrecognizedMode: undefined,
		stateDir,
	};
	for (const [name, [fallback, valid]] of Object.entries(optional)) {
		const given = field(name);
		if (given === undefined) {
			settings[name] = fallback;
		} else if (valid(given)) {
			settings[name] = given;
		} else {
			return invalid(name);
		}
	}
	return settings;
}

/**
 * The config file at `path`, read only if every check holds: the settings, or the
 * fixed reason it is refused.
 * - The ANCHOR, `<passwd home>/.config/usertrust`: its realpath is its path (no
 *   symlinked component), and it is a directory the user owns, writable by no one else.
 * - The FILE: named by an absolute path whose realpath is inside the anchor, not
 *   itself a link, and opened (never following a link, never waiting on a FIFO) as a
 *   regular file the user owns, with no group or other permission bits.
 * Without POSIX ownership (`uid` null: Windows) the owner and mode checks are skipped.
 */
function readConfig(path, { passwdHome, uid, fs }) {
	if (path === "") return "config: empty";
	if (passwdHome === null) return "config: anchor refused (home)";
	const anchor = join(passwdHome, ...ANCHOR);
	let anchorStat;
	try {
		if (fs.realpathSync(anchor) !== anchor) return "config: anchor refused (symlink)";
		anchorStat = fs.lstatSync(anchor);
	} catch {
		return "config: anchor refused (missing)";
	}
	if (!anchorStat.isDirectory()) return "config: anchor refused (type)";
	if (uid !== null && anchorStat.uid !== uid) return "config: anchor refused (owner)";
	if (uid !== null && (anchorStat.mode & 0o022) !== 0) return "config: anchor refused (mode)";
	if (!isAbsolute(path)) return "config: outside the anchor";
	let real;
	try {
		real = fs.realpathSync(path);
	} catch {
		return "config: unreadable";
	}
	if (!real.startsWith(anchor + sep)) return "config: outside the anchor";
	try {
		if (fs.lstatSync(path).isSymbolicLink()) return "config: file refused (symlink)";
	} catch {
		return "config: unreadable";
	}
	let fd;
	try {
		fd = fs.openSync(
			real,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch {
		return "config: unreadable";
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return "config: file refused (type)";
		if (uid !== null && stat.uid !== uid) return "config: file refused (owner)";
		if (uid !== null && (stat.mode & 0o077) !== 0) return "config: file refused (mode)";
		if (stat.size > MAX_CONFIG_BYTES) return "config: file refused (size)";
		let text;
		try {
			text = fs.readFileSync(fd, "utf-8");
		} catch {
			return "config: unreadable";
		}
		return parseConfig(text);
	} finally {
		fs.closeSync(fd);
	}
}

const REAL_FS = { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync };

/**
 * The settings for an environment: from the environment when it has no
 * UT_CC_CONFIG, else from the file it names (`readConfig`), or watch-only and
 * key-less when that file, or the environment that would carry its requests
 * (`environmentRefusal`), is refused. `passwdHome` is the passwd database's home
 * (null when there is none), `uid` the user's (null without POSIX ownership),
 * `execArgv` the hook's own node options, and `fs` the file functions it reads
 * with (tests swap in their own `fstatSync` and `lstatSync` to stand in for
 * another owner).
 */
export function resolveSettings({ env, passwdHome, uid, execArgv = [], fs = REAL_FS }) {
	if (!Object.hasOwn(env, CONFIG_VARIABLE)) return fromEnvironment(env);
	const read =
		environmentRefusal(env, execArgv) ?? readConfig(env[CONFIG_VARIABLE], { passwdHome, uid, fs });
	return typeof read === "string" ? refusedSettings(read, passwdHome) : read;
}

/** The passwd database's home for this user, or null when it has none. */
function passwdHome() {
	try {
		const { homedir: home } = userInfo();
		return typeof home === "string" && home !== "" ? home : null;
	} catch {
		return null;
	}
}

/** A configured session's settings, read once per process (per config path). */
let fromFile;

/**
 * This hook's settings (`resolveSettings`). A configured session reads its file
 * once per process. An unconfigured one reads the environment at each call, as the
 * hooks always have.
 */
export function settings() {
	if (!Object.hasOwn(process.env, CONFIG_VARIABLE)) return fromEnvironment(process.env);
	const path = process.env[CONFIG_VARIABLE];
	if (fromFile?.path !== path) {
		fromFile = {
			path,
			value: resolveSettings({
				env: process.env,
				passwdHome: passwdHome(),
				uid: typeof process.getuid === "function" ? process.getuid() : null,
				execArgv: process.execArgv,
			}),
		};
	}
	return fromFile.value;
}

/**
 * The variables Claude Code itself defines that a hook may read (`HOST_VARIABLES`),
 * and only those.
 */
export function hostEnv() {
	return Object.fromEntries(
		HOST_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [
			name,
			process.env[name],
		]),
	);
}

/**
 * How a user sets `name` to `value` in this session, for the lines the hooks
 * write: `UT_CC_MODE=enforce` in an unconfigured session, `"mode": "enforce" in
 * the config file` in a configured one.
 */
export function howToSet(name, value) {
	return settings().configured
		? `"${name}": ${JSON.stringify(value)} in the config file`
		: `${VARIABLES[name]}=${value === true ? "1" : value}`;
}

/** What a setting is called in this session: its variable, or its field in the config file. */
export function settingName(name) {
	return settings().configured ? `the config file's "${name}"` : VARIABLES[name];
}

/** Why a configured session runs key-less: the variable that named the file, and the fixed reason. */
export function refusalNote(reason) {
	return `the config file ${CONFIG_VARIABLE} names was refused (${reason})`;
}
