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

import {
	closeSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readlinkSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** Mode of every directory usertrust creates in a vault. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode of every file usertrust creates in a vault. */
export const PRIVATE_FILE_MODE = 0o600;

/** `mkdir -p` whose every newly created directory is owner-only. */
export function mkdirPrivate(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Creates a vault directory EXCLUSIVELY: its parents with `mkdir -p` (each one created is
 * owner-only), the vault itself with a non-recursive mkdir. A directory someone else creates
 * there first makes ours fail EEXIST rather than being adopted silently; EEXIST is carried on
 * from, because what is there is then checked like any existing vault.
 */
function mkdirVault(vaultDir: string): void {
	mkdirPrivate(dirname(vaultDir));
	try {
		mkdirSync(vaultDir, { mode: PRIVATE_DIR_MODE });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
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
 * user owns is used. A dangling link, and a vault path that is not a directory (a regular file,
 * say), are refused by name here, rather than left for the first writer to fail on with a bare
 * ENOENT or ENOTDIR.
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
		let target: string;
		let targetStat: Stats;
		try {
			target = realpathSync(vaultDir);
			targetStat = statSync(target);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			// A dangling link: named here, where every writer would fail later with a bare ENOENT.
			const missing = resolve(dirname(vaultDir), readlinkSync(vaultDir));
			throw new Error(
				`usertrust: the vault ${vaultDir} is a symbolic link to ${missing}, which does not exist; remove the link or create the target owner-only (mkdir -m 700 ${missing})`,
			);
		}
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
			const target = realpathSync(vaultDir);
			const targetStat = statSync(target);
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
