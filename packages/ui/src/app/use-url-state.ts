// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AddressIo,
	type AddressNote,
	AddressSync,
	addressNoteFor,
} from "../shared/address-sync.js";
import type { FilterState } from "../shared/filters.js";
import {
	addressHolds,
	decodeUrlState,
	sameUrlState,
	type UrlState,
	type ViewId,
} from "../shared/url-state.js";

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
 * The view, the filters, the open record and the position shown, kept in the page address (`location.hash`). Starts from the hash; a
 * change writes it back (replace for a filter tweak, push for a view or record change, see `planHistory`); a hash the
 * user edits or navigates to (Back, Forward, a pasted link) is applied. The hash stays in the browser: nothing is sent.
 * When the address does not describe the page (a state it cannot hold, or a write the browser refused and that is being
 * retried), `addressNote` says why, and the page shows it.
 */
export function useUrlState(): {
	view: ViewId;
	setView(view: ViewId): void;
	filters: FilterState;
	setFilters(filters: FilterState): void;
	openHash: string | null;
	setOpenHash(hash: string | null): void;
	/** The position shown (the vault as recorded there), or null for live. */
	at: number | null;
	setAt(at: number | null): void;
	/** Why the address does not describe the page right now, or null; the page shows it. */
	addressNote: AddressNote;
} {
	const [state, setState] = useState<UrlState>(() => decodeUrlState(window.location.hash));
	const [behind, setBehind] = useState(false);
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
		};
		window.addEventListener("hashchange", apply);
		window.addEventListener("popstate", apply);
		return () => {
			window.removeEventListener("hashchange", apply);
			window.removeEventListener("popstate", apply);
			sync.current?.cancel();
		};
	}, []);

	const setView = useCallback((view: ViewId) => setState((s) => ({ ...s, view })), []);
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
	const holds = useMemo(() => addressHolds(state), [state]);
	const addressNote: AddressNote = addressNoteFor(holds, behind);
	return {
		view: state.view,
		setView,
		filters: state.filters,
		setFilters,
		openHash: state.open,
		setOpenHash,
		at: state.at,
		setAt,
		addressNote,
	};
}
