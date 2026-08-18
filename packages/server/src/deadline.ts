// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One bounded await, shared by every place this server waits on a governor.
 *
 * The ledger client underneath has no timeout of its own and never rejects an
 * unreachable cluster — it retries forever — so "the ledger is down" reaches this
 * package as a promise that simply never settles. Every unbounded `await` on a
 * governor is therefore a place the server can stop answering, and it had three:
 * `/v1/authorize` (the reported outage), the other request handlers, and
 * `close()`, which waited on the same never-settling construction promise and so
 * could not shut the process down either.
 *
 * Living in one file is the point. A per-call-site copy is N chances to get the
 * bound wrong and N things to keep in step; a new await that needs bounding should
 * reach for this rather than grow a fourth copy.
 */

/**
 * A governor call exceeded the server's own deadline.
 *
 * Distinct from `LedgerUnavailableError`: that one means a dependency reported
 * itself down, this one means the governor never answered at all — so the outcome
 * is UNKNOWN, not failed. Raised only on paths where an unknown outcome is safe to
 * report (see the settle/abort notes in `server.ts`).
 */
export class GovernorTimeoutError extends Error {
	constructor(what: string, timeoutMs: number) {
		super(`governor did not answer ${what} within ${timeoutMs}ms`);
		this.name = "GovernorTimeoutError";
	}
}

/**
 * Resolve `op`, or reject with {@link GovernorTimeoutError} after `timeoutMs`.
 *
 * `op` itself is left running: it cannot be cancelled, and abandoning it is the
 * whole point — the caller gets an answer either way. `what` is echoed in the
 * error and reaches the client, so name the operation, not the outcome.
 */
export async function withDeadline<T>(what: string, op: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			op,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new GovernorTimeoutError(what, timeoutMs)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
