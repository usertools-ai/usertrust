// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Shared CLI flag parser — extracts typed flags + positional args from argv.
 *
 * Keeps the individual subcommand files thin by centralising repetitive
 * arg-slicing logic.
 */

export interface ParsedFlags {
	json: boolean;
	skipVerify: boolean;
	reconfigure: boolean;
	positional: string[];
}

const KNOWN_FLAGS = new Set(["--json", "--skip-verify", "--reconfigure"]);

export function parseFlags(argv: string[] = process.argv.slice(2)): ParsedFlags {
	const json = argv.includes("--json");
	const skipVerify = argv.includes("--skip-verify");
	const reconfigure = argv.includes("--reconfigure");
	const positional = argv.filter((a) => !KNOWN_FLAGS.has(a));

	return { json, skipVerify, reconfigure, positional };
}
