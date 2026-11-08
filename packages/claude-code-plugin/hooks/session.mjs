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
// THE PIN: <passwd home>/.local/state/usertrust/sessions/<session id>.json, 0600, in
// directories made 0700 and checked as the config anchor is (private-dir.mjs). It is
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
// The pin has ONE place. Before one is made, its name there is read (`readPin`): a pin;
// none, which only ENOENT means; or a failure to read it, which refuses the hook, so a
// pin that cannot be read is never taken for none. A session whose passwd home cannot
// hold its pin has nowhere else: a pin made anywhere else could be the session's second,
// and charge usage twice.
//
// Anything wrong with the pin itself runs the hook refused: key-less, it sends nothing,
// and records a gap. That means a session id that is not safe as a file name, a passwd
// home that cannot hold the pin (none, or a directory that fails its checks), a pin
// that cannot be read, a corrupt pin, or no hard links. The hook never sends with
// settings resolved in the pin's place, which could move the state dir. Its mode is still
// the session's: an enforce session blocks (PreToolUse fails closed, unless failOpen),
// and never silently stops enforcing. Only a refused config file, whose mode is unknown,
// runs watch-only.
//
// A pin deleted mid-session is made again, from the settings then current, by the
// next hook. A pin idle for 30 days is swept (`sweep`, at SessionStart); a session
// resumed at or after the sweep is pinned again, from the settings then current.
//
// A pin is never changed, with ONE exception, made only at SessionStart (`repin`): a
// DEAD environment pin is re-pinned to the conventional config file. Such a pin was
// made before that file was read (config.mjs `configSource`), and it would otherwise
// keep a session unconfigured for its whole life, resumes included. Dead means ALL of
// (`deadPin`): it holds the EMPTY key; the conventional file is the source now, and is
// accepted; the session moved no money under it (`movedNoMoney`); and the file names a
// state dir that is NOT the pin's own, links resolved (`sameStateDir`). That last one is
// what keeps usage from being posted twice: a new state dir stamps the session's first
// metered hook there (transcript.mjs `sessionFirstRun`), and nothing the transcript holds
// from before it is ever posted there, while the pin's own dir already holds the stamp and
// cursors of the unconfigured session. The re-pin, in order:
// 1. the session's job log is carried to the new state dir (`carryJobLog`), since a
//    resume or compact writes none there (job-log.mjs `writeSessionStart`);
// 2. the re-pin is appended to <private state>/repins/repins.jsonl (old pin, new pin with
//    the key hashed, reason), synced, while the old pin is still in place;
// 3. the old pin is kept aside under a second name (a hard link, never a deletion), and
//    ONE rename puts the new pin in its place (`swapPin`).
// So every other hook of the session reads a pin throughout: the old one, then the new
// one. A step that fails leaves the old pin in place, and SessionStart warns, loudly, that
// the session is UNCONFIGURED, with why; a swap that fails after its record is followed by
// a record naming it abandoned. SessionStart says a re-pin once. The old state dir is left
// exactly as it was. Any other environment pin is kept, and when a config file would now
// be read SessionStart warns, loudly, that the session is UNCONFIGURED.
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
	renameSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	CONVENTIONAL_NAME,
	configSource,
	DEFAULT_HOLD_GRACE_MS,
	environment,
	environmentKey,
	isHoldGrace,
	keyHash,
	refusalNote,
	refusedSettings,
	repinFailedNote,
	repinnedNote,
	resolveSettings,
	unconfiguredNote,
} from "./config.mjs";
import { LINKLESS } from "./lib.mjs";
import { stateSubdir } from "./private-dir.mjs";

/** Under the plugin's private state (private-dir.mjs): the pins. */
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
/** Where a configured pin's file was found (config.mjs `configSource`); older pins name none. */
const CONFIG_SOURCES = ["variable", "conventional"];

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
	renameSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
};

/**
 * The pins' directory under `home`, both its levels made and checked (private-dir.mjs
 * `stateSubdir`): `{ dir }` or `{ refused }`.
 */
function pinDir(home, { uid, fs }) {
	const where = stateSubdir(home, SESSIONS, { uid, fs });
	return where.refused === undefined ? where : { refused: `pin: dir refused (${where.refused})` };
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
		// A pin made before the model stopped being a setting holds one (`pinnedSettings` drops it).
		(s.model === undefined || typeof s.model === "string") &&
		(s.ignoredModel === undefined || typeof s.ignoredModel === "boolean") &&
		typeof s.sendContent === "boolean" &&
		optionalString(s.unit) &&
		optionalString(s.role) &&
		// A pin made before the setting existed has none: the default.
		(s.holdGraceMs === undefined || isHoldGrace(s.holdGraceMs)) &&
		(s.jobTypeInstruction === undefined || typeof s.jobTypeInstruction === "boolean") &&
		(s.configSource === undefined || CONFIG_SOURCES.includes(s.configSource)) &&
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
	const { url, key, mode, unrecognizedMode, failOpen, stateDir, usage, sendContent } = resolved;
	const shared = {
		url,
		mode,
		failOpen,
		stateDir,
		usage,
		ignoredModel: resolved.ignoredModel === true,
		sendContent,
		unit: resolved.unit,
		role: resolved.role,
		holdGraceMs: resolved.holdGraceMs,
		jobTypeInstruction: resolved.jobTypeInstruction === true,
		unrecognizedMode,
	};
	const configured = { ...shared, configSource: resolved.configSource };
	return {
		v: 1,
		kind,
		createdAt: new Date(now).toISOString(),
		settings: kind === "configured" ? { ...configured, key } : { ...shared, keyHash: keyHash(key) },
	};
}

/** A pin as the re-pin record holds it: never a key, only its hash. */
function recordable(pin) {
	const { key, ...rest } = pin.settings;
	return { ...pin, settings: key === undefined ? rest : { ...rest, keyHash: keyHash(key) } };
}

/** The hash of the empty key: what an environment pin made with no UT_SERVER_KEY holds. */
const EMPTY_KEY_HASH = keyHash("");

/** The most names `movedNoMoney` reads in one directory, its most cursors, and its largest file. */
const MAX_DEAD_NAMES = 100_000;
const MAX_DEAD_CURSORS = 4096;
const MAX_DEAD_FILE_BYTES = 64 * 1024 * 1024;

/** A cursor's name, under <stateDir>/transcripts: `<session>__<agent>.json` (transcript.mjs). */
const CURSOR_NAME = /^[A-Za-z0-9_-]+\.json$/;

/**
 * Watch records that say nothing reached a server: a gap, usage from before metering, an agent
 * with no transcript. Any other record of the session (a `would_block` is a server's answer)
 * means one did.
 */
const LOCAL_RECORDS = new Set(["gap", "pre-metering", "no-transcript-agent"]);

/**
 * A file's text, read without following a link, only as a regular file the user owns within
 * `MAX_DEAD_FILE_BYTES`: null otherwise.
 */
function boundedText(path, { uid, fs }) {
	let fd;
	try {
		fd = fs.openSync(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch {
		return null;
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > MAX_DEAD_FILE_BYTES) return null;
		if (uid !== null && info.uid !== uid) return null;
		return fs.readFileSync(fd, "utf-8");
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Whether a cursor's text is a v2 cursor (transcript.mjs `writeCursor`) holding no id that may
 * have reached a server: `posted`, `accounted`, `unresolved` and `assigned` all empty.
 */
function emptyCursor(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return false;
	}
	return (
		isObject(value) &&
		value.v === 2 &&
		Array.isArray(value.posted) &&
		value.posted.length === 0 &&
		Array.isArray(value.accounted) &&
		value.accounted.length === 0 &&
		isObject(value.unresolved) &&
		Object.keys(value.unresolved).length === 0 &&
		isObject(value.assigned) &&
		Object.keys(value.assigned).length === 0
	);
}

/**
 * Whether `stateDir` records that session `id` moved NO money: null when it moved none, else
 * the fixed reason it may have. Read for THIS session only (the dir is shared by every session
 * pinned to it), and at the strict end: anything unreadable, over a bound or of a shape not
 * known here counts as money that may have moved.
 * - No hold file of the session at the top level (`<id>__…`, any suffix, `.settling` and
 *   `.releasing` included): a hold exists only after a reserve the server accepted.
 * - Every cursor of the session (`transcripts/<id>__…`) is a v2 cursor whose `posted`,
 *   `accounted`, `unresolved` and `assigned` are all empty. `accounted` also holds ids that may
 *   have posted (a settle never seen to end), so a non-empty one is never taken for none.
 * - No record of the session in `watch.jsonl` but the local ones (`LOCAL_RECORDS`): a settle at
 *   the estimate that succeeded leaves no hold and no cursor id, but nor does it leave a gap.
 * A /v1/health answer (`capabilities/`) is NOT counted, ON PURPOSE: it moves no money. Only a
 * reserve, a settle or a post counts. Do not "fix" this by counting capabilities: a server that
 * answered health and nothing else would keep a dead pin for the session's life.
 */
export function movedNoMoney(stateDir, id, { uid, fs = REAL_FS }) {
	const prefix = `${id}__`;
	const names = (dir) => {
		try {
			const list = fs.readdirSync(dir);
			return list.length > MAX_DEAD_NAMES ? null : list;
		} catch {
			return null;
		}
	};
	const top = names(stateDir);
	if (top === null) return "its state dir is unreadable";
	if (top.some((name) => name.startsWith(prefix))) return "its state dir holds a hold of it";
	const cursors = names(join(stateDir, "transcripts"));
	if (cursors === null) return "its transcript state is unreadable";
	const mine = cursors.filter((name) => name.startsWith(prefix));
	if (mine.length > MAX_DEAD_CURSORS) return "it has more cursors than are read";
	for (const name of mine) {
		const text = CURSOR_NAME.test(name)
			? boundedText(join(stateDir, "transcripts", name), { uid, fs })
			: null;
		if (text === null || !emptyCursor(text)) {
			return "its cursors record usage that may have been posted";
		}
	}
	if (top.includes("watch.jsonl")) {
		const text = boundedText(join(stateDir, "watch.jsonl"), { uid, fs });
		if (text === null) return "its watch records are unreadable";
		const tag = `"session":${JSON.stringify(id)}`;
		for (const line of text.split("\n")) {
			if (!line.includes(tag)) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				return "its watch records are unreadable";
			}
			if (!isObject(record) || !LOCAL_RECORDS.has(record.kind)) return "a server answered it";
		}
	}
	return null;
}

/**
 * Whether environment pin `pin` of session `id` is DEAD, so SessionStart may re-pin it: null
 * when it is, else the fixed reason it is kept. `resolved` is what a new session would get now
 * (config.mjs `resolveSettings`). All four must hold:
 * 1. it holds the EMPTY key (`EMPTY_KEY_HASH`);
 * 2. the conventional config file is the source now (UT_CC_CONFIG unset) and is accepted;
 * 3. the session moved no money under it (`movedNoMoney`);
 * 4. the file names a state dir that is not the pin's own (`sameStateDir`).
 */
export function deadPin(pin, id, resolved, { uid, fs = REAL_FS }) {
	if (pin.kind !== "environment") return "it is not an environment pin";
	if (pin.settings.keyHash !== EMPTY_KEY_HASH) return "it was pinned with a key";
	if (resolved.configSource !== "conventional") {
		return `${CONVENTIONAL_NAME} is not where a new session's settings come from`;
	}
	if (resolved.refused !== null) return refusalNote(resolved.refused, "conventional");
	const moved = movedNoMoney(pin.settings.stateDir, id, { uid, fs });
	if (moved !== null) return moved;
	if (sameStateDir(pin.settings.stateDir, resolved.stateDir, { fs })) return SAME_STATE_DIR;
	return null;
}

/** Why a dead pin is kept when the conventional file names its own state dir (`sameStateDir`). */
const SAME_STATE_DIR =
	"the conventional file names the state dir it was pinned with, where the usage recorded before the re-pin would be posted under the new key";

/**
 * Whether state dirs `a` and `b` are one directory, links resolved. A dir that does not exist is
 * compared by its absolute path (it cannot be an existing one; and `deadPin` reads the pin's own
 * dir first, so that one exists). Any other failure counts as the same: the strict side.
 */
function sameStateDir(a, b, { fs }) {
	const real = (dir) => {
		try {
			return fs.realpathSync(dir);
		} catch (err) {
			return err?.code === "ENOENT" ? resolve(dir) : null;
		}
	};
	const ra = real(a);
	const rb = real(b);
	return ra === null || rb === null || ra === rb;
}

/** Append the re-pin record, whole and synced, to a regular file the user owns, 0600: its path. */
function appendRecord(home, record, { uid, fs }) {
	const where = stateSubdir(home, "repins", { uid, fs });
	if (where.refused !== undefined) throw new Error("repins dir refused");
	const path = join(where.dir, "repins.jsonl");
	const fd = fs.openSync(
		path,
		constants.O_WRONLY |
			constants.O_APPEND |
			constants.O_CREAT |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0),
		0o600,
	);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile()) throw new Error("repins file refused");
		if (uid !== null && (info.uid !== uid || (info.mode & 0o077) !== 0)) {
			throw new Error("repins file refused");
		}
		fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	return path;
}

/** The note this process's SessionStart shows (`setSessionNote`, `takeSessionNote`). */
let sessionNote = null;

/** Keep `note` for this process's SessionStart (launch.mjs, from `sessionSettings`). */
export function setSessionNote(note) {
	sessionNote = typeof note === "string" ? note : null;
}

/** The session's note, once: null after the first take, or when there is none. */
export function takeSessionNote() {
	const note = sessionNote;
	sessionNote = null;
	return note;
}

/**
 * A pin's settings, as config.mjs `settings()` gives them. An environment pin takes
 * its key from `env` (config.mjs `environmentKey`), and is refused when that key is
 * not the one the session was pinned with: it sends nothing, in its pinned mode, so
 * an enforce session blocks rather than stop enforcing.
 */
export function pinnedSettings(pin, env, passwdHome) {
	// An older pin's `model` is dropped: the model a hold names is never a setting (config.mjs).
	const { key, keyHash: pinned, model: _model, ...rest } = pin.settings;
	const base = {
		refused: null,
		unrecognizedMode: undefined,
		unit: undefined,
		role: undefined,
		holdGraceMs: DEFAULT_HOLD_GRACE_MS,
		jobTypeInstruction: false,
	};
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
 * Write `content` to `path` whole, replacing whatever is there in one rename: a temp file
 * beside it (O_EXCL, 0600, synced), then renamed over it. Throws when it is not done.
 */
function replace(path, content, { fs }) {
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
		fs.renameSync(tmp, path);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Already gone.
		}
		throw err;
	}
}

/**
 * Carry session `id`'s job log (job-log.mjs `jobLogPath`, `<stateDir>/jobs/<id>.jsonl`: a valid
 * session id is its own sanitized name) from the dead pin's state dir to the new one, so
 * `usertrust-job` keeps working there, an open job included. Null when it is carried, or there is
 * none; else the fixed reason it is not. The old log is read, never changed. A log already in the
 * new dir is kept when it is the same bytes, and replaced when it is a beginning of them (an
 * earlier carry whose re-pin then failed, while the log grew); any other one refuses the re-pin.
 */
function carryJobLog(oldDir, newDir, id, { uid, fs }) {
	const from = join(oldDir, "jobs", `${id}.jsonl`);
	try {
		fs.lstatSync(from);
	} catch (err) {
		return err?.code === "ENOENT" ? null : "the session's job log is unreadable";
	}
	const text = boundedText(from, { uid, fs });
	if (text === null) return "the session's job log is unreadable";
	const dir = join(newDir, "jobs");
	const to = join(dir, `${id}.jsonl`);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const outcome = publish(to, text, { fs });
		if (outcome === "won") return null;
		if (outcome === "nolink") return "the session's job log could not be carried (no hard links)";
		const there = boundedText(to, { uid, fs });
		if (there === text) return null;
		if (there === null || !text.startsWith(there)) {
			return "the new state dir already holds another job log of this session";
		}
		replace(to, text, { fs });
		return null;
	} catch {
		return "the session's job log could not be written to the new state dir";
	}
}

/**
 * Put pin `content` at `path` in place of the old pin `old`, in one step: the old pin is first
 * kept aside as `aside` (a second name for the same file, so it is never deleted), checked to be
 * `old` still, and then ONE rename replaces it. Null when done, else the fixed reason it is not;
 * until the rename, the old pin is at `path`.
 */
function swapPin(path, aside, old, content, { uid, fs }) {
	try {
		fs.linkSync(path, aside);
	} catch {
		return "the old pin could not be kept aside";
	}
	const kept = readPin(aside, { uid, fs });
	if (kept.pin === undefined || JSON.stringify(kept.pin) !== JSON.stringify(old)) {
		return "the pin changed meanwhile";
	}
	try {
		replace(path, content, { fs });
	} catch {
		return "the new pin could not be published";
	}
	return null;
}

/**
 * This hook's session: its settings from the session's pin, made now when the
 * session has none; the pin's `kind` ("configured" or "environment", null when there
 * is no usable pin); and the pin's path. `payload` is the hook's input, which names
 * the session.
 * - The pin is made only under the passwd home, and only once `readPin` says there is
 *   none: ENOENT, nothing else. A passwd home that cannot hold it (none: a failed
 *   passwd lookup included; or a directory that fails its checks) refuses the hook.
 * - Anything wrong with the pin gives refused settings: the hook sends nothing. Their
 *   mode and failOpen are what the session means to be, so an enforce session still
 *   blocks (PreToolUse fails closed, as on any outage) and never silently stops
 *   enforcing. Once this hook has resolved the settings itself, they are that
 *   resolution's; a config file read again could be caught mid-replacement, and name
 *   no mode. Before then, they are the settings as resolved now (`intended`), or the
 *   pin's own for `pin: key changed`. A refused config file names no mode, and stays
 *   watch-only.
 */
export function sessionSettings({
	env = environment(),
	payload,
	passwdHome,
	uid,
	now = Date.now(),
	fs = REAL_FS,
	repin = false,
}) {
	/** The mode and failOpen the session means to have, as resolved now: none for a refused file. */
	const intended = () => {
		const current = resolveSettings({ env, passwdHome, uid, fs });
		return current.refused === null ? { mode: current.mode, failOpen: current.failOpen } : {};
	};
	/** Refused settings, in `known`'s mode and failOpen when this hook resolved them, else as now. */
	const refuse = (reason, known = intended()) => ({
		settings: refusedSettings(reason, passwdHome, {
			configured: configSource({ env, passwdHome, fs }) !== "environment",
			...known,
		}),
		kind: null,
		path: null,
		note: null,
	});
	/** The session of the pin `read` at `path`, refused as `known` says when it is not usable. */
	const use = (read, path, known) => {
		if (read.refused !== undefined) return refuse(read.refused, known);
		if (read.missing) return refuse("pin: unreadable", known);
		return {
			settings: pinnedSettings(read.pin, env, passwdHome),
			kind: read.pin.kind,
			path,
			note: null,
		};
	};
	const id = isObject(payload) ? payload.session_id : undefined;
	if (typeof id !== "string" || !SESSION_ID.test(id)) return refuse("pin: session id refused");
	if (passwdHome === null) return refuse("pin: dir refused (home)");
	const where = pinDir(passwdHome, { uid, fs });
	if (where.refused !== undefined) return refuse(where.refused);
	const path = join(where.dir, `${id}.json`);
	/** Publish `pin`, made from `resolved`, at `path`, and use the pin then there. */
	const pinWith = (resolved, pin) => {
		const known = { mode: resolved.mode, failOpen: resolved.failOpen };
		let outcome;
		try {
			outcome = publish(path, JSON.stringify(pin), { fs });
		} catch {
			return refuse("pin: unwritable", known);
		}
		if (outcome === "nolink") return refuse("pin: no hard links", known);
		// Won or lost, the pin is the one now there.
		return use(readPin(path, { uid, fs }), path, known);
	};
	/** No pin yet: resolve now, and pin that. */
	const pinNew = () => {
		const resolved = resolveSettings({ env, passwdHome, uid, fs });
		// A refused config file is not pinned: the next hook resolves again.
		if (resolved.refused !== null) {
			return { settings: resolved, kind: null, path: null, note: null };
		}
		return pinWith(
			resolved,
			pinOf(resolved, resolved.configured ? "configured" : "environment", now),
		);
	};
	const read = readPin(path, { uid, fs });
	// None, which only ENOENT says.
	if (read.missing) return pinNew();
	// A pin, or one that cannot be read: never taken for none, so no pin is made for it. The one
	// exception is a DEAD environment pin at SessionStart (`deadPin`): it is re-pinned.
	if (!repin || read.pin?.kind !== "environment") return use(read, path);
	const resolved = resolveSettings({ env, passwdHome, uid, fs });
	const kept = deadPin(read.pin, id, resolved, { uid, fs });
	if (kept !== null) {
		const session = use(read, path);
		// Unconfigured while a new session would read a config file: say so, loudly.
		const source = configSource({ env, passwdHome, fs });
		if (source === "environment") return session;
		return {
			...session,
			note: unconfiguredNote({ createdAt: read.pin.createdAt, source, why: kept }),
		};
	}
	/**
	 * The re-pin did not complete: use the pin now at `path` (still the old one, unless another
	 * hook replaced it meanwhile), and say UNCONFIGURED only when it is an environment pin.
	 */
	const failed = (why) => {
		const there = readPin(path, { uid, fs });
		if (there.missing) return pinNew();
		const session = use(there, path);
		return { ...session, note: there.pin?.kind === "environment" ? repinFailedNote(why) : null };
	};
	const carried = carryJobLog(read.pin.settings.stateDir, resolved.stateDir, id, { uid, fs });
	if (carried !== null) return failed(carried);
	const next = pinOf(resolved, "configured", now);
	const record = randomBytes(8).toString("hex");
	const aside = `${path}.repinned.${now}.${randomBytes(6).toString("hex")}`;
	const at = new Date(now).toISOString();
	let recorded;
	try {
		recorded = appendRecord(
			passwdHome,
			{
				v: 1,
				id: record,
				at,
				session: id,
				reason:
					"dead environment pin: the empty key, the conventional config file accepted, no money moved for this session in its state dir, and a state dir of its own",
				old: { ...recordable(read.pin), movedTo: aside },
				new: recordable(next),
			},
			{ uid, fs },
		);
	} catch {
		// No record, no re-pin: the old pin was never touched.
		return failed("the re-pin record could not be written");
	}
	const swapped = swapPin(path, aside, read.pin, JSON.stringify(next), { uid, fs });
	if (swapped !== null) {
		try {
			appendRecord(
				passwdHome,
				{ v: 1, at, session: id, abandoned: record, why: swapped },
				{ uid, fs },
			);
		} catch {
			// The record above stands alone; the pin at `path` says the re-pin did not happen.
		}
		return failed(swapped);
	}
	const session = use(readPin(path, { uid, fs }), path, {
		mode: resolved.mode,
		failOpen: resolved.failOpen,
	});
	return {
		...session,
		note:
			session.kind === "configured"
				? repinnedNote({ createdAt: read.pin.createdAt, record: recorded })
				: null,
	};
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
 * pins' own directory. SessionStart runs it, never SessionEnd: a session can be
 * resumed. Returns how many it removed.
 */
export function sweep({
	passwdHome,
	uid,
	now = Date.now(),
	idleMs = PIN_IDLE_MS,
	limit = 100,
	fs = REAL_FS,
}) {
	if (passwdHome === null) return 0;
	const where = pinDir(passwdHome, { uid, fs });
	if (where.refused !== undefined) return 0;
	let names;
	try {
		names = fs.readdirSync(where.dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (removed >= limit) break;
		const pin = PIN_NAME.test(name);
		if (!pin && !TEMP_NAME.test(name)) continue;
		const path = join(where.dir, name);
		try {
			const info = fs.lstatSync(path);
			if (!info.isFile() || now - info.mtimeMs <= (pin ? idleMs : HOUR_MS)) continue;
			fs.unlinkSync(path);
			removed += 1;
		} catch {
			// Removed meanwhile.
		}
	}
	return removed;
}
