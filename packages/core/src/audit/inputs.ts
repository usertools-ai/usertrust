// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The inputs the verifier reads from a vault directory (the `.usertrust` directory): THE one list.
 *
 * Anything that makes a claim about a vault's integrity without being the verifier (the weekly report copies the vault into
 * a snapshot and judges the copy) must hold exactly these inputs, no fewer. A snapshot that holds less than `verify` reads
 * reports VERIFIED over a vault that verify FAILS, and that divergence was reached three times by patching one case at a
 * time (a missing dead letter, a failed copy, a directory where a sidecar belongs). Listing the inputs once, with the kind
 * each must be, replaces the per-case rules: an input that exists but is not a regular file is a problem whatever it is.
 *
 * `tests/audit/inputs-conformance.test.ts` runs the verifier over a sample vault with its file reads recorded and fails if
 * the set it read is not exactly this list, so a read added to the verifier outside the list turns CI red.
 *
 * Pure: it names inputs from a directory listing and touches no file.
 */

/** The main audit log, written by the single writer. */
export const MAIN_LOG = "events.jsonl";

/** The dead-letter queue, relative to the vault directory. */
export const DEAD_LETTER_QUEUE = "dlq/dead-letters.jsonl";

/** One input the verifier reads, by path relative to the vault directory. Every input must be a REGULAR FILE. */
export interface VaultInput {
	/** Path relative to the vault directory, `/`-joined. */
	readonly rel: string;
	/** `log`: a hash-chain log or segment. `anchor`: the main log's `.meta` sidecar. `queue`: the dead-letter queue. */
	readonly role: "log" | "anchor" | "queue";
}

/**
 * The inputs for a vault whose `audit/` directory lists `auditListing`: the main log and its `.meta` sidecar (named whether
 * or not they exist: the verifier reads both by name), every other `*.jsonl` segment present, and the dead-letter queue
 * `usertrust verify` reads for completeness. A directory, FIFO, socket or device where any of these belongs is not
 * "absent": the verifier finds something there and fails on it.
 */
export function verifierInputs(auditListing: readonly string[]): VaultInput[] {
	const inputs: VaultInput[] = [
		{ rel: `audit/${MAIN_LOG}`, role: "log" },
		{ rel: `audit/${MAIN_LOG}.meta`, role: "anchor" },
	];
	for (const name of [...auditListing].sort()) {
		if (name.endsWith(".jsonl") && name !== MAIN_LOG)
			inputs.push({ rel: `audit/${name}`, role: "log" });
	}
	inputs.push({ rel: DEAD_LETTER_QUEUE, role: "queue" });
	return inputs;
}
