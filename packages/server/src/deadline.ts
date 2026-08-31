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
	 * Run `start()` under the budget, or reject with {@link GovernorTimeoutError}.
	 * The error reports the whole budget rather than the slice this await got: the
	 * caller configured a request bound, and that is the number explaining what
	 * happened to their request.
	 *
	 * Takes a THUNK, not a promise, and that is the load-bearing part. While this
	 * took a promise, `run("authorize", governor.authorize(...))` had already issued
	 * the ledger call by the time the argument was evaluated — so every "check the
	 * clock first" guard checked it strictly after the thing it was meant to gate,
	 * and a refusal still left real work running with nobody holding its handle.
	 *
	 * `onAbandoned` is the other half of the bargain, and callers whose work
	 * produces anything durable MUST pass it. A deadline abandons the operation; it
	 * does not stop it. So an op landing after we have already answered still
	 * created something real — a ledger hold, a live governor — now unreachable by
	 * every ordinary path, because the handle that would reach it went nowhere. Two
	 * AGENTS.md invariants say what happens next: every hold takes exactly one
	 * terminal outcome, and every governor is destroyed. Neither has an exception
	 * for "the server stopped waiting", so late arrivals are reclaimed here.
	 */
	async run<T>(
		what: string,
		start: () => Promise<T>,
		onAbandoned?: (value: T) => void,
	): Promise<T> {
		// Exhausted BEFORE the work is started — e.g. a cold tenant where governor
		// construction spent the whole budget. Nothing is issued on this path, which is
		// strictly stronger than issuing it and reclaiming afterwards: there is no hold
		// to strand, no governor to destroy, and no unobserved promise to reject into
		// nothing. Decide on the CLOCK, and decide before starting.
		if (this.remainingMs() === 0) {
			throw new GovernorTimeoutError(what, this.budgetMs);
		}
		let timedOut = false;
		// Cleanup runs at most once, from whichever path notices the value is late.
		let reclaimed = false;
		const reclaim = (value: T): void => {
			if (reclaimed || onAbandoned === undefined) return;
			reclaimed = true;
			// The cleanup's OWN failure must not become an unhandled rejection either. This
			// callback is typed `void`-returning, but an async function is assignable to
			// that, so a caller can hand back a promise we would otherwise drop — and
			// dropping a rejected one can terminate Node. Cleanup is best-effort by nature;
			// the governor's own destroy/reconciliation is the backstop.
			try {
				void Promise.resolve(onAbandoned(value)).catch(() => {});
			} catch {
				/* a synchronous throw from cleanup is equally non-fatal */
			}
		};
		// THE CLOCK DECIDES ON A SYNCHRONOUS FAILURE TOO — the fourth site, and the
		// one the other three did not cover. A Promise-returning factory or an
		// injected governor method may validly `throw` before it ever returns a
		// promise. If `start()` spends the remaining budget and then throws here,
		// the error bypasses the post-race check below entirely: for an
		// evaluate-only authorize a late `PolicyDeniedError` comes back as a clean
		// `200 {"decision":"would_deny"}` on a request whose deadline had already
		// blown — exactly the laundering of a dependency failure into a policy
		// opinion the catch below exists to prevent, arriving by the one route it
		// cannot see.
		//
		// Nothing is reclaimed on this path and nothing needs to be: the throw means
		// no promise was produced, so there is no in-flight work to strand.
		let op: Promise<T>;
		try {
			op = start();
		} catch (err) {
			if (this.remainingMs() === 0) {
				throw new GovernorTimeoutError(what, this.budgetMs);
			}
			throw err;
		}
		// ALWAYS attached, and always BEFORE the race. `op` outlives this call on every
		// timeout path, so an unobserved rejection becomes an unhandled rejection that can
		// terminate Node: a slow factory can exhaust the budget, get its 503, and reject a
		// second later into nothing. The rejection is swallowed deliberately — by then it
		// has no listener left and the caller was already told — but it must be OBSERVED.
		// Guarding this attachment on `onAbandoned` being present was the bug.
		op.then(
			(value) => {
				if (timedOut) reclaim(value);
			},
			() => {},
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let value: T;
		try {
			value = await Promise.race([
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
		} catch (err) {
			// THE CLOCK DECIDES ON THE FAILURE PATH TOO. A rejection that wins the race jumps
			// straight out through `finally` and skipped the post-race check below, so this
			// helper decided on the clock for values and on the RACE for errors. Past the
			// budget the server has no basis to assert any verdict at all: `server.ts` shadows
			// every mapped status under 500, so a late 4xx came back as a clean
			// `200 {"decision":"would_deny"}` on a request whose deadline had already blown —
			// the same laundering of a dependency failure into a policy opinion this package
			// already fixed once for 503s. Cost of converting every late rejection, accepted
			// deliberately: a late `LedgerUnavailableError` names the TigerBeetle addresses and
			// this reports `governor_timeout` instead. An ON-TIME one still surfaces unchanged,
			// and both map to 503, so only the reason string is lost — worth it to keep the
			// clock the single decider and to keep HTTP status mapping out of this file.
			if (this.remainingMs() === 0) {
				timedOut = true;
				throw new GovernorTimeoutError(what, this.budgetMs);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
		// THE CLOCK DECIDES ON THE WAY OUT TOO — the third site that needed saying so.
		// Promise reactions run before timers, so an event loop delayed across `endsAt`
		// lets a queued `op` reaction settle before the overdue timer callback: the value
		// comes back with the budget already spent, `timedOut` still false, and the
		// continuation above declines to reclaim it. For /v1/authorize that is a hold
		// retained after the caller has gone. Winning a race is not the same as being on
		// time.
		if (this.remainingMs() === 0) {
			timedOut = true;
			reclaim(value);
			throw new GovernorTimeoutError(what, this.budgetMs);
		}
		return value;
	}
}

/** A one-await budget. Prefer a shared {@link Deadline} when several awaits serve one request. */
export async function withDeadline<T>(
	what: string,
	start: () => Promise<T>,
	timeoutMs: number,
	onAbandoned?: (value: T) => void,
): Promise<T> {
	return new Deadline(timeoutMs).run(what, start, onAbandoned);
}
