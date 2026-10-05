// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A racer process for the journal concurrency tests: it opens the SAME journal
 * file as its rival, waits for the shared "go" file so both start together, then
 * either claims every hold (`cas` mode) or reserves against every budget
 * (`reserve` mode). It prints one JSON line: what it won.
 */

import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { HoldJournal, JournalBusyError } from "../../src/journal.js";

const [mode, dbPath, goFile, role, countArg, ledgerPath] = process.argv.slice(2);
const count = Number(countArg);
// A SHORT busy timeout, so BUSY genuinely surfaces between the two processes: it must be RETRIED (it is never a lost
// claim) and it is counted, so the test can prove it happened.
const journal = HoldJournal.open(dbPath as string, { busyTimeoutMs: 2, busyRetries: 0 });
let busy = 0;
async function untilNotBusy<T>(op: () => Promise<T>): Promise<T> {
	for (;;) {
		try {
			return await op();
		} catch (err) {
			if (!(err instanceof JournalBusyError)) throw err;
			busy += 1;
		}
	}
}

writeFileSync(`${goFile}.${role}.${process.pid}.ready`, "");
while (!existsSync(goFile as string)) await new Promise((r) => setTimeout(r, 1));
const startedAt = performance.timeOrigin + performance.now();

const won: number[] = [];
if (mode === "cas") {
	const to = role === "sweep" ? "expiring" : "settling";
	for (let i = 0; i < count; i++) {
		const ok = await untilNotBusy(() => journal.writeTx(() => journal.cas(`h${i}`, "open", to)));
		if (ok) won.push(i);
	}
} else {
	// A stand-in ledger in its own file: placing a hold spends available credit.
	// It refuses NOTHING, so a double admission shows up as two open holds.
	const ledger = new DatabaseSync(ledgerPath as string);
	ledger.exec("PRAGMA busy_timeout = 5000");
	for (let i = 0; i < count; i++) {
		const r = await untilNotBusy(() =>
			journal.reserve({
				holdId: `${role}-${i}`,
				budgetId: `b${i}`,
				amount: 100,
				ttlAt: 0,
				availableCredit: () =>
					(
						ledger.prepare("SELECT available FROM bal WHERE budget = ?").get(`b${i}`) as {
							available: number;
						}
					).available,
				placeHold: () => {
					ledger
						.prepare("UPDATE bal SET available = available - 100 WHERE budget = ?")
						.run(`b${i}`);
				},
			}),
		);
		if (r.admitted) won.push(i);
	}
}
const endedAt = performance.timeOrigin + performance.now();
process.stdout.write(`${JSON.stringify({ role, won, busy, startedAt, endedAt })}\n`);
journal.close();
