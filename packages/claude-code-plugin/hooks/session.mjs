// A session's settings, resolved ONCE and pinned for the session's life.
//
// Every hook is its own process, and both places settings come from can change
// while a session runs: the config file is a file, and Claude Code re-applies
// settings `env` to a running session and on `/cd`. A state dir that changed
// mid-session lost the holds made under the old one, and re-posted at the next Stop
// transcript usage another dir had already settled: the cursor, claims and `since`
// live in the state dir. So the first hook of a session resolves its settings
// (config.mjs `resolveSettings`) and PINS them. Every later hook of that session,
// a resumed one included, uses the pin, and an edit applies to new sessions.
//
// THE PIN: <passwd home>/.local/state/usertrust/sessions/<session id>.json (below, for
// an environment session, the one other place it may be), 0600, in
// directories made 0700 and checked as the config anchor is (`privateDir`). It is
// published once (`publish`): written whole to a temp file, then link()ed to its
// name. A second hook that races to pin finds EEXIST, and reads the first one's
// file, complete.
// - `kind: "configured"`: the file's settings, key included. The key is on disk
//   already, in the config file, under the same protection.
// - `kind: "environment"`: the environment's settings WITHOUT the key, which stays
//   where it was. Each hook reads UT_SERVER_KEY afresh and checks it against the
//   pin's `keyHash`; a key that changed mid-session is refused, like any change.
// A refused config file is not pinned, and the next hook resolves again. A refused
// hook sends nothing, so nothing it saw can be posted twice.
//
// An ENVIRONMENT session whose passwd home cannot hold its pin pins in a per-user
// FALLBACK instead, `<real /tmp>/usertrust-<uid>/sessions/`, checked the same way
// (`fallbackDir`). It is derived from the uid alone, so no setting can move it, and
// every hook looks there after the passwd home and before it pins, whatever its
// settings now say: the pin it finds, and that pin's `kind`, decide the session. Only
// an environment session makes a pin there.
//
// Anything else wrong with the pin runs the hook refused: it sends nothing, and
// records a gap. That means a session id that is not safe as a file name, a directory
// or file that fails its checks, a corrupt pin, or no hard links. The hook never
// resolves without the pin, which could move the state dir. Its mode is still the
// session's, as resolved now: an enforce session blocks (PreToolUse fails closed,
// unless failOpen), and never silently stops enforcing. Only a refused config file,
// whose mode is unknown, runs watch-only.
//
// A pin deleted mid-session is made again, from the settings then current, by the
// next hook. A pin idle for 30 days is swept (`sweep`, at SessionStart); a session
// resumed at or after the sweep is pinned again, from the settings then current.
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	environment,
	environmentKey,
	keyHash,
	namesConfig,
	refusedSettings,
	resolveSettings,
} from "./config.mjs";
import { LINKLESS } from "./lib.mjs";

/** The plugin's private state under the passwd home; `sessions/` holds the pins. */
const STATE = [".local", "state", "usertrust"];
const SESSIONS = "sessions";

/** A session id as a pin's name: never sanitized, so two ids never share a pin. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A pin's name, and a publish's temp file: all `sweep` ever removes. */
const PIN_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;
const TEMP_NAME = /^[A-Za-z0-9_-]{1,128}\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

/** The largest pin read. */
const MAX_PIN_BYTES = 64 * 1024;

const HOUR_MS = 60 * 60 * 1000;
/** How long a pin may sit unused before `sweep` removes it. */
export const PIN_IDLE_MS = 30 * 24 * HOUR_MS;

const MODES = ["watch", "enforce"];
const USAGES = ["transcript", "estimate"];

const REAL_FS = {
	closeSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
};

/**
 * A directory the plugin keeps private state in, made 0700 when missing and accepted
 * only as the config anchor is (config.mjs `readConfig`). Its realpath must be its
 * path (no symlinked component), it must be a directory, the user must own it, and
 * no group or other may write it. Null when it is accepted, else the fixed reason it
 * is refused. Without POSIX ownership (`uid` null: Windows) the owner and mode
 * checks are skipped.
 */
export function privateDir(path, { uid, fs = REAL_FS }) {
	try {
		fs.mkdirSync(path, { recursive: true, mode: 0o700 });
		if (fs.realpathSync(path) !== path) return "symlink";
		const info = fs.lstatSync(path);
		if (!info.isDirectory()) return "type";
		if (uid !== null && info.uid !== uid) return "owner";
		if (uid !== null && (info.mode & 0o022) !== 0) return "mode";
		return null;
	} catch {
		return "missing";
	}
}

/**
 * The pins' directory under `home`, both its levels checked: `{ dir }` or
 * `{ refused }`. The home itself is taken by its real path, so a home the system
 * reaches through a symlink (as Fedora Atomic's /home → /var/home) is followed. Below
 * it, no component may be a symlink.
 */
function pinDir(home, { uid, fs }) {
	let base;
	try {
		base = fs.realpathSync(home);
	} catch {
		return { refused: "pin: dir refused (home)" };
	}
	const state = join(base, ...STATE);
	const dir = join(state, SESSIONS);
	const refused = privateDir(state, { uid, fs }) ?? privateDir(dir, { uid, fs });
	return refused === null ? { dir } : { refused: `pin: dir refused (${refused})` };
}

/**
 * The system's temporary directory, BY NAME: never `os.tmpdir()`, which TMPDIR moves.
 * `sessionSettings` and `sweep` take another only as a test's seam, never a setting.
 */
const TMP_ROOT = "/tmp";

/** The fallback's own directory, `<real tmp root>/usertrust-<uid>`, or null. Creates nothing. */
function fallbackBase({ uid, fs, tmpRoot }) {
	if (uid === null) return null;
	try {
		return join(fs.realpathSync(tmpRoot), `usertrust-${uid}`);
	} catch {
		return null;
	}
}

/**
 * Where an ENVIRONMENT session pins when the passwd home cannot hold its pin:
 * `<real /tmp>/usertrust-<uid>/sessions/`, both levels checked as the passwd home's
 * are, so a directory another user made first, or a link, is refused. It is derived
 * from the uid alone, never from a setting or a variable: no change to the state dir,
 * TMPDIR or the rest mid-session can move it. The passwd home is required so that no
 * environment can move a CONFIGURED session's pin; an environment session gets this
 * place too, which asks nothing 1.4.1 did not. Without a uid (Windows) there is none.
 * `{ dir }` or `{ refused }`.
 */
function fallbackDir({ uid, fs, tmpRoot }) {
	const base = fallbackBase({ uid, fs, tmpRoot });
	if (base === null) return { refused: "pin: fallback dir refused (missing)" };
	const dir = join(base, SESSIONS);
	const refused = privateDir(base, { uid, fs }) ?? privateDir(dir, { uid, fs });
	return refused === null ? { dir } : { refused: `pin: fallback dir refused (${refused})` };
}

/** Whether anything is at `path` (not following a final link). Creates nothing. */
function present(path, fs) {
	try {
		fs.lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalString = (value) => value === undefined || typeof value === "string";

/** A pin's text, checked field by field: the pin, or null when it is not one. */
function parsePin(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(value) || value.v !== 1 || !isObject(value.settings)) return null;
	const s = value.settings;
	const valid =
		typeof s.url === "string" &&
		MODES.includes(s.mode) &&
		typeof s.failOpen === "boolean" &&
		typeof s.stateDir === "string" &&
		s.stateDir !== "" &&
		USAGES.includes(s.usage) &&
		typeof s.model === "string" &&
		typeof s.sendContent === "boolean" &&
		optionalString(s.unit) &&
		optionalString(s.role) &&
		optionalString(s.unrecognizedMode);
	if (!valid) return null;
	if (value.kind === "configured" && typeof s.key === "string" && s.keyHash === undefined) {
		return value;
	}
	if (
		value.kind === "environment" &&
		typeof s.keyHash === "string" &&
		/^[0-9a-f]{16}$/.test(s.keyHash) &&
		s.key === undefined
	) {
		return value;
	}
	return null;
}

/**
 * The pin at `path`, opened without following a link, as a regular file the user
 * owns with no group or other permission bits: `{ pin }`, `{ missing: true }`, or
 * `{ refused }` with a fixed reason.
 */
export function readPin(path, { uid, fs = REAL_FS }) {
	let fd;
	try {
		fd = fs.openSync(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch (err) {
		return err?.code === "ENOENT" ? { missing: true } : { refused: "pin: unreadable" };
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > MAX_PIN_BYTES) return { refused: "pin: unreadable" };
		if (uid !== null && (info.uid !== uid || (info.mode & 0o077) !== 0)) {
			return { refused: "pin: unreadable" };
		}
		const pin = parsePin(fs.readFileSync(fd, "utf-8"));
		return pin === null ? { refused: "pin: corrupt" } : { pin };
	} catch {
		return { refused: "pin: unreadable" };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The pin of a resolution: every setting, but for an environment session the key's
 * hash, never the key.
 */
function pinOf(resolved, kind, now) {
	const { url, key, mode, unrecognizedMode, failOpen, stateDir, usage, model, sendContent } =
		resolved;
	const shared = {
		url,
		mode,
		failOpen,
		stateDir,
		usage,
		model,
		sendContent,
		unit: resolved.unit,
		role: resolved.role,
		unrecognizedMode,
	};
	return {
		v: 1,
		kind,
		createdAt: new Date(now).toISOString(),
		settings: kind === "configured" ? { ...shared, key } : { ...shared, keyHash: keyHash(key) },
	};
}

/**
 * A pin's settings, as config.mjs `settings()` gives them. An environment pin takes
 * its key from `env` (config.mjs `environmentKey`), and is refused when that key is
 * not the one the session was pinned with: it sends nothing, in its pinned mode, so
 * an enforce session blocks rather than stop enforcing.
 */
export function pinnedSettings(pin, env, passwdHome) {
	const { key, keyHash: pinned, ...rest } = pin.settings;
	const base = { refused: null, unrecognizedMode: undefined, unit: undefined, role: undefined };
	if (pin.kind === "configured") return { ...base, ...rest, configured: true, key };
	const current = environmentKey(env);
	if (keyHash(current) !== pinned) {
		return refusedSettings("pin: key changed", passwdHome, {
			configured: false,
			stateDir: rest.stateDir,
			mode: rest.mode,
			failOpen: rest.failOpen,
		});
	}
	return { ...base, ...rest, configured: false, key: current };
}

/**
 * Publish `content` as the pin at `path`, unless a pin is there already. The content
 * is written whole to a temp file first, then link()ed to the pin's name, which never
 * replaces a name: the pin is complete the moment it exists. Returns "won", "lost"
 * (another hook's pin was there first), or "nolink" (no hard links here).
 */
function publish(path, content, { fs }) {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = fs.openSync(
		tmp,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.linkSync(tmp, path);
		return "won";
	} catch (err) {
		if (err?.code === "EEXIST") return "lost";
		if (LINKLESS.has(err?.code)) return "nolink";
		throw err;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Already gone.
		}
	}
}

/**
 * This hook's session: its settings from the session's pin, made now when the
 * session has none; the pin's `kind` ("configured" or "environment", null when there
 * is no usable pin); and the pin's path. `payload` is the hook's input, which names
 * the session.
 * - Every hook looks, whatever its settings now say: first under the passwd home,
 *   then in the fallback (`fallbackDir`), and only then pins. The pin it finds, and
 *   its `kind`, decide the session, so a setting re-applied mid-session (another
 *   state dir, a config file named) can never pin the session a second time.
 * - A new pin goes under the passwd home. An environment session whose passwd home
 *   cannot hold it (none, a directory that fails its checks, a pin that cannot be
 *   written there) pins in the fallback instead. A configured session never does.
 * - A session that still has no usable pin gets refused settings: it sends nothing.
 *   Their mode and failOpen are what the session means to be, as resolved now
 *   (`intended`), so an enforce session still blocks (PreToolUse fails closed, as on
 *   any outage) and never silently stops enforcing. A refused config file names no
 *   mode, and stays watch-only.
 * - `tmpRoot` is a test's seam, never a setting (`TMP_ROOT`).
 */
export function sessionSettings({
	env = environment(),
	payload,
	passwdHome,
	uid,
	now = Date.now(),
	fs = REAL_FS,
	tmpRoot = TMP_ROOT,
}) {
	const intended = () => {
		const current = resolveSettings({ env, passwdHome, uid, fs });
		return current.refused === null ? { mode: current.mode, failOpen: current.failOpen } : {};
	};
	const refuse = (reason) => ({
		settings: refusedSettings(reason, passwdHome, { configured: namesConfig(env), ...intended() }),
		kind: null,
		path: null,
	});
	const use = (read, path) => {
		if (read.refused !== undefined) return refuse(read.refused);
		if (read.missing) return refuse("pin: unreadable");
		return { settings: pinnedSettings(read.pin, env, passwdHome), kind: read.pin.kind, path };
	};
	const id = isObject(payload) ? payload.session_id : undefined;
	if (typeof id !== "string" || !SESSION_ID.test(id)) return refuse("pin: session id refused");
	const name = `${id}.json`;
	// 1. Under the passwd home.
	const home =
		passwdHome === null ? { refused: "pin: dir refused (home)" } : pinDir(passwdHome, { uid, fs });
	if (home.refused === undefined) {
		const path = join(home.dir, name);
		const read = readPin(path, { uid, fs });
		if (!read.missing) return use(read, path);
	}
	// 2. In the fallback, made by an earlier hook of this session, whatever kind it is.
	const base = fallbackBase({ uid, fs, tmpRoot });
	if (base !== null && present(join(base, SESSIONS, name), fs)) {
		const there = fallbackDir({ uid, fs, tmpRoot });
		if (there.refused !== undefined) return refuse(there.refused);
		const path = join(there.dir, name);
		return use(readPin(path, { uid, fs }), path);
	}
	// 3. None yet: the settings now, pinned.
	const resolved = resolveSettings({ env, passwdHome, uid, fs });
	// A refused config file is not pinned: the next hook resolves again.
	if (resolved.refused !== null) return { settings: resolved, kind: null, path: null };
	const content = JSON.stringify(
		pinOf(resolved, resolved.configured ? "configured" : "environment", now),
	);
	/** Pin the session in `where`: `{ session }`, or `{ refused }` with why it cannot. */
	const pinIn = (where, failed) => {
		if (where.refused !== undefined) return { refused: where.refused };
		const path = join(where.dir, name);
		let outcome;
		try {
			outcome = publish(path, content, { fs });
		} catch {
			return { refused: failed.unwritable };
		}
		if (outcome === "nolink") return { refused: failed.nolink };
		// Won or lost, the pin is the one now there.
		return { session: use(readPin(path, { uid, fs }), path) };
	};
	const atHome = pinIn(home, { unwritable: "pin: unwritable", nolink: "pin: no hard links" });
	if (atHome.session !== undefined) return atHome.session;
	// Only an environment session makes a pin in the fallback.
	if (resolved.configured) return refuse(atHome.refused);
	const atFallback = pinIn(fallbackDir({ uid, fs, tmpRoot }), {
		unwritable: "pin: fallback dir unwritable",
		nolink: "pin: fallback dir has no hard links",
	});
	if (atFallback.session !== undefined) return atFallback.session;
	return refuse(`${atHome.refused}; ${atFallback.refused}`);
}

/** Mark a pin used now, so `sweep` keeps it while its session lives. Best effort. */
export function touchPin(path, { now = Date.now(), fs = REAL_FS } = {}) {
	try {
		fs.utimesSync(path, now / 1000, now / 1000);
	} catch {
		// Swept or removed meanwhile: the next hook pins again.
	}
}

/**
 * Remove pins unused for `idleMs` (30 days), and the temp files a publish that
 * crashed left behind (after an hour), at most `limit` in one call, and only in the
 * pins' own directories: the passwd home's, and the fallback (`fallbackDir`) when
 * there is one. SessionStart runs it, never SessionEnd: a session can be resumed.
 * Returns how many it removed. `tmpRoot` is a test's seam, never a setting.
 */
export function sweep({
	passwdHome,
	uid,
	now = Date.now(),
	idleMs = PIN_IDLE_MS,
	limit = 100,
	fs = REAL_FS,
	tmpRoot = TMP_ROOT,
}) {
	const dirs = [];
	if (passwdHome !== null) {
		const where = pinDir(passwdHome, { uid, fs });
		if (where.refused === undefined) dirs.push(where.dir);
	}
	const base = fallbackBase({ uid, fs, tmpRoot });
	if (base !== null && present(join(base, SESSIONS), fs)) {
		const where = fallbackDir({ uid, fs, tmpRoot });
		if (where.refused === undefined) dirs.push(where.dir);
	}
	let removed = 0;
	for (const dir of dirs) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (removed >= limit) return removed;
			const pin = PIN_NAME.test(name);
			if (!pin && !TEMP_NAME.test(name)) continue;
			const path = join(dir, name);
			try {
				const info = fs.lstatSync(path);
				if (!info.isFile() || now - info.mtimeMs <= (pin ? idleMs : HOUR_MS)) continue;
				fs.unlinkSync(path);
				removed += 1;
			} catch {
				// Removed meanwhile.
			}
		}
	}
	return removed;
}
