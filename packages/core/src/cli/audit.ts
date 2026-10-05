// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust audit quarantine-tail [--dry-run] [--json]` — move a TORN final line of the audit
 * log aside, recorded on the chain (see `audit/quarantine.ts`). The only repair the chain
 * admits; every other unverifiable state is refused and left for an operator.
 */

import pc from "picocolors";
import { AuditWriterLockHeldError } from "../audit/chain.js";
import { AuditQuarantineRefusedError, quarantineTornTail } from "../audit/quarantine.js";
import { scrubForError } from "../audit/verify.js";
import type { CliOptions } from "./init.js";

const USAGE = "usage: usertrust audit quarantine-tail [--dry-run] [--json]";

export async function run(
	rootDir: string | undefined,
	opts: CliOptions,
	args: string[],
): Promise<void> {
	const json = opts.json === true;
	const root = rootDir ?? process.cwd();
	const [sub, ...rest] = args;
	const unknown = rest.filter((a) => a !== "--dry-run");
	if (sub !== "quarantine-tail" || unknown.length > 0) {
		if (json)
			console.log(JSON.stringify({ command: "audit", success: false, data: { message: USAGE } }));
		else console.log(USAGE);
		process.exitCode = 1;
		return;
	}
	const dryRun = rest.includes("--dry-run");
	try {
		const r = await quarantineTornTail(root, { dryRun });
		if (json) {
			console.log(JSON.stringify({ command: "audit quarantine-tail", success: true, data: r }));
			return;
		}
		if (r.torn === null && r.recorded.length === 0) {
			console.log(pc.green("No torn tail: the audit log ends with a complete line."));
			return;
		}
		const verb = dryRun ? "Would quarantine" : "Quarantined";
		if (r.torn !== null) {
			console.log(
				`${verb} a torn tail: ${r.torn.length} byte(s) at offset ${r.torn.offset} → ${scrubForError(r.torn.file)} (sha256 ${scrubForError(r.torn.sha256)})`,
			);
		}
		const recVerb = dryRun ? "Would record" : "Recorded";
		// Vault-derived text is untrusted: scrubbed before it reaches the terminal (#196 r1 P2,
		// AGENTS.md "Untrusted text echoed to a terminal").
		for (const sha of r.recorded)
			console.log(`${recVerb} on the chain: quarantine/${scrubForError(sha)}.torn`);
	} catch (err) {
		const refused =
			err instanceof AuditQuarantineRefusedError || err instanceof AuditWriterLockHeldError;
		// Scrubbed for the TERMINAL only; the JSON output carries the exact text.
		const message = err instanceof Error ? err.message : String(err);
		const shown = scrubForError(message);
		if (json)
			console.log(
				JSON.stringify({ command: "audit quarantine-tail", success: false, data: { message } }),
			);
		else console.log(refused ? pc.red(shown) : shown);
		process.exitCode = 1;
	}
}
