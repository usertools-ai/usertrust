// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Bound a best-effort teardown step, and CLEAR the timer when the work wins.
 *
 * The clearing is the whole reason this exists rather than an inline
 * `Promise.race([work, sleep(n)])`. A losing `setTimeout` stays referenced, so the
 * loser of every race holds the event loop open for its full budget — which in
 * teardown means `destroy()` returns promptly and the process still cannot exit for
 * another N seconds. That is the exact failure teardown exists to prevent,
 * reintroduced by the bound added to prevent it, and it fires on EVERY governor
 * including dry-run ones with nothing to void.
 *
 * Resolves rather than rejects on expiry: the caller is a cleanup path that must
 * continue either way.
 */
export async function raceWithBudget(work: Promise<void>, budgetMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, budgetMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
