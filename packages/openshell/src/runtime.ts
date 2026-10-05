// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Starting the middleware's hold machinery: ONE process per vault, enforced at START (plan §9).
 *
 * The order is the guarantee:
 *   1. the vault's audit lock — {@link VaultAudit.open} takes it in the writer's factory, so a
 *      second live process fails HERE (`AuditWriterLockHeldError`), before anything below;
 *   2. the journal;
 *   3. the engine (with the audit port);
 *   4. one sweep — the replay at start (in-flight rows, late charges, missing events).
 * A second process therefore never opens the journal, never sweeps and never replays.
 */

import { VaultAudit } from "./audit.js";
import { type EngineOptions, HoldEngine, type SweepReport } from "./engine.js";
import { HoldJournal, type JournalOptions } from "./journal.js";
import type { LedgerPort } from "./ledger.js";

export interface RuntimeOptions {
	/** The usertrust vault whose audit chain records the holds' events. */
	vaultPath: string;
	/** The hold journal's SQLite file. */
	journalPath: string;
	journal?: JournalOptions;
	ledger: LedgerPort;
	engine: Omit<EngineOptions, "audit">;
}

export interface OpenshellRuntime {
	audit: VaultAudit;
	journal: HoldJournal;
	engine: HoldEngine;
	/** What the sweep at start did (the replay after a crash). */
	startup: SweepReport;
	/** Close the journal, then release the vault's audit lock. */
	close(): void;
}

export async function startRuntime(o: RuntimeOptions): Promise<OpenshellRuntime> {
	const audit = VaultAudit.open(o.vaultPath); // 1. the lock — a second process stops here
	let journal: HoldJournal | undefined;
	try {
		journal = HoldJournal.open(o.journalPath, o.journal); // 2.
		const engine = new HoldEngine(journal, o.ledger, { ...o.engine, audit }); // 3.
		const startup = await engine.sweep(); // 4.
		const opened = journal;
		return {
			audit,
			journal: opened,
			engine,
			startup,
			close() {
				opened.close();
				audit.release();
			},
		};
	} catch (err) {
		journal?.close();
		audit.release();
		throw err;
	}
}
