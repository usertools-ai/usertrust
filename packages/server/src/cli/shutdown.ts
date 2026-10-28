// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How long the command line waits for the server to finish closing before it exits anyway.
 * `close()` now waits for every hold's void and its record (a signal used to exit while that work
 * was still starting); this bound keeps a ledger that never answers from holding the process open
 * past a supervisor's kill timeout. Holds not yet voided then expire at the ledger's own pending
 * timeout, as they always have.
 */
export const SHUTDOWN_BOUND_MS = 5_000;

/** Runs `close` and waits for it at most `boundMs`; answers whether it finished in time. */
export async function closeWithin(
	close: () => Promise<void>,
	boundMs: number,
): Promise<"closed" | "timed out"> {
	let timer: NodeJS.Timeout | undefined;
	const bound = new Promise<"timed out">((resolve) => {
		timer = setTimeout(() => resolve("timed out"), boundMs);
	});
	try {
		return await Promise.race([close().then(() => "closed" as const), bound]);
	} finally {
		clearTimeout(timer);
	}
}
