#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { GLOBAL_FLAGS, JSON_FLAG, RECONFIGURE_FLAG, SKIP_VERIFY_FLAG } from "./flags.js";
import { scrubForTerminal } from "./target.js";

const COMMANDS = [
	"init",
	"inspect",
	"health",
	"policy",
	"verify",
	"export",
	"anchor",
	"snapshot",
	"tb",
	"pricing",
	"budget",
	"completions",
	"secret",
	"skill",
	"ui",
] as const;

const argv = process.argv.slice(2);
const jsonFlag = argv.includes(JSON_FLAG);
const skipVerify = argv.includes(SKIP_VERIFY_FLAG);
const reconfigure = argv.includes(RECONFIGURE_FLAG);
const positional = argv.filter((a) => !GLOBAL_FLAGS.includes(a));
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

export { COMMANDS, levenshtein, suggestCommand };

/**
 * A command that takes no path must refuse one, not ignore it: ignoring it answers about the cwd's
 * vault while reading as an answer about the one the operator named. `valueFlags` are flags whose
 * next argument is their value, not a positional.
 */
async function refusedStray(cmd: string, valueFlags?: readonly string[]): Promise<boolean> {
	const { refuseStrayPositional } = await import("./target.js");
	return refuseStrayPositional(cmd, argv.slice(argv.indexOf(cmd) + 1), jsonFlag, valueFlags);
}

switch (command) {
	case "init":
		if (await refusedStray("init")) break;
		await import("./init.js").then((m) =>
			m.run(undefined, { json: jsonFlag, skipVerify, reconfigure }),
		);
		break;
	case "inspect":
		if (await refusedStray("inspect")) break;
		await import("./inspect.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "health":
		if (await refusedStray("health")) break;
		await import("./health.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "policy": {
		const rest = argv.slice(argv.indexOf("policy") + 1).filter((a) => a !== JSON_FLAG);
		await import("./policy.js").then((m) => m.run(undefined, { json: jsonFlag }, rest));
		break;
	}
	case "verify":
		// The arguments after `verify` go to verify.ts, which owns which of them is a flag value
		// and which is the path. Dropping them here is how `verify <path>` verified the cwd.
		await import("./verify.js").then((m) =>
			m.run(undefined, { json: jsonFlag }, argv.slice(argv.indexOf("verify") + 1)),
		);
		break;
	case "export": {
		if (await refusedStray("export", ["--markdown"])) break;
		const rest = argv.slice(argv.indexOf("export") + 1).filter((a) => a !== JSON_FLAG);
		await import("./export.js").then((m) => m.run(undefined, { json: jsonFlag }, rest));
		break;
	}
	case "anchor":
		await import("./anchor.js").then((m) => m.run(positional.slice(1), { json: jsonFlag }));
		break;
	case "snapshot":
		await import("./snapshot.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "tb":
		await import("./tb.js").then((m) => m.run({ json: jsonFlag }));
		break;
	case "pricing":
		if (await refusedStray("pricing")) break;
		await import("./pricing.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "budget": {
		// Forwarded verbatim (global flags included) — budget.js accepts them.
		const rest = argv.slice(argv.indexOf("budget") + 1);
		await import("./budget.js").then((m) => m.run(undefined, { json: jsonFlag }, rest));
		break;
	}
	case "completions":
		await import("./completions.js").then((m) => m.run(positional[1], { json: jsonFlag }));
		break;
	case "secret":
		await import("./secret.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "skill":
		await import("./skill.js").then((m) => m.run(undefined, { json: jsonFlag }));
		break;
	case "ui": {
		const rest = argv.slice(argv.indexOf("ui") + 1).filter((a) => a !== JSON_FLAG);
		await import("./ui.js").then((m) => m.run(undefined, { json: jsonFlag }, rest));
		break;
	}
	default: {
		if (command && !command.startsWith("-")) {
			const suggestion = suggestCommand(command);
			if (suggestion) {
				console.log(`Unknown command: "${scrubForTerminal(command)}"`);
				console.log(`Did you mean "${suggestion}"?`);
				break;
			}
		}
		console.log(`Usage: usertrust <command>

Commands:
  init          Initialize trust vault
  inspect       Show trust bank statement
  health        Show entropy diagnostics
  policy        Validate the policy file before it has to matter
  verify        Verify audit chain integrity
  export        Export receipts as markdown (Obsidian-ready)
  anchor        External audit anchoring (signed checkpoints)
  snapshot      Create/restore vault snapshots
  tb            Manage TigerBeetle process
  pricing       Show current rate configuration
  budget        Show a cost center's balance and runway
  completions   Output shell completion scripts
  secret        Manage vault credentials
  skill         Verify skill manifests
  ui            Open the visual ledger (local web UI)

Options:
  --json     Output machine-readable JSON`);
		break;
	}
}
