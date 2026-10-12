// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust audit quarantine-tail [--dry-run] [--json]` — move a TORN final line of the audit
 * log aside, recorded on the chain (see `audit/quarantine.ts`). The only repair the chain
 * admits; every other unverifiable state is refused and left for an operator.
 */

import { join } from "node:path";
import pc from "picocolors";
import { AuditWriterLockHeldError } from "../audit/chain.js";
import {
	AuditQuarantineInterruptedError,
	AuditQuarantineRefusedError,
	quarantineTornTail,
} from "../audit/quarantine.js";
import { VAULT_DIR } from "../shared/constants.js";
import { GLOBAL_FLAGS } from "./flags.js";
import type { CliOptions } from "./init.js";
import { scrubForTerminal, toSafeJson, warnIfVaultLoose } from "./target.js";

const USAGE = "usage: usertrust audit quarantine-tail [--dry-run] [--json]";

export async function run(
	rootDir: string | undefined,
	opts: CliOptions,
	args: string[],
): Promise<void> {
	const json = opts.json === true;
	const root = rootDir ?? process.cwd();
	warnIfVaultLoose(join(root, VAULT_DIR));
	// The global flags (`cli/flags.ts`, the one list) are accepted wherever main.ts forwards them;
	// anything else that is not this command's own is a malformed invocation: exit 2, as every CLI
	// command answers an argument of the wrong shape (AGENTS.md). Exit 1 is kept for operational
	// failures — a refusal, an interrupted repair.
	const [sub, ...rest] = args.filter((a) => !GLOBAL_FLAGS.includes(a));
	const unknown = rest.filter((a) => a !== "--dry-run");
	if (sub !== "quarantine-tail" || unknown.length > 0) {
		if (json)
			console.log(toSafeJson({ command: "audit", success: false, data: { message: USAGE } }));
		else console.log(USAGE);
		process.exitCode = 2;
		return;
	}
	const dryRun = rest.includes("--dry-run");
	try {
		const r = await quarantineTornTail(root, { dryRun });
		if (json) {
			console.log(toSafeJson({ command: "audit quarantine-tail", success: true, data: r }));
			return;
		}
		if (r.torn === null && r.recorded.length === 0 && r.anchorAdvanced !== true) {
			console.log(pc.green("No torn tail: the audit log ends with a complete line."));
			return;
		}
		const verb = dryRun ? "Would quarantine" : "Quarantined";
		if (r.torn !== null) {
			console.log(
				`${verb} a torn tail: ${r.torn.length} byte(s) at offset ${r.torn.offset} → ${scrubForTerminal(r.torn.file)} (sha256 ${scrubForTerminal(r.torn.sha256)})`,
			);
		}
		const recVerb = dryRun ? "Would record" : "Recorded";
		// Vault-derived text is untrusted: scrubbed before it reaches the terminal (AGENTS.md
		// "Untrusted text echoed to a terminal").
		for (const file of r.recorded)
			console.log(`${recVerb} on the chain: ${scrubForTerminal(file)}`);
		if (r.anchorAdvanced === true) {
			console.log(
				dryRun
					? "Would bring the .meta head anchor (one behind, or absent) to the verified head."
					: "Brought the .meta head anchor (one behind, or absent) to the verified head.",
			);
		}
	} catch (err) {
		const refused =
			err instanceof AuditQuarantineRefusedError ||
			err instanceof AuditQuarantineInterruptedError ||
			err instanceof AuditWriterLockHeldError;
		// Scrubbed for the TERMINAL only; the JSON output carries the exact text (C1 escaped).
		const message = err instanceof Error ? err.message : String(err);
		const shown = scrubForTerminal(message);
		if (json)
			console.log(
				toSafeJson({ command: "audit quarantine-tail", success: false, data: { message } }),
			);
		else console.log(refused ? pc.red(shown) : shown);
		process.exitCode = 1;
	}
}
