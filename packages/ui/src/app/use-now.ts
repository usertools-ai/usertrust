// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";

/** How often a component that shows an age re-reads the clock: well inside the minute an age is shown to. */
export const NOW_TICK_MS = 15_000;

/**
 * The current time (ms since the epoch), re-read every NOW_TICK_MS and again when the page becomes visible (a
 * background tab or a sleeping laptop stops timers, so the first look after waking must not show the old age).
 * The interval and the listener are removed on unmount.
 */
export function useNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const refresh = (): void => setNow(Date.now());
		const timer = setInterval(refresh, NOW_TICK_MS);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, []);
	return now;
}
