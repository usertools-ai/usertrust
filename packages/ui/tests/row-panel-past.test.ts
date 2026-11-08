// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The inspector's explicit check at a past position. The check always runs on the vault as it is now, so the past
 * view labels it as running today, in the label and in the help line; the live view is unchanged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerRow } from "../src/shared/rows.js";

// The component is .tsx, which the tests' typecheck (no jsx) cannot import statically: load it by a computed path.
type Component<P> = (props: P) => React.JSX.Element;
let RowPanel: Component<{ row: LedgerRow; docked: boolean; past: boolean; onClose(): void }>;
beforeAll(async () => {
	const file = "row-panel";
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		RowPanel: typeof RowPanel;
	};
	RowPanel = mod.RowPanel;
});

const row: LedgerRow = {
	seq: 7,
	pos: 7,
	id: "id-7",
	ts: "2026-10-12T17:59:02.770Z",
	kind: "llm_call",
	actor: "local",
	hash: "7".padStart(64, "0"),
	previousHash: "0".repeat(64),
	integrity: "verified",
	status: "settled",
	transferId: "0000000000000000000000000000abcd",
};

const panel = (past: boolean, docked = true): string =>
	renderToStaticMarkup(createElement(RowPanel, { row, docked, past, onClose: () => {} }));

describe("the explicit check in the inspector", () => {
	it("at a past position, the label says it runs today and the help says it runs on the vault as it is now", () => {
		for (const docked of [true, false]) {
			const html = panel(true, docked);
			expect(html).toContain('<div class="ut-lbl">today: Explicit check</div>');
			expect(html).toContain("on the vault as it is now");
		}
	});

	it("live, it carries neither", () => {
		for (const docked of [true, false]) {
			const html = panel(false, docked);
			expect(html).toContain('<div class="ut-lbl">Explicit check</div>');
			expect(html).not.toContain("today:");
			expect(html).not.toContain("as it is now");
		}
	});

	it("the verdict button and its text are the same in both views", () => {
		for (const html of [panel(true), panel(false)]) {
			expect(html).toContain("verify this transaction");
			expect(html).toContain(
				"Runs the usertrust-verify check for this transfer and prints its receipt.",
			);
		}
	});
});

describe("the page tells the inspector the position drawn, not the one in the address", () => {
	it("both RowPanel call sites pass past from list.at, so a #at that failed to load does not label a live screen as past", () => {
		const src = readFileSync(join(import.meta.dirname, "..", "src", "app", "app.tsx"), "utf8");
		const sites = src.match(/<RowPanel[\s\S]*?\/?>/g) ?? [];
		expect(sites).toHaveLength(2);
		for (const site of sites) {
			expect(site).toContain("past={list.at !== null}");
			expect(site).not.toContain("past={at !== null}");
		}
	});
});
