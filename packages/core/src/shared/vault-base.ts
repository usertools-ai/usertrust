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
import { join, parse, posix, sep, win32 } from "node:path";
import { escapeControls } from "./escape-controls.js";

/** Separators a base may be written with: both on Windows, `/` elsewhere. */
const SEPARATORS = process.platform === "win32" ? /[\\/]/ : /\//;

/**
 * `base` made absolute WITHOUT folding anything: concatenated with the working directory, never
 * `path.resolve`d. On Windows a drive-relative base (`C:tenant\..\vault`) is not absolute, and is
 * relative to THAT drive's working directory, which `win32.resolve("C:")` names without touching
 * the tail; prefixing `process.cwd()` gave `D:\work\C:tenant\..\vault`. The platform and the
 * drive lookup are parameters so the Windows reading can be tested on any system.
 */
export function absoluteVaultBase(
	base: string,
	platform: NodeJS.Platform = process.platform,
	driveCwd: (drive: string) => string = (drive) => win32.resolve(drive),
	cwd?: string,
): string {
	const path = platform === "win32" ? win32 : posix;
	if (path.isAbsolute(base)) return base;
	const drive = platform === "win32" ? /^[A-Za-z]:/.exec(base)?.[0] : undefined;
	if (drive !== undefined) {
		// A drive whose working directory is its root (`C:\`) must not give `C:\\tenant`.
		return `${driveCwd(drive).replace(/[\\/]+$/, "")}${path.sep}${base.slice(drive.length)}`;
	}
	// A working directory that is the root (`/`, or `C:\`) must not give `//vault`: a leading
	// `//` is a UNC-style root on Windows, and a different spelling than the kernel's for the
	// same directory.
	// Only the PLATFORM's separators: on POSIX a trailing backslash is part of a directory's name.
	const trailing = platform === "win32" ? /[\\/]+$/ : /\/+$/;
	// Read only here: an absolute base (above) never needed the working directory, and must still
	// work from a deleted one, where process.cwd() throws.
	return `${(cwd ?? process.cwd()).replace(trailing, "")}${path.sep}${base}`;
}

/**
 * `base` as the kernel resolves it, or `base` itself when no segment is `..`. Made absolute by
 * {@link absoluteVaultBase} (never `path.resolve`), then:
 *
 * - the deepest EXISTING prefix is resolved with realpath(3) and the rest appended, `.` dropped;
 * - a `..` in the part that does not exist yet is refused by name: the kernel cannot resolve
 *   `..` through a directory that is not there, so no path could be promised;
 * - where realpath(3) does not work at all (it fails on the root), a `..` base is refused by
 *   name. It never falls back to JS `realpathSync`, which folds `..` lexically.
 */
export function kernelVaultBase(base: string): string {
	const absolute = absoluteVaultBase(base);
	const segments = absolute.split(SEPARATORS);
	if (!segments.includes("..")) return base;

	const root = parse(absolute).root;
	try {
		realpathSync.native(root);
	} catch (err) {
		throw new Error(
			`usertrust: the vault base ${escapeControls(base)} contains "..", and this system cannot resolve paths the way the kernel does (realpath(3) failed: ${(err as NodeJS.ErrnoException).code}); give the base without ".." segments`,
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
			const { code, errno, syscall } = err as NodeJS.ErrnoException;
			if (code === "ENOENT" || code === "ENOTDIR") continue;
			// Node's message embeds the path verbatim, and so would `err` as the cause: an inspected
			// Error prints its cause. The cause keeps the errno and leaves the path out.
			throw new Error(
				`usertrust: cannot resolve the vault base ${escapeControls(base)} (realpath(3) failed: ${code}); fix the path, or give the base without ".." segments`,
				{ cause: Object.assign(new Error(String(code)), { code, errno, syscall }) },
			);
		}
		const tail = segments.slice(i).filter((s) => s !== "" && s !== ".");
		if (tail.includes("..")) {
			const missing = segments.slice(0, i + 1).join(sep);
			throw new Error(
				`usertrust: the vault base ${escapeControls(base)} has ".." after ${escapeControls(missing)}, which does not exist yet; create it first, or give the base without ".."`,
			);
		}
		return tail.length === 0 ? resolved : join(resolved, ...tail);
	}
	// Unreachable: the root resolved above.
	throw new Error(`usertrust: the vault base ${escapeControls(base)} could not be resolved`);
}

/**
 * {@link kernelVaultBase}, and when that changed the base, the mapping said once, on stderr, by
 * the governor being created: `usertrust: vault base "<as given>" resolves to "<real>"`. Both
 * paths are printed through {@link escapeControls}, as every refusal above names the base: a
 * directory name can carry a newline or an escape sequence.
 */
export function governorVaultBase(base: string): string {
	const resolved = kernelVaultBase(base);
	if (resolved !== base) {
		process.stderr.write(
			`usertrust: vault base "${escapeControls(base)}" resolves to "${escapeControls(resolved)}"\n`,
		);
	}
	return resolved;
}
