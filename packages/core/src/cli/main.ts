#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

const COMMANDS = [
	"init",
	"inspect",
	"health",
	"verify",
	"snapshot",
	"tb",
	"pricing",
	"completions",
] as const;

const argv = process.argv.slice(2);
const jsonFlag = argv.includes("--json");
const skipVerify = argv.includes("--skip-verify");
const reconfigure = argv.includes("--reconfigure");
const positional = argv.filter(
	(a) => a !== "--json" && a !== "--skip-verify" && a !== "--reconfigure",
);
const command = positional[0];

/** Simple Levenshtein distance — two-row DP, no dependency needed. */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;

	// Two-row approach avoids indexed-access non-null assertions
	let prev = new Uint32Array(n + 1);
	let curr = new Uint32Array(n + 1);

	for (let j = 0; j <= n; j++) prev[j] = j;

	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
		}
		[prev, curr] = [curr, prev];
	}

	return prev[n] ?? 0;
}

function suggestCommand(input: string): string | undefined {
	let best: string | undefined;
	let bestDist = Number.POSITIVE_INFINITY;

	for (const cmd of COMMANDS) {
		const dist = levenshtein(input, cmd);
		if (dist < bestDist) {
			bestDist = dist;
			best = cmd;
		}
	}

	// Only suggest if the distance is reasonable (max 3 edits)
	return bestDist <= 3 ? best : undefined;
}

export { levenshtein, suggestCommand, COMMANDS };

switch (command) {
	case "init":
		await import("./init.js").then((m) =>
			m.run(undefined, { json: jsonFlag, skipVerify, reconfigure }),
		);
		break;
	case "inspect":
		await import("./inspect.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "health":
		await import("./health.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "verify":
		await import("./verify.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "snapshot":
		await import("./snapshot.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "tb":
		await import("./tb.js").then((m) => m.run({ json: jsonFlag }));
		break;
	case "pricing":
		await import("./pricing.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "completions":
		await import("./completions.js").then((m) => m.run(positional[1], { json: jsonFlag }));
		break;
	default: {
		if (command && !command.startsWith("-")) {
			const suggestion = suggestCommand(command);
			if (suggestion) {
				console.log(`Unknown command: "${command}"`);
				console.log(`Did you mean "${suggestion}"?`);
				break;
			}
		}
		console.log(`Usage: usertrust <command>

Commands:
  init          Initialize trust vault
  inspect       Show trust bank statement
  health        Show entropy diagnostics
  verify        Verify audit chain integrity
  snapshot      Create/restore vault snapshots
  tb            Manage TigerBeetle process
  pricing       Show current rate configuration
  completions   Output shell completion scripts

Options:
  --json     Output machine-readable JSON`);
		break;
	}
}
