// The watch-mode circuit breaker: a server that has stopped answering costs one minute of
// skipped hooks, not every tool call's full timeouts.
//
// A HUNG server (the tunnel up, its far end accepting connections and answering nothing) is
// worse than a dead one: a refused connection costs milliseconds, but every hook of every
// lane would pay its full timeouts, about 7 s per PreToolUse and 8 s per PostToolUse, for as
// long as the hang lasts. So:
// - THE FILE is HOST-WIDE, one per server: <passwd home>/.local/state/usertrust/breaker/
//   <sha256(url)[0:16]>.json, 0600, in directories made 0700 and checked as the config anchor
//   is (private-dir.mjs). A hang is the server's, not a lane's, so every lane of the user on
//   this host shares it. It holds `{ openUntil, openedAt, timeouts: [ms, ...] }`.
// - WHAT COUNTS: a request this hook's own timer aborted is a timeout (lib.mjs passes its
//   deadline; one under MIN_COUNTED_MS is the hook's budget running out, not the server's
//   silence, and does not count). `timeouts[]` holds the consecutive ones of the last
//   WINDOW_MS, and the TRIP_TIMEOUTS-th opens the breaker for OPEN_MS. ANY answer, a refusal
//   included, clears the count: a whole answer, its body read, so headers and then a stall end
//   in the timeout they are. It does not close a breaker already open: only the half-open probe
//   does (below). A refused or reset connection neither counts nor clears: it fails fast, and
//   stalls nothing.
// - Every update is a read, then a whole write (a temp file renamed over the name). Two
//   hooks counting at once can lose an update: a lost timeout delays opening, and a lost
//   answer can let timeouts that were not in a row open it. Either way the breaker is wrong
//   by one minute at most, and every hook it skips writes its record. A lock would serialize
//   every hook of every session on the host for that.
// - A missing or corrupt file, one that is not the user's own, or a directory that fails its
//   checks reads CLOSED: a bad file can never switch metering off. An open breaker is open for
//   OPEN_MS from `openedAt`, whatever `openUntil` says, and an `openedAt` in the future (a
//   clock set back, a hand edit) reads CLOSED: no value can hold it open. (Capped at now +
//   OPEN_MS instead, a far-future `openUntil` would read open at every read, for good.)
// - HALF-OPEN: past `openUntil`, the hook that wins `<name>.probe` by an exclusive create
//   probes the server once (lib.mjs: `/v1/health`, ≤ 1 s and a fifth of the hook's budget).
//   An answer, its body read, deletes the file (closed), and the hook runs as usual; no answer
//   re-opens it for OPEN_MS, and the hook skips. A probe that could not run (no time left)
//   decides nothing: the file is left past its minute for the next hook, and this one skips.
//   Either way the prober removes its marker. Every other hook skips while the marker is
//   within PROBE_STALE_MS of now; one older (its prober died), or dated further ahead (the
//   clock was set back), reads CLOSED, and is removed.
// Only watch mode reads or writes it (lib.mjs `breakerOpen`): enforce keeps failing closed.
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { passwdHome } from "./config.mjs";
import { stateSubdir } from "./private-dir.mjs";

/** Consecutive timeouts within WINDOW_MS that open the breaker. */
export const TRIP_TIMEOUTS = 3;
export const WINDOW_MS = 60_000;
/** How long an opened breaker stays open before one hook probes. */
export const OPEN_MS = 60_000;
/** How long a prober's marker holds the other hooks off. */
export const PROBE_STALE_MS = 5_000;
/** The shortest deadline whose abort counts as a timeout. */
export const MIN_COUNTED_MS = 1_000;

const DIR = "breaker";
const MAX_BYTES = 4096;

const REAL_FS = {
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
};

/** The passwd home the breaker lives under: unset, this process's own (config.mjs `passwdHome`). */
let home;

/**
 * Set the passwd home: launch.mjs gives a configured session's child the one its parent read,
 * as that child's environment holds nothing to find it by. Null: no breaker, read as CLOSED.
 */
export function useBreakerHome(value) {
	home = value;
}

const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** The breaker of `url`: its file and its probe marker, or `{ refused }` (`absent`: none yet). */
function locate(url, { create, fs }) {
	const at = home === undefined ? passwdHome() : home;
	if (typeof at !== "string" || typeof url !== "string") return { refused: "home" };
	const where = stateSubdir(at, DIR, { uid: currentUid(), fs, create });
	if (where.refused !== undefined) return where;
	const name = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return { path: join(where.dir, `${name}.json`), probe: join(where.dir, `${name}.probe`) };
}

/**
 * The breaker as read at `now`: `{ timeouts }`, with `openUntil` and `openedAt` once it has
 * opened. CLOSED (`{ timeouts: [] }`) when the file is missing, corrupt, too large, or not a
 * regular file the user owns with no group or other permission bits. An open breaker's
 * `openUntil` is at most `openedAt` + OPEN_MS, and one opened in the future is not open. A
 * timeout older than WINDOW_MS, or in the future, is dropped.
 */
function read(path, now, fs) {
	let fd;
	try {
		fd = fs.openSync(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch {
		return { timeouts: [] };
	}
	try {
		const info = fs.fstatSync(fd);
		const uid = currentUid();
		if (!info.isFile() || info.size > MAX_BYTES) return { timeouts: [] };
		if (uid !== null && (info.uid !== uid || (info.mode & 0o077) !== 0)) return { timeouts: [] };
		const value = JSON.parse(fs.readFileSync(fd, "utf-8"));
		const timeouts = Array.isArray(value?.timeouts)
			? value.timeouts.filter((t) => Number.isFinite(t) && t <= now && now - t < WINDOW_MS)
			: [];
		const { openUntil, openedAt } = value ?? {};
		if (!Number.isFinite(openUntil) || !Number.isFinite(openedAt) || openedAt > now) {
			return { timeouts };
		}
		return { timeouts, openUntil: Math.min(openUntil, openedAt + OPEN_MS), openedAt };
	} catch {
		return { timeouts: [] };
	} finally {
		fs.closeSync(fd);
	}
}

/** Write the breaker whole: a temp file, then a rename over the name. A failed write is lost. */
function write(path, state, fs) {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
		fs.renameSync(tmp, path);
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Never made.
		}
	}
}

/** What an opened breaker keeps of its state when its counter changes. */
const opened = (state) =>
	state.openUntil === undefined ? {} : { openUntil: state.openUntil, openedAt: state.openedAt };

/**
 * One of this hook's requests to `url` timed out: its own timer aborted it, after `deadlineMs`.
 * Returns true when this timeout opened the breaker. Never throws.
 */
export function noteTimeout(url, deadlineMs, { now = Date.now(), fs = REAL_FS } = {}) {
	if (!(deadlineMs >= MIN_COUNTED_MS)) return false;
	try {
		const at = locate(url, { create: true, fs });
		if (at.refused !== undefined) return false;
		const state = read(at.path, now, fs);
		if (state.openUntil !== undefined && state.openUntil > now) return false;
		const timeouts = [...state.timeouts, now];
		if (timeouts.length >= TRIP_TIMEOUTS) {
			write(at.path, { openUntil: now + OPEN_MS, openedAt: now, timeouts: [] }, fs);
			return true;
		}
		write(at.path, { ...opened(state), timeouts }, fs);
		return false;
	} catch {
		return false;
	}
}

/** `url` answered one of this hook's requests: the timeouts so far are not consecutive. Never throws. */
export function noteAnswer(url, { now = Date.now(), fs = REAL_FS } = {}) {
	try {
		const at = locate(url, { create: false, fs });
		if (at.refused !== undefined) return;
		const state = read(at.path, now, fs);
		if (state.timeouts.length > 0) write(at.path, { ...opened(state), timeouts: [] }, fs);
	} catch {
		// A clear that is lost can let the breaker open early: for one minute, every skip recorded.
	}
}

/**
 * Whether the breaker of `url` keeps this hook off the network: `{ state: "open" }` or
 * `{ state: "closed" }`, with `note` when its directory is refused (it reads closed), and
 * `reopened` or `closed` when this hook's probe decided it, or `unprobed` when the probe could
 * not run. `probe` resolves to whether the server answered, or null when it did not ask. Never
 * throws.
 */
export async function consultBreaker(url, probe, { clock = Date.now, fs = REAL_FS } = {}) {
	let at;
	try {
		at = locate(url, { create: false, fs });
	} catch {
		return { state: "closed" };
	}
	if (at.refused !== undefined) {
		return at.refused === "absent" ? { state: "closed" } : { state: "closed", note: at.refused };
	}
	const state = read(at.path, clock(), fs);
	if (state.openUntil === undefined) return { state: "closed" };
	if (clock() < state.openUntil) return { state: "open" };
	// Half-open: one hook probes, by an exclusive create of the marker.
	try {
		fs.closeSync(
			fs.openSync(
				at.probe,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o600,
			),
		);
	} catch (err) {
		if (err?.code !== "EEXIST") return { state: "closed" };
		try {
			// A marker within PROBE_STALE_MS of this clock, either way, has a prober at work: a fresh
			// one's mtime, finer than Date.now(), can lead it by under a millisecond. One further off,
			// too old or dated in the future (the clock was set back), has none this clock can vouch
			// for: stale.
			const age = clock() - fs.lstatSync(at.probe).mtimeMs;
			if (Math.abs(age) < PROBE_STALE_MS) return { state: "open" };
			fs.unlinkSync(at.probe);
		} catch {
			// Gone meanwhile: its prober finished.
		}
		return { state: "closed" };
	}
	try {
		const answered = await probe();
		// The probe did not run (no time left to ask): nothing was learned, so nothing changes. The
		// breaker stays past its minute for the next hook to probe, and this one sends nothing.
		if (answered === null) return { state: "open", unprobed: true };
		if (answered) {
			try {
				fs.unlinkSync(at.path);
			} catch {
				// Gone meanwhile.
			}
			return { state: "closed", closed: true };
		}
		const now = clock();
		write(at.path, { openUntil: now + OPEN_MS, openedAt: now, timeouts: [] }, fs);
		return { state: "open", reopened: true };
	} catch {
		return { state: "closed" };
	} finally {
		try {
			fs.unlinkSync(at.probe);
		} catch {
			// Removed meanwhile.
		}
	}
}
