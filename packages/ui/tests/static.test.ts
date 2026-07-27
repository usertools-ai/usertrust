// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, type UiServer } from "../src/server/server.js";

describe("static SPA serving", () => {
	let tempDir: string;
	let appDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-static-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		appDir = join(tempDir, "app-dist");
		mkdirSync(join(appDir, "assets"), { recursive: true });
		writeFileSync(join(appDir, "index.html"), "<!doctype html><title>visual ledger</title>");
		writeFileSync(join(appDir, "assets", "app.js"), "console.log(1)");
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("serves index.html at /, assets by path, and index for unknown paths (SPA)", async () => {
		ui = await createUiServer(tempDir, { port: 0, appDir });
		const root = await fetch(`http://127.0.0.1:${ui.port}/`);
		expect(await root.text()).toContain("visual ledger");
		const asset = await fetch(`http://127.0.0.1:${ui.port}/assets/app.js`);
		expect(asset.headers.get("content-type")).toContain("javascript");
		const spa = await fetch(`http://127.0.0.1:${ui.port}/some/route`);
		expect(await spa.text()).toContain("visual ledger");
	});

	it("rejects path traversal", async () => {
		ui = await createUiServer(tempDir, { port: 0, appDir });
		const res = await fetch(`http://127.0.0.1:${ui.port}/..%2f..%2fetc%2fpasswd`);
		expect([200, 404]).toContain(res.status); // must be index.html or 404 — never file contents
		expect(await res.text()).not.toContain("root:");
	});
});
