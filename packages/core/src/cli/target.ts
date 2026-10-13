// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Which vault a CLI command is about, and what it does with an argument it has no use for.
 *
 * A command that answers about the wrong vault is worse than one that fails: the output reads as a
 * verdict. `verify <path>` once dropped its path and certified the cwd's chain as the answer for
 * it. The rule here, for every command: an argument is either used or refused, never ignored.
 *
 * Exit codes: a path that cannot be used (missing, not a directory, no vault in it) exits 1, like
 * "No trust vault found" always has. An argument of the wrong SHAPE (a path where none is taken,
 * two paths where one is) exits 2.
 */

import pc from "picocolors";
import { looseVaultWarning } from "../shared/private-fs.js";
import { GLOBAL_FLAGS, JSON_FLAG } from "./flags.js";

/**
 * Untrusted text (argv, a resolved path) echoed at a terminal. Replaces C0, DEL, C1 and Unicode
 * format characters (`\p{Cf}`) with `?`. C1 is covered because it holds the 8-bit CSI/OSC
 * introducers; `Cf` because bidi overrides and isolates (U+202E, U+2066..2069) and zero-width
 * characters reorder or hide the text around them, which can disguise a verdict line. Same set
 * `usertrust-verify`'s `forDisplay` strips. NOT clipped: a clipped path is
 * not the path that was verified, and printing the subject of a verdict is the point.
 */
export function scrubForTerminal(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character strip is a terminal-injection defense
	return text.replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, "?");
}

/**
 * Warn on stderr, and proceed, when the vault a command opens is readable by other users. It never
 * changes a mode (see `looseVaultWarning`): only a governor and `usertrust init` tighten a vault.
 */
export function warnIfVaultLoose(vaultDir: string): void {
	const warning = looseVaultWarning(vaultDir);
	if (warning !== undefined) process.stderr.write(`${scrubForTerminal(warning)}\n`);
}

/**
 * `JSON.stringify` for a record that carries an untrusted string: C0 is already escaped by
 * `JSON.stringify`, and C1 plus Unicode format characters (`\p{Cf}`: bidi overrides, zero-width) are
 * escaped here AFTER serialization as `\uXXXX`, so the field still parses back to the real path. Substituting would corrupt a machine-readable value.
 */
export function toSafeJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\p{Cf}]/gu,
		// One `\uXXXX` per UTF-16 unit: some `Cf` members (the tag characters U+E0001..E007F) are
		// supplementary-plane, so the match is a surrogate PAIR, and a 5-hex-digit code point escape
		// is not valid JSON.
		(c) =>
			Array.from(
				{ length: c.length },
				(_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`,
			).join(""),
	);
}

/**
 * Refuse an argument a path-less command has no use for. Returns true if it refused (the caller
 * must then do nothing else); the exit code is set here.
 *
 * `args` are the arguments AFTER the command word. A positional is refused ("takes no path"), and
 * so is any dash token that is neither a global flag nor one of `valueFlags` (the command's own
 * flags, each taking the next argument as its value): there are no short flags, and skipping an
 * unknown dash token as "probably a flag" is how `-vault` slipped past.
 */
export function refuseStrayPositional(
	command: string,
	args: string[],
	json: boolean,
	valueFlags: readonly string[] = [],
): boolean {
	let message: string | undefined;
	// `--json` is global and main.ts removes it before dispatch, so it must not be taken as the
	// value of a preceding value flag (`export --markdown --json out`) here either.
	const rest = args.filter((a) => a !== JSON_FLAG);
	for (let i = 0; i < rest.length && message === undefined; i++) {
		const a = rest[i] as string;
		if (valueFlags.includes(a)) {
			i++;
		} else if (a.startsWith("-")) {
			if (!GLOBAL_FLAGS.includes(a)) {
				message = `\`usertrust ${command}\` has no option "${scrubForTerminal(a)}".`;
			}
		} else {
			message = `\`usertrust ${command}\` takes no path (got "${scrubForTerminal(a)}"). It reports on the vault in the current directory; run it from there.`;
		}
	}
	if (message === undefined) return false;
	if (json) {
		console.log(JSON.stringify({ command, success: false, data: { message } }));
	} else {
		console.log(pc.red(message));
	}
	process.exitCode = 2;
	return true;
}
