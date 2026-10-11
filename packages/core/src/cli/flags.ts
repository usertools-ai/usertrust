// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Shared CLI flag parser — extracts typed flags + positional args from argv.
 *
 * Keeps the individual subcommand files thin by centralising repetitive
 * arg-slicing logic.
 */

/**
 * Flags `main.ts` accepts in front of EVERY command. The single definition: `main.ts` (what it
 * strips to find the command), `parseFlags` below, `target.ts` (what a path-less command may be
 * given), `verify.ts` and `budget.ts` (what their unknown-flag guards let through) all read it. A
 * fourth flag added here reaches all of them; one added anywhere else is refused by the rest.
 * `tests/cli/global-flags.test.ts` fails on a second spelling.
 */
export const JSON_FLAG = "--json";
export const SKIP_VERIFY_FLAG = "--skip-verify";
export const RECONFIGURE_FLAG = "--reconfigure";
export const GLOBAL_FLAGS: readonly string[] = [JSON_FLAG, SKIP_VERIFY_FLAG, RECONFIGURE_FLAG];

export interface ParsedFlags {
	json: boolean;
	skipVerify: boolean;
	reconfigure: boolean;
	positional: string[];
}

const KNOWN_FLAGS = new Set(GLOBAL_FLAGS);

export function parseFlags(argv: string[] = process.argv.slice(2)): ParsedFlags {
	const json = argv.includes(JSON_FLAG);
	const skipVerify = argv.includes(SKIP_VERIFY_FLAG);
	const reconfigure = argv.includes(RECONFIGURE_FLAG);
	const positional = argv.filter((a) => !KNOWN_FLAGS.has(a));

	return { json, skipVerify, reconfigure, positional };
}
