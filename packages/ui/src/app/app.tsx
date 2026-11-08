// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { DeskShell } from "./desk/desk-shell.js";
import { DeskProvider } from "./desk/desk-state.js";

/** The page is the desk: its state, then its shell. Everything the page draws lives under `desk/` and `windows/`. */
export function App(): React.JSX.Element {
	return (
		<DeskProvider>
			<DeskShell />
		</DeskProvider>
	);
}
