// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The vault verdict that `usertrust verify` and `usertrust report` BOTH print: integrity AND completeness, on the live vault.
 *
 * Integrity (`verifyVaultReading`) walks the chain link by link; completeness reads the writer's dead-letter queue against the
 * events it just walked, because a chain with an event missing still verifies link by link. They are one function so that no
 * second reader can hold less than the verifier reads: the weekly report once copied the vault into a snapshot and judged the
 * copy, and the copy diverged from `verify` five times (a missing dead letter, a failed copy, a directory where a sidecar
 * belongs, a dangling segment, a queue drained between two reads). The report now prints this verdict verbatim and makes no
 * integrity claim of its own.
 *
 * ONE READ PER VERDICT: the events returned are the ones the verifier walked, and the dead letters are judged against THOSE,
 * never against the log read again.
 */

import {
	type ChainDeadLetters,
	type ChainDeadLettersUnreadable,
	describeMissingEvents,
	readChainDeadLetters,
} from "./dead-letters.js";
import type { PersistedAuditEvent } from "./read.js";
import { type VaultReading, verifyVaultReading } from "./verify.js";

/** The dead-letter queue read against `events`, the events a verification just walked. */
export function deadLettersAgainst(
	vaultDir: string,
	events: readonly PersistedAuditEvent[],
): ChainDeadLetters | ChainDeadLettersUnreadable {
	let byHash: Map<string, PersistedAuditEvent> | undefined;
	return readChainDeadLetters(vaultDir, (hash) => {
		byHash ??= new Map(events.map((e) => [e.hash, e]));
		return byHash.get(hash);
	});
}

export interface CompleteVerification {
	/** The verifier's own reading: its verdict and the events it walked. */
	reading: VaultReading;
	/**
	 * The dead-letter queue, judged against those events. `null` when there was no snapshot (`busy`):
	 * nothing is judged against a chain nobody read (a chain of no events, which every dead letter
	 * would call missing).
	 */
	deadLetters: ChainDeadLetters | ChainDeadLettersUnreadable | null;
	/** No chain event is missing from the chain, and the queue could be read (false when `busy`: unknown). */
	complete: boolean;
	/** The chain verifies AND it is complete. */
	valid: boolean;
	/** The verifier's errors, then the incompleteness lines worded as `usertrust verify` words them. */
	errors: string[];
}

/** The incompleteness lines for a queue, empty when the vault is complete. */
export function incompletenessErrors(d: ChainDeadLetters | ChainDeadLettersUnreadable): string[] {
	if ("unreadable" in d) {
		return [
			`INCOMPLETE?: the dead-letter queue ${d.path} could not be read (${d.unreadable}), so whether audit events are missing from the chain is unknown`,
		];
	}
	return d.missing > 0 ? [`INCOMPLETE: ${describeMissingEvents(d)}`] : [];
}

/** Verify the vault (the `.usertrust` directory) for integrity and completeness. Reads only; writes nothing. */
export function verifyVaultComplete(vaultDir: string): CompleteVerification {
	const reading = verifyVaultReading(vaultDir);
	if (reading.result.busy === true) {
		return {
			reading,
			deadLetters: null,
			complete: false,
			valid: false,
			errors: reading.result.errors,
		};
	}
	const deadLetters = deadLettersAgainst(vaultDir, reading.events);
	const extra = incompletenessErrors(deadLetters);
	const complete = extra.length === 0;
	return {
		reading,
		deadLetters,
		complete,
		valid: reading.result.valid && complete,
		errors: [...reading.result.errors, ...extra],
	};
}
