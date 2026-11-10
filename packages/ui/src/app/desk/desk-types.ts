// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The shapes the desk's contexts carry. They live in a plain `.ts` file, and `desk-state.tsx` re-exports them, because
 * the tests' tsconfig has no `jsx`: a test helper can import types from a `.ts` file but not from a `.tsx` one, and the
 * fixture helper must be typed against exactly these shapes.
 */

import type { AddressNote } from "../../shared/address-sync.js";
import type { AtPayload, SummaryPayload } from "../../shared/api.js";
import type { Breakdown, Dimension, SpendWindow } from "../../shared/breakdown.js";
import type { ColorMap } from "../../shared/colors.js";
import type { WindowId } from "../../shared/desk-layout.js";
import type { FilterState } from "../../shared/filters.js";
import type { ListView } from "../../shared/list-view.js";
import type { LedgerRow } from "../../shared/rows.js";
import type { RangeId } from "../../shared/spend-series.js";
import type { LiveState } from "../store.js";
import type { Peel, PeelState } from "./escape-peel.js";

/** What the desk draws from, changing once per batch of records or per position. */
export interface DeskData {
	rows: LedgerRow[];
	list: ListView;
	summary: SummaryPayload | null;
	live: LiveState;
	liveIds: Set<string>;
	/** The position shown in the header (the vault as recorded there), or null for live. */
	at: AtPayload | null;
	/**
	 * The record the address's position was answered with (a position past the head is answered with the head), kept
	 * across reconnects; null before the first answer for the current address, and live.
	 */
	resolvedPos: number | null;
	/**
	 * How the windows' rows were chosen against the shown answer (`pastRows`): `live` with none, `answered` when the
	 * page's live rows are the answer's own vault, `snapshot` when the rows drawn are the answer's snapshot and the
	 * page's live rows are another vault's (a chart that reads the live rows must not take the answer's total then),
	 * `held` while no rows of the answer's vault are held yet (`pastHeld`).
	 */
	pastKind: "live" | "answered" | "snapshot" | "held";
	/** What the header shows: a previewed position (none is asked for now), else the committed `at` (A6). */
	headAt: AtPayload | null;
	/** The last position of the vault, or -1 before a summary lands. */
	head: number;
	/** Whether what the windows draw lags the header (a deferred render still landing, or `pastHeld`). */
	held: boolean;
	holdNote: string | null;
	/**
	 * The past view waits for the records of the point's own vault (`pastRows` held): the windows draw none, say
	 * `pastNote` instead of their empty states, and Export writes nothing.
	 */
	pastHeld: boolean;
	/** The held words (`pastHeldNote`): "Updating to the reloaded vault…" after a reload, else "Loading this point's records…". */
	pastNote: string;
	nowMs: number;
	/** The window the breakdown reads (`deskWindow`). */
	window: SpendWindow;
	/** The level the breakdown is taken at (`effectiveLevel`). */
	level: Dimension;
	/** The breakdown for `level`, computed on first read. */
	breakdown: () => Breakdown;
	/** The colours for `level`, fixed for the session: the same map `colorsFor(level)` gives. */
	colors: () => ColorMap;
	/**
	 * The colours of any dimension, fixed for the session, built on first read. A tint can come from a dimension that
	 * is not the current level (a provider filter while the split is by lane), so it needs that dimension's map.
	 */
	colorsFor(dim: Dimension): ColorMap;
	/** The active filters as `"<field>:<value>"` tokens in the order they were added, the newest last (the chips' order). */
	filterOrder: readonly string[];
}

/** What the reader chose: filters, range, dimension, fill, the open record and the position. */
export interface DeskView {
	filters: FilterState;
	setFilters(f: FilterState): void;
	range: RangeId;
	setRange(r: RangeId): void;
	dim: Dimension;
	setDim(d: Dimension): void;
	fill: WindowId | null;
	setFill(id: WindowId | null): void;
	openHash: string | null;
	setOpenHash(h: string | null): void;
	at: number | null;
	setAt(p: number | null): void;
	/**
	 * Show the header at a position without touching the address (a hover on the chart), or null to return it to the
	 * address's position. The list does not move, and Back has nothing to undo.
	 */
	preview(p: number | null): void;
}

/** What only the shell reads: the status under the header, the count, the address note and the Esc layers. */
export interface ShellBinding {
	/** The status under the header (`AtStatus`), for the position the address names; its held note is `DeskData`'s. */
	status: {
		error: string | null;
		/** The position asked for has no answer yet (`pointLoading`). */
		loading: boolean;
		reloaded: boolean;
		/** The polite live region's text (`holdAnnouncement`). */
		announce: string;
	};
	goLive(): void;
	filtering: boolean;
	newestOf: number | undefined;
	count: string;
	addressNote: AddressNote;
	peel: PeelState;
	act: Record<Peel, () => void>;
}
