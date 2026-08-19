// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One bounded budget, shared by every place this server waits on a governor.
 *
 * The ledger client underneath has no timeout of its own and never rejects an
 * unreachable cluster — it retries forever — so "the ledger is down" reaches this
 * package as a promise that simply never settles. Every unbounded `await` on a
 * governor is therefore a place the server can stop answering, and it had four:
 * `/v1/authorize` (the reported outage), the other request handlers, the
 * shutdown/sweep abort, and `close()` itself.
 *
 * The budget is per REQUEST, not per await, and that distinction is load-bearing.
 * A per-await timeout bounds nothing a caller can observe: a cold tenant waits for
 * governor construction and THEN for `authorize()`, so two 4s timeouts are an 8s
 * request — past the 5s at which `usertrust-claude-code` aborts. The caller would
 * be gone before its own server answered, which is precisely the failure this
 * change exists to prevent, reintroduced by the fix for it.
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
 * An absolute time budget that several sequential awaits draw down from.
 *
 * Construct one per request and pass it along; every `run()` shares what remains
 * rather than restarting the clock.
 */
export class Deadline {
	private readonly endsAt: number;

	constructor(private readonly budgetMs: number) {
		this.endsAt = Date.now() + budgetMs;
	}

	/** Milliseconds left in the budget; never negative. */
	remainingMs(): number {
		return Math.max(0, this.endsAt - Date.now());
	}

	/**
	 * Resolve `op`, or reject with {@link GovernorTimeoutError} once the budget is
	 * spent. The error reports the whole budget rather than the slice this await
	 * got: the caller configured a request bound, and that is the number explaining
	 * what happened to their request.
	 *
	 * `onAbandoned` is the other half of the bargain, and callers whose `op`
	 * produces anything durable MUST pass it. A deadline abandons the operation; it
	 * does not stop it. So an `op` landing after we have already answered still
	 * created something real — a ledger hold, a live governor — now unreachable by
	 * every ordinary path, because the handle that would reach it went nowhere. Two
	 * AGENTS.md invariants say what happens next: every hold takes exactly one
	 * terminal outcome, and every governor is destroyed. Neither has an exception
	 * for "the server stopped waiting", so late arrivals are reclaimed here.
	 */
	async run<T>(what: string, op: Promise<T>, onAbandoned?: (value: T) => void): Promise<T> {
		let timedOut = false;
		if (onAbandoned !== undefined) {
			// Attached BEFORE the race, so nothing can land in the gap. A late REJECTION
			// produced nothing to reclaim and is swallowed deliberately: by then it has no
			// listener left, and an unhandled rejection would take the process down over a
			// failure the caller was already told about.
			op.then(
				(value) => {
					if (!timedOut) return;
					// The cleanup's OWN failure must not become an unhandled rejection
					// either. This callback is typed `void`-returning, but an async function
					// is assignable to that, so a caller can hand back a promise we would
					// otherwise drop — and dropping a rejected one can terminate Node.
					// Cleanup is best-effort by nature; the governor's own
					// destroy/reconciliation is the backstop.
					try {
						void Promise.resolve(onAbandoned(value)).catch(() => {});
					} catch {
						/* a synchronous throw from cleanup is equally non-fatal */
					}
				},
				() => {},
			);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				op,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						// Set before rejecting: the flag is what tells the continuation above
						// that its value arrived too late to be returned to anyone.
						timedOut = true;
						reject(new GovernorTimeoutError(what, this.budgetMs));
					}, this.remainingMs());
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}

/** A one-await budget. Prefer a shared {@link Deadline} when several awaits serve one request. */
export async function withDeadline<T>(
	what: string,
	op: Promise<T>,
	timeoutMs: number,
	onAbandoned?: (value: T) => void,
): Promise<T> {
	return new Deadline(timeoutMs).run(what, op, onAbandoned);
}
