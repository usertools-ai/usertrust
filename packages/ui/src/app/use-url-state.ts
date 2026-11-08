// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AddressIo,
	type AddressNote,
	AddressSync,
	addressNoteFor,
} from "../shared/address-sync.js";
import type { Dimension } from "../shared/breakdown.js";
import type { WindowId } from "../shared/desk-layout.js";
import type { FilterState } from "../shared/filters.js";
import type { RangeId } from "../shared/spend-series.js";
import { addressHolds, decodeUrlState, sameUrlState, type UrlState } from "../shared/url-state.js";

const browserAddress: AddressIo = {
	hash: () => window.location.hash,
	write(kind, hash) {
		const url = `${window.location.pathname}${window.location.search}${hash}`;
		if (kind === "push") window.history.pushState(null, "", url);
		else window.history.replaceState(null, "", url);
	},
	later(fn, ms) {
		const id = window.setTimeout(fn, ms);
		return () => window.clearTimeout(id);
	},
};

/**
 * The filters, the open record, the position shown, the spend range, the dimension and the window that fills the desk,
 * kept in the page address (`location.hash`). Starts from the hash; a change writes it back (replace for a search,
 * range or dimension tweak, push for a fill, a chip or a record change, see `planHistory`); a hash the
 * user edits or navigates to (Back, Forward, a pasted link) is applied. The hash stays in the browser: nothing is sent.
 * When the address does not describe the page (a state it cannot hold, or a write the browser refused and that is being
 * retried), `addressNote` says why, and the page shows it.
 */
export function useUrlState(): {
	filters: FilterState;
	setFilters(filters: FilterState): void;
	openHash: string | null;
	setOpenHash(hash: string | null): void;
	/** The position shown (the vault as recorded there), or null for live. */
	at: number | null;
	setAt(at: number | null): void;
	/** How many navigations the user made (not the page's own writes): a change means every pending gesture is stale. */
	navigation: number;
	range: RangeId;
	setRange(range: RangeId): void;
	dim: Dimension;
	setDim(dim: Dimension): void;
	/** The window that fills the desk, or null. */
	fill: WindowId | null;
	setFill(fill: WindowId | null): void;
	/** Why the address does not describe the page right now, or null; the page shows it. */
	addressNote: AddressNote;
} {
	const [state, setState] = useState<UrlState>(() => decodeUrlState(window.location.hash));
	const [behind, setBehind] = useState(false);
	// How many times the user navigated (Back, Forward, a link, a typed address), counted whether or not the state
	// changed: two entries can show the same position, and what a gesture left pending must still be dropped.
	const [navigation, setNavigation] = useState(0);
	// One writer for the page's life: it remembers the last state the address took (push or replace) and retries a
	// write the browser refused.
	const sync = useRef<AddressSync | null>(null);
	if (sync.current === null) sync.current = new AddressSync(state, browserAddress, setBehind);

	useEffect(() => {
		sync.current?.sync(state);
	}, [state]);

	useEffect(() => {
		const apply = (): void => {
			// The user navigated: the address they went to is the truth now, whether or not the page's state changes.
			const next = decodeUrlState(window.location.hash);
			sync.current?.adopt(next);
			setState((prev) => (sameUrlState(prev, next) ? prev : next));
			setNavigation((n) => n + 1);
		};
		window.addEventListener("hashchange", apply);
		window.addEventListener("popstate", apply);
		return () => {
			window.removeEventListener("hashchange", apply);
			window.removeEventListener("popstate", apply);
			sync.current?.cancel();
		};
	}, []);

	const setFilters = useCallback(
		(filters: FilterState) => setState((s) => ({ ...s, filters })),
		[],
	);
	const setOpenHash = useCallback((open: string | null) => setState((s) => ({ ...s, open })), []);
	// Entering or leaving a position pushes an entry; moving between positions replaces it (`planHistory`).
	const setAt = useCallback(
		(at: number | null) => setState((s) => (s.at === at ? s : { ...s, at })),
		[],
	);
	const setRange = useCallback(
		(r: RangeId) => setState((s) => (s.range === r ? s : { ...s, range: r })),
		[],
	);
	const setDim = useCallback(
		(d: Dimension) => setState((s) => (s.dim === d ? s : { ...s, dim: d })),
		[],
	);
	const setFill = useCallback(
		(f: WindowId | null) => setState((s) => (s.fill === f ? s : { ...s, fill: f })),
		[],
	);
	const holds = useMemo(() => addressHolds(state), [state]);
	const addressNote: AddressNote = addressNoteFor(holds, behind);
	return {
		filters: state.filters,
		setFilters,
		openHash: state.open,
		setOpenHash,
		at: state.at,
		setAt,
		range: state.range,
		setRange,
		dim: state.dim,
		setDim,
		fill: state.fill,
		setFill,
		navigation,
		addressNote,
	};
}
