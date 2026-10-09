// The plugin's private state under the passwd home: <home>/.local/state/usertrust/<name>.
// Sessions keep their pins there (session.mjs), and every lane of a user on a host shares
// one circuit breaker per server there (breaker.mjs). Each directory is accepted only as the
// config anchor is (config.mjs `readConfig`): its realpath must be its path (no symlinked
// component), it must be a directory, the user must own it, and no group or other may write
// it. Node built-ins only: every other hook module imports this one.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Under the passwd home: the plugin's private state. */
export const PRIVATE_STATE = [".local", "state", "usertrust"];

const REAL_FS = { lstatSync, mkdirSync, realpathSync };

/**
 * The checks of a private directory that must already exist: null when it is accepted, else
 * the fixed reason it is refused, `absent` when there is no such directory. Without POSIX
 * ownership (`uid` null: Windows) the owner and mode checks are skipped.
 */
export function checkedDir(path, { uid, fs = REAL_FS }) {
	try {
		if (fs.realpathSync(path) !== path) return "symlink";
		const info = fs.lstatSync(path);
		if (!info.isDirectory()) return "type";
		if (uid !== null && info.uid !== uid) return "owner";
		if (uid !== null && (info.mode & 0o022) !== 0) return "mode";
		return null;
	} catch (err) {
		return err?.code === "ENOENT" ? "absent" : "missing";
	}
}

/**
 * A directory the plugin keeps private state in, made 0700 when missing and accepted only as
 * `checkedDir` accepts one. Null when it is accepted, else the fixed reason it is refused.
 */
export function privateDir(path, { uid, fs = REAL_FS }) {
	try {
		fs.mkdirSync(path, { recursive: true, mode: 0o700 });
	} catch {
		return "missing";
	}
	const refused = checkedDir(path, { uid, fs });
	return refused === "absent" ? "missing" : refused;
}

/**
 * `<home>/.local/state/usertrust/<name>`, both its levels checked: `{ dir }` or
 * `{ refused }`. The home is taken by its real path, so a home the system reaches through a
 * symlink (as Fedora Atomic's /home → /var/home) is followed; below it, no component may be a
 * symlink. `create`: make both levels when missing (`privateDir`); otherwise only check them,
 * and `refused` is `absent` when either is not there yet.
 */
export function stateSubdir(home, name, { uid, fs = REAL_FS, create = true }) {
	let base;
	try {
		base = fs.realpathSync(home);
	} catch {
		return { refused: "home" };
	}
	const state = join(base, ...PRIVATE_STATE);
	const dir = join(state, name);
	const check = create ? privateDir : checkedDir;
	const refused = check(state, { uid, fs }) ?? check(dir, { uid, fs });
	return refused === null ? { dir } : { refused };
}
