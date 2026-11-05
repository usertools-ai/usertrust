// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";

/** Whether the viewport matches a media query, kept current as the window is resized or rotated. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const m = window.matchMedia(query);
		const on = (): void => setMatches(m.matches);
		on();
		m.addEventListener("change", on);
		return () => m.removeEventListener("change", on);
	}, [query]);
	return matches;
}
