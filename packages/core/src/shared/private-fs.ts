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
 * Creates it 0700 when `create` is set and it is absent. An existing one with any group or
 * other bit (a vault an earlier version created 0755, say) is tightened to 0700: the directory
 * is usertrust's own, and closing it closes every file under it, whatever their own modes. A
 * vault that cannot be closed (another user owns it) is refused with the reason, never used
 * world-readable. The vault BASE, the directory the caller named, is never touched.
 *
 * A vault that is a SYMBOLIC LINK is never changed through the link: its target may be a
 * directory usertrust does not own. A target any other user can read is refused, naming the
 * link, the target, its mode and the `chmod` that fixes it; an owner-only target is used. A
 * dangling link, and a vault path that is not a directory (a regular file, say), are refused by
 * name here, rather than left for the first writer to fail on with a bare ENOENT or ENOTDIR.
 *
 * The tightening itself never follows a link either. The directory is opened with
 * `O_NOFOLLOW | O_DIRECTORY` and changed with `fchmod` on that descriptor, after checking it is
 * the directory `lstat` saw (same device and inode): a link swapped in after the check fails the
 * open, and a different directory renamed into place fails the inode check. Both are refused.
 */
export function securePrivateVault(vaultDir: string, opts?: { create?: boolean }): void {
	let st: Stats;
	try {
		st = lstatSync(vaultDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		if (opts?.create === true) mkdirPrivate(vaultDir);
		return;
	}

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
		const targetMode = targetStat.mode;
		if ((targetMode & 0o077) === 0) return;
		throw new Error(
			`usertrust: the vault ${vaultDir} is a symbolic link to ${target}, which other users can read (mode ${octal(targetMode)}). usertrust does not change a directory through a link; make it owner-only with: chmod 700 ${target}`,
		);
	}

	if (!st.isDirectory()) throw notADirectory(vaultDir, st);
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
 * absent, or not one this check can read (the command that opens it reports that itself). It
 * NEVER changes a mode: the CLI commands that open an existing vault without starting a governor
 * warn with it and proceed. Only a governor and `usertrust init` tighten a vault
 * ({@link securePrivateVault}). For a symbolic link it names the target, its mode and the fix.
 */
export function looseVaultWarning(vaultDir: string): string | undefined {
	try {
		const st = lstatSync(vaultDir);
		if (st.isSymbolicLink()) {
			const target = realpathSync(vaultDir);
			const targetStat = statSync(target);
			if (!targetStat.isDirectory() || (targetStat.mode & 0o077) === 0) return undefined;
			return `usertrust: warning: the vault ${vaultDir} is a symbolic link to ${target}, which is readable by other users (mode ${octal(targetStat.mode)}); make it owner-only with: chmod 700 ${target}`;
		}
		if (!st.isDirectory() || (st.mode & 0o077) === 0) return undefined;
		return `usertrust: warning: the vault ${vaultDir} is readable by other users (mode ${octal(st.mode)}); make it owner-only with: chmod 700 ${vaultDir}`;
	} catch {
		return undefined;
	}
}
