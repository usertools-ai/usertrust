// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Owner-only modes for everything usertrust creates in a vault.
 *
 * A vault holds audit trails, spend records and, with content capture on, prompts and tool
 * inputs. Every writer passes these modes explicitly at creation. A umask can only REMOVE bits,
 * so an explicit 0700 / 0600 is owner-only whatever the process umask; a writer that leaves the
 * mode to the default (0777 / 0666 masked by the umask) is world-readable under the common 022.
 * `mkdirSync(dir, { recursive: true, mode })` gives the mode to every directory it creates,
 * intermediates included, and leaves an existing directory as it is.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readlinkSync,
	realpathSync,
	renameSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** Mode of every directory usertrust creates in a vault. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode of every file usertrust creates in a vault. */
export const PRIVATE_FILE_MODE = 0o600;

/** `mkdir -p` whose every newly created directory is owner-only. */
export function mkdirPrivate(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Creates a vault directory EXCLUSIVELY, with a non-recursive mkdir. A directory someone else
 * creates there first makes ours fail EEXIST rather than being adopted silently; EEXIST is
 * carried on from, because what is there is then checked like any existing vault. The parents
 * are created (`mkdir -p`, each one created owner-only) only when that mkdir says one is
 * missing (ENOENT), then the vault is created exclusively once more. An existing vault never
 * touches its parent, so one under a parent this process cannot write to (a drive root, or a
 * permission model granting writes to the vault alone) still opens.
 */
function mkdirVault(vaultDir: string): void {
	const exclusive = (): NodeJS.ErrnoException | undefined => {
		try {
			mkdirSync(vaultDir, { mode: PRIVATE_DIR_MODE });
			return undefined;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
			return err as NodeJS.ErrnoException;
		}
	};
	let err = exclusive();
	if (err?.code === "ENOENT") {
		mkdirPrivate(dirname(vaultDir));
		err = exclusive();
	}
	if (err !== undefined) throw err;
}

const octal = (mode: number): string => (mode & 0o777).toString(8);

/** What a non-directory is, in words. */
function kindOf(st: Stats): string {
	if (st.isFile()) return "a regular file";
	if (st.isFIFO()) return "a FIFO";
	if (st.isSocket()) return "a socket";
	if (st.isCharacterDevice()) return "a character device";
	if (st.isBlockDevice()) return "a block device";
	return "an unknown kind of file";
}

/**
 * On Windows a vault's access is its ACL, which POSIX modes and owners do not describe: usertrust
 * neither sets nor checks them there (see LIMITATIONS.md). The platform is checked explicitly;
 * `process.geteuid` is absent on Windows too, but its absence alone is not relied on.
 */
const isWindows = (): boolean => process.platform === "win32";

/**
 * The EFFECTIVE uid, the one the kernel checks every open and chmod against: a setuid or
 * privilege-dropping process acts as its euid, not its real uid. `undefined` where there is none.
 */
const effectiveUid = (): number | undefined => process.geteuid?.();

/**
 * Why a vault another user owns is not used. A mode does not prove whose the vault is: another
 * local user can create `.usertrust` 0700 first, and as its owner replace the files we write in it.
 */
function foreignOwner(vaultDir: string, owner: number, euid: number, target?: string): string {
	const what =
		target === undefined
			? `${vaultDir} is owned by uid ${owner}`
			: `${vaultDir} is a symbolic link to ${target}, which is owned by uid ${owner}`;
	return `the vault ${what}, not by this process (uid ${euid}); usertrust only uses a vault its own user owns. Run as uid ${owner}, or give it to this user with: chown ${euid} ${target ?? vaultDir}`;
}

const foreignVault = (...args: Parameters<typeof foreignOwner>): Error =>
	new Error(`usertrust: ${foreignOwner(...args)}`);

/**
 * The directory a vault LINK leads to, exactly as the OS opens it for every writer: opened
 * following the link and `fstat`ed. No decision about a linked vault is made from a resolved
 * path. JS `realpathSync` joins a link's target with `path.resolve`, which collapses `..`
 * LEXICALLY: with `.usertrust -> /a/link/../vault` and `/a/link -> /b/sub`, it names /a/vault
 * while the OS opens /b/vault. Throws ENOENT for a dangling link, ENOTDIR for a target that is
 * not a directory (`O_DIRECTORY`, so a FIFO target never blocks the open).
 */
function statThroughLink(vaultDir: string): Stats {
	const fd = openSync(vaultDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
	try {
		return fstatSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * A link's target as written, joined to the link's directory WITHOUT normalizing `..`, so a
 * shell given it resolves it as the OS does. For messages only.
 */
function linkText(vaultDir: string): string {
	const raw = readlinkSync(vaultDir);
	return isAbsolute(raw) ? raw : `${dirname(vaultDir)}${sep}${raw}`;
}

/** Where a link leads, for messages only: the kernel's realpath(3), else the link as written. */
function linkTarget(vaultDir: string): string {
	try {
		return realpathSync.native(vaultDir);
	} catch {
		return linkText(vaultDir);
	}
}

/** A vault path that holds something other than a directory: every writer would fail ENOTDIR. */
function notADirectory(vaultDir: string, st: Stats, target?: string): Error {
	const what =
		target === undefined
			? `is ${kindOf(st)}`
			: `is a symbolic link to ${target}, which is ${kindOf(st)}`;
	return new Error(
		`usertrust: the vault ${vaultDir} ${what}, not a directory; move it aside and the vault is created owner-only`,
	);
}

/**
 * Close a vault directory (`<vaultBase>/.usertrust`) to every user but its owner.
 *
 * With `create`, the vault is created first, EXCLUSIVELY (see {@link mkdirVault}), and then put
 * through every check below like any existing vault: a directory another user created first, in
 * a shared parent such as /tmp, is refused by the owner check rather than adopted. Without
 * `create`, an absent vault is left absent. An existing one with any group or
 * other bit (a vault an earlier version created 0755, say) is tightened to 0700: the directory
 * is usertrust's own, and closing it closes every file under it, whatever their own modes. A
 * vault that cannot be closed is refused with the reason, never used world-readable. The vault
 * BASE, the directory the caller named, is never touched.
 *
 * A vault ANOTHER USER OWNS is refused, whatever its mode, before anything about it is accepted or
 * changed: its owner can replace the files written in it. The owner is compared with the
 * process's effective uid, and a foreign directory is never chmod'ed or chown'ed, even by root.
 * On Windows no mode or owner is set or checked (see {@link isWindows}).
 *
 * A vault that is a SYMBOLIC LINK is never changed through the link: its target may be a
 * directory usertrust does not own. A target any other user can read is refused, naming the
 * link, the target, its mode and the `chmod` that fixes it; an owner-only target this process's
 * user owns is used; one this process cannot open is refused by name. The target judged is the
 * directory the OS opens through the link (see {@link statThroughLink}), never a path resolved
 * in JS. A dangling link, and a vault path that is not a directory (a regular file, say), are
 * refused by name here, rather than left for the first writer to fail on with a bare ENOENT or
 * ENOTDIR.
 *
 * The tightening itself never follows a link either. The directory is opened with
 * `O_NOFOLLOW | O_DIRECTORY` and changed with `fchmod` on that descriptor, after checking it is
 * the directory `lstat` saw (same device and inode): a link swapped in after the check fails the
 * open, and a different directory renamed into place fails the inode check. Both are refused.
 */
export function securePrivateVault(vaultDir: string, opts?: { create?: boolean }): void {
	const create = opts?.create === true;
	if (create) mkdirVault(vaultDir);
	let st: Stats;
	try {
		st = lstatSync(vaultDir);
	} catch (err) {
		// Absent: nothing to check, unless it was just created (then it vanished: say so).
		if (create || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return;
	}

	const euid = effectiveUid();
	if (st.isSymbolicLink()) {
		let targetStat: Stats;
		try {
			// Windows opens no directory as a file; there only the kind is checked, by a stat the
			// OS resolves (never a JS realpath).
			targetStat = isWindows() ? statSync(vaultDir) : statThroughLink(vaultDir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				// A dangling link: named here, where every writer would fail later with a bare ENOENT.
				const missing = linkText(vaultDir);
				throw new Error(
					`usertrust: the vault ${vaultDir} is a symbolic link to ${missing}, which does not exist; remove the link or create the target owner-only (mkdir -m 700 ${missing})`,
				);
			}
			if (code === "EACCES" || code === "EPERM") {
				// Named here too: a target this process may not open is not judged, and would leave
				// every writer with a bare EACCES.
				throw new Error(
					`usertrust: the vault ${vaultDir} is a symbolic link to ${linkTarget(vaultDir)}, which this process cannot open (${code}); give this user read and search permission on it, or point the link elsewhere`,
				);
			}
			if (code !== "ENOTDIR") throw err;
			// The kind, for the message only: what the link leads to is not a directory.
			let kind: Stats | undefined;
			try {
				kind = statSync(vaultDir);
			} catch {
				/* a component on the way is not a directory either */
			}
			if (kind !== undefined && !kind.isDirectory()) {
				throw notADirectory(vaultDir, kind, linkTarget(vaultDir));
			}
			throw new Error(
				`usertrust: the vault ${vaultDir} is a symbolic link to ${linkText(vaultDir)}, which does not lead to a directory; move it aside and the vault is created owner-only`,
			);
		}
		const target = linkTarget(vaultDir);
		if (!targetStat.isDirectory()) throw notADirectory(vaultDir, targetStat, target);
		if (isWindows()) return;
		if (euid !== undefined && targetStat.uid !== euid) {
			throw foreignVault(vaultDir, targetStat.uid, euid, target);
		}
		const targetMode = targetStat.mode;
		if ((targetMode & 0o077) === 0) return;
		throw new Error(
			`usertrust: the vault ${vaultDir} is a symbolic link to ${target}, which other users can read (mode ${octal(targetMode)}). usertrust does not change a directory through a link; make it owner-only with: chmod 700 ${target}`,
		);
	}

	if (!st.isDirectory()) throw notADirectory(vaultDir, st);
	if (isWindows()) return;
	if (euid !== undefined && st.uid !== euid) throw foreignVault(vaultDir, st.uid, euid);
	if ((st.mode & 0o077) === 0) return;
	const refuse = (reason: string): Error =>
		new Error(
			`usertrust: the vault ${vaultDir} is readable by other users (mode ${octal(st.mode)}) and could not be made owner-only: ${reason}`,
		);
	let fd: number;
	try {
		fd = openSync(
			vaultDir,
			fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
		);
	} catch (err) {
		throw refuse((err as Error).message);
	}
	try {
		const opened = fstatSync(fd);
		if (opened.dev !== st.dev || opened.ino !== st.ino) {
			throw refuse("it was replaced while being checked");
		}
		if (euid !== undefined && opened.uid !== euid) throw foreignVault(vaultDir, opened.uid, euid);
		try {
			fchmodSync(fd, PRIVATE_DIR_MODE);
		} catch (err) {
			throw refuse((err as Error).message);
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * The warning for a vault directory other users can read, or `undefined` when it is owner-only,
 * absent, or not one this check can read (the command that opens it reports that itself), and
 * always `undefined` on Windows (see {@link isWindows}). A vault another user owns gets the owner
 * warning instead, naming the owner and this process's effective uid. It NEVER changes a mode or
 * an owner: the CLI commands that open an existing vault without starting a governor warn with it
 * and proceed. Only a governor and `usertrust init` tighten a vault
 * ({@link securePrivateVault}). For a symbolic link it names the target, its mode and the fix.
 */
export function looseVaultWarning(vaultDir: string): string | undefined {
	if (isWindows()) return undefined;
	const euid = effectiveUid();
	const foreign = (owner: number, target?: string): string | undefined =>
		euid === undefined || owner === euid
			? undefined
			: `usertrust: warning: ${foreignOwner(vaultDir, owner, euid, target)}`;
	try {
		const st = lstatSync(vaultDir);
		if (st.isSymbolicLink()) {
			// What the OS opens through the link is what is judged; the path is for the message.
			const targetStat = statThroughLink(vaultDir);
			const target = linkTarget(vaultDir);
			if (!targetStat.isDirectory()) return undefined;
			const owner = foreign(targetStat.uid, target);
			if (owner !== undefined) return owner;
			if ((targetStat.mode & 0o077) === 0) return undefined;
			return `usertrust: warning: the vault ${vaultDir} is a symbolic link to ${target}, which is readable by other users (mode ${octal(targetStat.mode)}); make it owner-only with: chmod 700 ${target}`;
		}
		if (!st.isDirectory()) return undefined;
		const owner = foreign(st.uid);
		if (owner !== undefined) return owner;
		if ((st.mode & 0o077) === 0) return undefined;
		return `usertrust: warning: the vault ${vaultDir} is readable by other users (mode ${octal(st.mode)}); make it owner-only with: chmod 700 ${vaultDir}`;
	} catch {
		return undefined;
	}
}

// ── Owner-only atomic replace ──

/**
 * Replace `path` with `data` in a file that is owner-only from the moment it exists, never by
 * writing into the file already there. A mode given to an in-place write applies only when the
 * file is CREATED: rewriting an existing 0644 file leaves it 0644 with the new bytes in it.
 *
 * The bytes go into a temp file beside `path` (`<name>.<uuid>.tmp`), created EXCLUSIVELY and not
 * through a link (`O_CREAT|O_EXCL|O_NOFOLLOW`) with {@link PRIVATE_FILE_MODE}, then fchmod'd to
 * exactly that mode whatever the umask, written in full, fsync'd and closed; then renamed over
 * `path`, and the directory fsync'd so the rename survives a crash. The rename replaces `path` as
 * a directory entry: the old file's inode is never written, and a symbolic link at `path` is
 * replaced, not followed.
 *
 * Every step BEFORE the rename throws on failure, and the temp file is removed. The directory
 * sync AFTER it (skipped on Windows, where a directory handle cannot be flushed) never throws,
 * whatever the error: by then `path` IS replaced and owner-only, and a throw would report a
 * failure for a write that took effect. Its failure is reported once, as
 * a warning ({@link dirSyncWarning}) passed to `warn` (default: stderr, as given; a CLI caller
 * passes one that scrubs the path for its terminal).
 */
export function writePrivateFileAtomic(
	path: string,
	data: string,
	warn: (message: string) => void = (message) => {
		process.stderr.write(`${message}\n`);
	},
): void {
	const tmp = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
	const fd = openSync(
		tmp,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
		PRIVATE_FILE_MODE,
	);
	try {
		try {
			fchmodSync(fd, PRIVATE_FILE_MODE);
			const bytes = Buffer.from(data, "utf-8");
			let off = 0;
			while (off < bytes.length) {
				const n = writeSync(fd, bytes, off, bytes.length - off);
				if (n <= 0) throw new Error(`write to ${tmp} made no progress`);
				off += n;
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// renamed, or never created
		}
		throw err;
	}
	// Make the rename durable: best effort for EVERY error, because the replace already happened.
	// Not on Windows: a read-only directory handle cannot be flushed there (EPERM on every run),
	// so the attempt could only ever produce a warning.
	if (isWindows()) return;
	let dfd: number | undefined;
	try {
		dfd = openSync(dirname(path), "r");
		fsyncSync(dfd);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		// A platform that cannot fsync a directory at all says nothing worth a warning. EPERM and
		// EBADF (which flushing a read-only directory handle can give on Windows) are warned, not
		// silenced: elsewhere they are real failures, and the warning still says the file was
		// replaced.
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EISDIR") {
			warn(dirSyncWarning(path, code ?? (err instanceof Error ? err.message : String(err))));
		}
	} finally {
		try {
			if (dfd !== undefined) closeSync(dfd);
		} catch {
			// the descriptor is gone either way
		}
	}
}

/**
 * The warning for a replace that landed but whose directory entry could not be synced. On
 * Windows it makes no owner-only claim: usertrust sets no permissions there (see {@link isWindows}).
 */
export function dirSyncWarning(path: string, reason: string): string {
	const replaced = isWindows()
		? `${path} was replaced`
		: `${path} was replaced and is owner-only (mode 600)`;
	return `usertrust: warning: ${replaced}, but its directory could not be synced (${reason}), so the new directory entry may not survive a power loss`;
}
