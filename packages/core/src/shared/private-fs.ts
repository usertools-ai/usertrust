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

import { chmodSync, mkdirSync, statSync } from "node:fs";

/** Mode of every directory usertrust creates in a vault. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode of every file usertrust creates in a vault. */
export const PRIVATE_FILE_MODE = 0o600;

/** `mkdir -p` whose every newly created directory is owner-only. */
export function mkdirPrivate(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Close a vault directory (`<vaultBase>/.usertrust`) to every user but its owner.
 *
 * Creates it 0700 when `create` is set and it is absent. An existing one with any group or
 * other bit (a vault an earlier version created 0755, say) is tightened to 0700: the directory
 * is usertrust's own, and closing it closes every file under it, whatever their own modes. A
 * vault that cannot be closed (another user owns it) is refused with the reason, never used
 * world-readable. The vault BASE, the directory the caller named, is never touched.
 */
export function securePrivateVault(vaultDir: string, opts?: { create?: boolean }): void {
	if (opts?.create === true) mkdirPrivate(vaultDir);
	let mode: number;
	try {
		mode = statSync(vaultDir).mode;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	if ((mode & 0o077) === 0) return;
	try {
		chmodSync(vaultDir, PRIVATE_DIR_MODE);
	} catch (err) {
		throw new Error(
			`usertrust: the vault ${vaultDir} is readable by other users (mode ${(mode & 0o777).toString(8)}) and could not be made owner-only: ${(err as Error).message}`,
		);
	}
}
