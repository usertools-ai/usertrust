// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The vault base, resolved where the KERNEL resolves it.
 *
 * Every vault path is `join(<vaultBase>, …)`, and `path.join` / `path.resolve` (and JS
 * `realpathSync`) fold `..` LEXICALLY: for a base `link/../vault` with `link -> x/y` they name
 * `<cwd>/vault`, while the kernel follows `link` first and opens `<cwd>/x/vault`. The checks
 * would then judge one directory and the writers write another. A base with a `..` segment is
 * therefore resolved by the operating system's own resolver, realpath(3) via
 * `realpathSync.native`; a base without one is kept exactly as given, since folding `.` and `//`
 * is what the kernel does too.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, parse, sep } from "node:path";

/** Separators a base may be written with: both on Windows, `/` elsewhere. */
const SEPARATORS = process.platform === "win32" ? /[\\/]/ : /\//;

/**
 * `base` as the kernel resolves it, or `base` itself when no segment is `..`. Made absolute by
 * concatenation with the working directory (never `path.resolve`), then:
 *
 * - the deepest EXISTING prefix is resolved with realpath(3) and the rest appended, `.` dropped;
 * - a `..` in the part that does not exist yet is refused by name: the kernel cannot resolve
 *   `..` through a directory that is not there, so no path could be promised;
 * - where realpath(3) does not work at all (it fails on the root), a `..` base is refused by
 *   name. It never falls back to JS `realpathSync`, which folds `..` lexically.
 */
export function kernelVaultBase(base: string): string {
	const absolute = isAbsolute(base) ? base : `${process.cwd()}${sep}${base}`;
	const segments = absolute.split(SEPARATORS);
	if (!segments.includes("..")) return base;

	const root = parse(absolute).root;
	try {
		realpathSync.native(root);
	} catch (err) {
		throw new Error(
			`usertrust: the vault base ${base} contains "..", and this system cannot resolve paths the way the kernel does (realpath(3) failed: ${(err as NodeJS.ErrnoException).code}); give the base without ".." segments`,
		);
	}

	// The longest prefix that exists, resolved by the kernel; segments[0] is the root's own
	// (empty, or a drive), so the walk ends at the root, which resolved above.
	for (let i = segments.length; i >= 1; i--) {
		const prefix = i === 1 ? root : segments.slice(0, i).join(sep);
		let resolved: string;
		try {
			resolved = realpathSync.native(prefix);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") continue;
			throw err;
		}
		const tail = segments.slice(i).filter((s) => s !== "" && s !== ".");
		if (tail.includes("..")) {
			const missing = segments.slice(0, i + 1).join(sep);
			throw new Error(
				`usertrust: the vault base ${base} has ".." after ${missing}, which does not exist yet; create it first, or give the base without ".."`,
			);
		}
		return tail.length === 0 ? resolved : join(resolved, ...tail);
	}
	// Unreachable: the root resolved above.
	throw new Error(`usertrust: the vault base ${base} could not be resolved`);
}

/**
 * {@link kernelVaultBase}, and when that changed the base, the mapping said once, on stderr, by
 * the governor being created: `usertrust: vault base "<as given>" resolves to "<real>"`.
 */
export function governorVaultBase(base: string): string {
	const resolved = kernelVaultBase(base);
	if (resolved !== base) {
		process.stderr.write(`usertrust: vault base "${base}" resolves to "${resolved}"\n`);
	}
	return resolved;
}
