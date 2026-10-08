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
import { GLOBAL_FLAGS, JSON_FLAG } from "./flags.js";

/**
 * Untrusted text (argv, a resolved path) echoed at a terminal. Replaces C0, DEL and C1 with `?`.
 * C1 is covered because it holds the 8-bit CSI/OSC introducers. NOT clipped: a clipped path is
 * not the path that was verified, and printing the subject of a verdict is the point.
 */
export function scrubForTerminal(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character strip is a terminal-injection defense
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

/**
 * `JSON.stringify` for a record that carries an untrusted string: C0 is already escaped by
 * `JSON.stringify`, and C1 is escaped here AFTER serialization as `\uXXXX`, so the field still
 * parses back to the real path. Substituting would corrupt a machine-readable value.
 */
export function toSafeJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
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
