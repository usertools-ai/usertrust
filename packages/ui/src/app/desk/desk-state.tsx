// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's state, published in two contexts: the data (per batch of records) and the view (per user action).
 * Windows read them through the hooks below; pointer movement never goes through either (it uses the hover bus).
 *
 * This file starts as the contexts and the first hooks (the shapes are in desk-types.ts); the provider that fills them
 * arrives with the rest of the hooks.
 */

import { createContext, useContext, useMemo } from "react";
import type { WindowId } from "../../shared/desk-layout.js";
import type { DeskData, DeskView, ShellBinding } from "./desk-types.js";

export type { DeskData, DeskView, ShellBinding } from "./desk-types.js";

export const DeskDataContext = createContext<DeskData | null>(null);
export const DeskViewContext = createContext<DeskView | null>(null);
export const DeskShellContext = createContext<ShellBinding | null>(null);

/** The desk's data. Throws outside a provider, so a window rendered bare fails loudly, not with `undefined`. */
export function useDeskData(): DeskData {
	const v = useContext(DeskDataContext);
	if (v === null) throw new Error("useDeskData outside DeskProvider");
	return v;
}

function useDeskView(): DeskView {
	const v = useContext(DeskViewContext);
	if (v === null) throw new Error("useDeskView outside DeskProvider");
	return v;
}

/** The window that fills the desk, and the one way to change it: `toggle` fills a window, or restores it. */
export function useFill(): {
	fill: WindowId | null;
	setFill(id: WindowId | null): void;
	toggle(id: WindowId): void;
} {
	const { fill, setFill } = useDeskView();
	return useMemo(
		() => ({ fill, setFill, toggle: (id: WindowId) => setFill(fill === id ? null : id) }),
		[fill, setFill],
	);
}
