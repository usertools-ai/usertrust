// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import type { AtPayload, SummaryPayload } from "../shared/api.js";
import { AtFollower, type AtView, LIVE_VIEW } from "../shared/at-follow.js";
import { atFailureText } from "../shared/timeline-view.js";

/** GET /api/at?pos=N. Every failure is an Error whose message is the short phrase the timeline shows. */
async function loadAt(pos: number): Promise<AtPayload> {
	let res: Response;
	try {
		res = await fetch(`/api/at?pos=${pos}`, { cache: "no-store" });
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
 * The vault as recorded at `pos` (null: live), from `/api/at`, one request at a time with the latest position winning
 * (`AtFollower`). Each new summary (every append, status change and reload sends one) re-reads the position: a later
 * record can change the status a row had there, and a reload can change what the position names.
 */
export function useAt(pos: number | null, summary: SummaryPayload | null): AtView {
	const [view, setView] = useState<AtView>(LIVE_VIEW);
	const follower = useRef<AtFollower | null>(null);
	if (follower.current === null) follower.current = new AtFollower(loadAt, setView);

	useEffect(() => {
		follower.current?.want(pos);
	}, [pos]);

	useEffect(() => {
		if (summary !== null) follower.current?.refresh();
	}, [summary]);

	return view;
}
