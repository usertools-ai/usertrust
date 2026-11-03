// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FilterState } from "../shared/filters.js";
import {
	decodeUrlState,
	planHistory,
	sameUrlState,
	type UrlState,
	type ViewId,
} from "../shared/url-state.js";

/**
 * The view, the filters and the open record, kept in the page address (`location.hash`). Starts from the hash; a
 * change writes it back (replace for a filter tweak, push for a view or record change, see `planHistory`); a hash the
 * user edits or navigates to (Back, Forward, a pasted link) is applied. The hash stays in the browser: nothing is sent.
 */
export function useUrlState(): {
	view: ViewId;
	setView(view: ViewId): void;
	filters: FilterState;
	setFilters(filters: FilterState): void;
	openHash: string | null;
	setOpenHash(hash: string | null): void;
} {
	const [state, setState] = useState<UrlState>(() => decodeUrlState(window.location.hash));
	// The state as of the last write, to tell a view/record change (push) from a filter tweak (replace).
	const written = useRef(state);

	useEffect(() => {
		const plan = planHistory(written.current, state, window.location.hash);
		written.current = state;
		if (plan.kind === "none") return;
		const url = `${window.location.pathname}${window.location.search}${plan.hash}`;
		try {
			if (plan.kind === "push") window.history.pushState(null, "", url);
			else window.history.replaceState(null, "", url);
		} catch {
			// A browser that refuses (a sandboxed frame, too many calls in a row): the page works, just unbookmarkable.
		}
	}, [state]);

	useEffect(() => {
		const apply = (): void => {
			const next = decodeUrlState(window.location.hash);
			setState((prev) => (sameUrlState(prev, next) ? prev : next));
		};
		window.addEventListener("hashchange", apply);
		window.addEventListener("popstate", apply);
		return () => {
			window.removeEventListener("hashchange", apply);
			window.removeEventListener("popstate", apply);
		};
	}, []);

	const setView = useCallback((view: ViewId) => setState((s) => ({ ...s, view })), []);
	const setFilters = useCallback(
		(filters: FilterState) => setState((s) => ({ ...s, filters })),
		[],
	);
	const setOpenHash = useCallback((open: string | null) => setState((s) => ({ ...s, open })), []);
	return {
		view: state.view,
		setView,
		filters: state.filters,
		setFilters,
		openHash: state.open,
		setOpenHash,
	};
}
