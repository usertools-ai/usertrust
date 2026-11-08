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
	/** The last position of the vault, or -1 before a summary lands. */
	head: number;
	/** Whether what the windows draw lags the header (a timeline drag, or a deferred render still landing). */
	held: boolean;
	holdNote: string | null;
	nowMs: number;
	/** The window the breakdown reads (`deskWindow`). */
	window: SpendWindow;
	/** The level the breakdown is taken at (`effectiveLevel`). */
	level: Dimension;
	/** The breakdown for `level`, computed on first read. */
	breakdown: () => Breakdown;
	/** The colours for `level`, fixed for the session. */
	colors: () => ColorMap;
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
}

/** What only the shell reads: the timeline's wiring, the count, the address note and the Esc layers. */
export interface ShellBinding {
	timeline: {
		wanted: number | null;
		/** The record the wanted position was answered with, kept across reconnects (`AtView.resolved`). */
		resolved: number | null;
		committed: number | null;
		/** How many navigations the user made: a change drops every pending preview and commit. */
		navigation: number;
		error: string | null;
		reloaded: boolean;
		announce: string;
		onPreview(p: number | null): void;
		onHold(on: boolean): void;
		onCommit(p: number | null): void;
	};
	goLive(): void;
	filtering: boolean;
	newestOf: number | undefined;
	count: string;
	addressNote: AddressNote;
	peel: PeelState;
	act: Record<Peel, () => void>;
}
