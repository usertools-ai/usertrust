// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AtPayload, SummaryPayload } from "../shared/api.js";
import { AtFollower, type AtView, LIVE_VIEW } from "../shared/at-follow.js";
import { atFailureText } from "../shared/timeline-view.js";
import type { LiveState } from "./store.js";

/**
 * GET /api/at?pos=N. Every failure is an Error whose message is the short phrase the timeline shows. `signal` is the
 * follower's: it aborts the request after `AT_TIMEOUT_MS`, so a hung server goes down the failure path.
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
 * position winning (`AtFollower`). `preview` asks for a position without touching the address (a drag in progress).
 * Each new summary (every append, status change and reload sends one) re-reads the position: a later record can change
 * the status a row had there, and a reload can change what the position names. When the live stream comes back after
 * dropping, the server may have restarted and restarted its epochs, so the follower forgets the epoch and re-reads.
 */
export function useAt(
	pos: number | null,
	summary: SummaryPayload | null,
	live: LiveState,
): { view: AtView; preview(pos: number | null): void } {
	const [view, setView] = useState<AtView>(LIVE_VIEW);
	const follower = useRef<AtFollower | null>(null);
	if (follower.current === null) follower.current = new AtFollower(loadAt, setView);

	useEffect(() => {
		follower.current?.want(pos);
	}, [pos]);

	useEffect(() => {
		if (summary !== null) follower.current?.refresh();
	}, [summary]);

	// "live" after "reconnecting" or "offline" is a reconnect; the first "live" (after "connecting") is not.
	const wasDown = useRef(false);
	useEffect(() => {
		if (live === "reconnecting" || live === "offline") wasDown.current = true;
		else if (live === "live" && wasDown.current) {
			wasDown.current = false;
			follower.current?.reconnected();
		}
	}, [live]);

	const preview = useCallback((p: number | null) => follower.current?.want(p), []);
	return { view, preview };
}
