// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How long the command line waits for the server to finish closing before it exits anyway.
 * `close()` waits for every hold's void and record (a signal used to exit while that work was
 * still starting), and its governors first wait up to their drain bound (5 s) for calls still in
 * flight. The bound is that drain plus 3 s for the voids and records after it, so one call that
 * never finishes cannot use the whole bound and leave the other holds unvoided. It also keeps a
 * ledger that never answers from holding the process open past a supervisor's kill timeout (10 s
 * for a container by default). Holds not yet voided then expire at the ledger's own timeout, as
 * they always have.
 */
export const SHUTDOWN_BOUND_MS = 8_000;

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

/**
 * Shuts down the way the command line does: closes within the bound, says on `write` when it did
 * not finish or failed, and answers the exit code (0 unless `close()` threw).
 */
export async function shutdownExitCode(
	close: () => Promise<void>,
	boundMs: number,
	write: (line: string) => void,
	scrub: (text: string) => string,
): Promise<0 | 1> {
	try {
		const outcome = await closeWithin(close, boundMs);
		if (outcome === "timed out") {
			write(
				`usertrust-server: shutdown did not finish within ${boundMs} ms; holds not yet voided expire at the ledger's pending timeout\n`,
			);
		}
		return 0;
	} catch (err) {
		write(
			`usertrust-server: shutdown failed: ${scrub(err instanceof Error ? err.message : String(err))}\n`,
		);
		return 1;
	}
}
