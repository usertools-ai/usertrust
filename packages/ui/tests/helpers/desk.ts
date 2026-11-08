// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One fixture helper for every desk window's render tests: the two context values with every field filled (so no
 * consumer meets `undefined`), and `withDesk`, which renders an element inside them as static markup.
 */

import type React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeskData, DeskView, ShellBinding } from "../../src/app/desk/desk-types.js";
import { breakdown } from "../../src/shared/breakdown.js";
import { rankColors } from "../../src/shared/colors.js";
import { deskWindow } from "../../src/shared/desk-filters.js";
import type { WindowId } from "../../src/shared/desk-layout.js";
import { EMPTY_FILTERS } from "../../src/shared/filters.js";
import { listView } from "../../src/shared/list-view.js";

const NOW_MS = Date.UTC(2026, 10, 8, 12, 0, 0);

/** The desk's data for an empty, live vault; `over` replaces fields. */
export function defaultDeskData(over: Partial<DeskData> = {}): DeskData {
	const nowMs = over.nowMs ?? NOW_MS;
	const window = over.window ?? deskWindow("1w", null, nowMs);
	const base: DeskData = {
		rows: [],
		list: listView({ rows: [], at: null, filters: EMPTY_FILTERS, phase: "loaded", summary: null }),
		summary: null,
		live: "live",
		liveIds: new Set(),
		at: null,
		head: -1,
		held: false,
		holdNote: null,
		pastHeld: false,
		pastNote: "Loading this point's records…",
		nowMs,
		window,
		level: "lane",
		breakdown: () => breakdown([], window, "lane"),
		colors: () => rankColors([], "lane"),
	};
	return { ...base, ...over };
}

/** The desk's view for a vault with nothing chosen: no filters, the default range, nothing filled, setters that do nothing. */
export function defaultDeskView(over: Partial<DeskView> = {}): DeskView {
	const base: DeskView = {
		filters: EMPTY_FILTERS,
		setFilters: () => undefined,
		range: "1w",
		setRange: () => undefined,
		dim: "lane",
		setDim: () => undefined,
		fill: null,
		setFill: () => undefined,
		openHash: null,
		setOpenHash: () => undefined,
		at: null,
		setAt: () => undefined,
	};
	return { ...base, ...over };
}

/** The shell's wiring for a vault with nothing happening: no note in the address, nothing to peel, handlers that do nothing. */
export function defaultShellBinding(over: Partial<ShellBinding> = {}): ShellBinding {
	const base: ShellBinding = {
		status: { error: null, loading: false, reloaded: false, announce: "" },
		goLive: () => undefined,
		filtering: false,
		newestOf: undefined,
		count: "0 records",
		addressNote: null,
		peel: { recordOpen: false, fill: null, pinned: false, newestFilter: null },
		act: {
			record: () => undefined,
			fill: () => undefined,
			pin: () => undefined,
			filter: () => undefined,
		},
	};
	return { ...base, ...over };
}

export interface WithDeskOptions {
	fill?: WindowId | null;
	held?: boolean;
	data?: Partial<DeskData>;
	view?: Partial<DeskView>;
	shell?: Partial<ShellBinding>;
}

/**
 * `renderToStaticMarkup` of `ui` inside both desk contexts. `fill` and `held` apply over the defaults, then `data` and
 * `view`. The desk-state module is loaded by a computed path: the tests' tsconfig has no `jsx`, so a `.tsx` file
 * cannot be imported statically (only its types can).
 */
export async function withDesk(ui: React.ReactElement, o: WithDeskOptions = {}): Promise<string> {
	const mod = (await import(/* @vite-ignore */ `../../src/app/desk/${"desk-state"}.js`)) as {
		DeskDataContext: React.Context<DeskData | null>;
		DeskViewContext: React.Context<DeskView | null>;
		DeskShellContext: React.Context<ShellBinding | null>;
	};
	const data = defaultDeskData({
		...(o.held === undefined ? {} : { held: o.held }),
		...o.data,
	});
	const view = defaultDeskView({
		...(o.fill === undefined ? {} : { fill: o.fill }),
		...o.view,
	});
	return renderToStaticMarkup(
		createElement(
			mod.DeskDataContext.Provider,
			{ value: data },
			createElement(
				mod.DeskViewContext.Provider,
				{ value: view },
				createElement(mod.DeskShellContext.Provider, { value: defaultShellBinding(o.shell) }, ui),
			),
		),
	);
}
