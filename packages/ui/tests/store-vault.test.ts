// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const store = readFileSync(join(import.meta.dirname, "..", "src", "app", "store.ts"), "utf-8");

describe("the store's rows and the vault they come from", () => {
	it("a resync marks the rows' vault unknown before it fetches, and the install sets it with the rows", () => {
		const fn = /const resync = \(\): void => \{([\s\S]*?)\n\t\t\};\n/.exec(store)?.[1] ?? "";
		expect(fn.length).toBeGreaterThan(50);
		const unknown = fn.search(/rowsVault: null/);
		const fetch = fn.indexOf("fetchAll()");
		expect(unknown).toBeGreaterThanOrEqual(0);
		expect(fetch).toBeGreaterThan(unknown);
		// The install: the same update that sets the rows sets the vault they come from.
		expect(fn).toMatch(/rows,\s*summary,\s*rowsVault: vault\b/);
	});

	it("frames never change the vault: no row, status or summary frame writes rowsVault", () => {
		const frames = store.slice(store.indexOf('source.addEventListener("rows"'));
		expect(frames).not.toMatch(/rowsVault/);
	});

	it("fetchAll builds the key from the boot and the epoch the snapshot carries", () => {
		expect(store).toMatch(/vault: vaultKey\(boot, epoch\)/);
		expect(store).not.toMatch(/snapshotEpoch|rowsEpoch/);
	});
});
