// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import type { AtPayload, SummaryPayload } from "../shared/api.js";
import { AtFollower, type AtView, LIVE_VIEW } from "../shared/at-follow.js";
import type { LedgerRow } from "../shared/rows.js";
import { atFailureText } from "../shared/timeline-view.js";
import type { LiveState } from "./store.js";

/**
 * GET /api/at?pos=N. Every failure is an Error whose message is the short phrase the status under the header shows.
 * `signal` is the follower's: it aborts the request after `AT_TIMEOUT_MS`, so a hung server goes down the failure path.
 */
async function loadAt(pos: number, signal: AbortSignal): Promise<AtPayload> {
	let res: Response;
	try {
		res = await fetch(`/api/at?pos=${pos}`, { cache: "no-store", signal });
	} catch {
		throw new Error(atFailureText(null));
	}
	if (!res.ok) throw new Error(atFailureText(res.status));
	try {
		return (await res.json()) as AtPayload;
	} catch {
		throw new Error(atFailureText(500));
	}
}

/**
 * The vault as recorded at `pos` (the address's; null: live), from `/api/at`, one request at a time with the latest
 * position winning (`AtFollower`). A preview of another position (none is asked for now) goes through a second
 * `useAt` of its own (`DeskProvider`), never this one. Each new summary (every append, status change and reload sends one) re-reads the position: a later record
 * can change the status a row had there, and a reload can change what the position names. When the live stream comes
 * back after dropping, the server may have restarted and restarted its epochs, so the follower forgets the epoch and
 * re-reads.
 *
 * `navigation` counts the user's navigations (Back, Forward, a link, a typed address): each one resets the view to the
 * address's position, dropping a preview that was asking for another.
 *
 * `rows` are the rows the page holds, `resyncs` how many times they have been replaced wholesale and `rowsVault` the
 * key of the vault they come from (read with them, so a view knows which vault its rows were). Each request is sent
 * with the rows held at that moment, and its answer is shown with those rows (`view.rows`), never with the rows held
 * when it lands; a later request that reads the same replaces them once a resync has landed (`AtFollower`).
 */
export function useAt(
	pos: number | null,
	summary: SummaryPayload | null,
	live: LiveState,
	rows: readonly LedgerRow[],
	resyncs: number,
	rowsVault: string | null,
	navigation: number,
): { view: AtView } {
	const [view, setView] = useState<AtView>(LIVE_VIEW);
	const follower = useRef<AtFollower | null>(null);
	// The rows as of the last commit, for the follower to read when it sends a request. Written in an effect, never
	// while rendering, and declared before the effects below so a request they send reads this commit's rows.
	const held = useRef({ rows, resyncs, rowsVault });
	useEffect(() => {
		held.current = { rows, resyncs, rowsVault };
	}, [rows, resyncs, rowsVault]);
	if (follower.current === null)
		follower.current = new AtFollower(
			loadAt,
			setView,
			undefined,
			() => held.current.rows,
			() => held.current.resyncs,
			() => held.current.rowsVault,
		);

	// A navigation shows the destination's own view, also when its position is the one already wanted: a preview the
	// preview was asking for is not the address's position, and the address is what Back or Forward went to. The follower
	// hears of the navigation first, so an answer to the preview's request still in flight is not shown on the way.
	const lastNavigation = useRef(navigation);
	useEffect(() => {
		if (navigation !== lastNavigation.current) {
			lastNavigation.current = navigation;
			follower.current?.navigated();
		}
		follower.current?.want(pos);
	}, [pos, navigation]);

	// A snapshot that lands after a newer summary frame reinstalls the summary already held: the rows and `resyncs`
	// change and `summary` does not, and the answer still needs the re-read that replaces its rows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `resyncs` is a trigger, not a value the effect reads
	useEffect(() => {
		if (summary !== null) follower.current?.refresh();
	}, [summary, resyncs]);

	// "live" after "reconnecting" or "offline" is a reconnect; the first "live" (after "connecting") is not.
	const wasDown = useRef(false);
	useEffect(() => {
		if (live === "reconnecting" || live === "offline") wasDown.current = true;
		else if (live === "live" && wasDown.current) {
			wasDown.current = false;
			follower.current?.reconnected();
		}
	}, [live]);

	return { view };
}
