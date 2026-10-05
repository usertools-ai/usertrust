// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The INDEPENDENT detector (plan §4): a separate periodic check — not sweeper code — that reads
 * the hold journal and raises an incident for anything the sweeper should have resolved and
 * did not. It writes nothing, so a sweeper whose writes fail, or that stops running, is caught
 * by something that does not share its failure.
 *
 * The primitive is the journal READ, which either succeeds (possibly finding nothing) or
 * throws. The two are distinct readings — `readable: true` with zero incidents, or
 * `readable: false` — so an unreadable journal is never reported as an empty one (a failed read
 * never counts as 0).
 */

import type { HoldJournal, HoldRow } from "./journal.js";

export interface DetectorOptions {
	/** How often the sweeper runs (ms). Overdue is two intervals past what it should have done. */
	sweepIntervalMs: number;
	/** The engine's `expiryGraceMs` (default 60 s): the sweeper's own deadline past `ttlAt`. */
	expiryGraceMs?: number;
	now?: () => number;
}

export type DetectorIncident =
	/** The sweeper has never written a heartbeat. */
	| { kind: "sweeper_never_ran" }
	/** The sweeper's heartbeat is older than two sweep intervals. */
	| { kind: "sweeper_stale"; heartbeatAt: number; ageMs: number }
	/** `open` holds overdue for expiry: the sweeper did not claim them. */
	| { kind: "open_overdue"; holdIds: string[] }
	/** `settling` / `voiding` / `expiring` rows overdue: replay did not finish them. */
	| { kind: "in_flight_overdue"; holdIds: string[] }
	/** Recorded late settlements overdue and still uncharged. */
	| { kind: "late_uncharged_overdue"; holdIds: string[] }
	/** A row carrying a recorded terminal incident: an operator must act on it. */
	| { kind: "row_incident"; holdId: string; incident: unknown };

export type DetectorReading =
	| {
			readable: true;
			incidents: DetectorIncident[];
			counts: { open: number; inFlight: number; lateUncharged: number; rowIncidents: number };
	  }
	| { readable: false; error: string };

export class HoldDetector {
	private readonly now: () => number;
	private readonly graceMs: number;

	constructor(
		private readonly journal: HoldJournal,
		private readonly opts: DetectorOptions,
	) {
		if (!Number.isSafeInteger(opts.sweepIntervalMs) || opts.sweepIntervalMs <= 0) {
			throw new TypeError("hold detector: sweepIntervalMs must be a positive whole number");
		}
		this.now = opts.now ?? Date.now;
		this.graceMs = opts.expiryGraceMs ?? 60_000;
	}

	/** One check. Never throws for a read: a read that fails is the `readable: false` reading. */
	check(): DetectorReading {
		const now = this.now();
		const overdueBefore = now - this.graceMs - 2 * this.opts.sweepIntervalMs;
		let open: HoldRow[];
		let inFlight: HoldRow[];
		let late: HoldRow[];
		let rowIncidents: HoldRow[];
		let heartbeat: number | null;
		try {
			open = this.journal.openPast(overdueBefore);
			inFlight = this.journal.inFlight().filter((r) => r.ttlAt < overdueBefore);
			late = this.journal.lateUncharged().filter((r) => r.ttlAt < overdueBefore);
			rowIncidents = this.journal.incidents();
			heartbeat = this.journal.heartbeat();
		} catch (err) {
			return { readable: false, error: err instanceof Error ? err.message : String(err) };
		}
		const incidents: DetectorIncident[] = [];
		if (heartbeat === null) incidents.push({ kind: "sweeper_never_ran" });
		else if (now - heartbeat > 2 * this.opts.sweepIntervalMs) {
			incidents.push({ kind: "sweeper_stale", heartbeatAt: heartbeat, ageMs: now - heartbeat });
		}
		if (open.length > 0)
			incidents.push({ kind: "open_overdue", holdIds: open.map((r) => r.holdId) });
		if (inFlight.length > 0) {
			incidents.push({ kind: "in_flight_overdue", holdIds: inFlight.map((r) => r.holdId) });
		}
		if (late.length > 0) {
			incidents.push({ kind: "late_uncharged_overdue", holdIds: late.map((r) => r.holdId) });
		}
		for (const r of rowIncidents) {
			incidents.push({ kind: "row_incident", holdId: r.holdId, incident: r.incident });
		}
		return {
			readable: true,
			incidents,
			counts: {
				open: open.length,
				inFlight: inFlight.length,
				lateUncharged: late.length,
				rowIncidents: rowIncidents.length,
			},
		};
	}
}
