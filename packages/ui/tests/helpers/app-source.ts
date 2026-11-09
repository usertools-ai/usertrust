// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dirname, "..", "..", "src", "app");

/**
 * The text of the files that, together, are what the page's root component used to be: the root, the desk's state, the
 * shell, and the Ledger window (which holds the list and the record panel). The tests that read the page's source as
 * text read this, so they keep checking the same wiring after it moved.
 */
export function appSource(): string {
	return [
		"app.tsx",
		"desk/desk-state.tsx",
		"desk/desk-shell.tsx",
		"windows/ledger/ledger-window.tsx",
	]
		.map((file) => readFileSync(join(APP, file), "utf-8"))
		.join("\n");
}
