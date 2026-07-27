// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { type UiServer, createUiServer } from "../src/server/server.js";

describe("GET /api/verify/:txId", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-vtx-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { model: "claude-sonnet-4-6", cost: 5, settled: true, transferId: "tx_verify_me" },
		});
		writer.release();
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns a rendered receipt for a known transaction", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await fetch(`http://127.0.0.1:${ui.port}/api/verify/tx_verify_me`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { found: boolean; valid: boolean; receipt: string };
		expect(body.found).toBe(true);
		expect(body.valid).toBe(true);
		expect(body.receipt).toContain("U S E R T R U S T");
		expect(body.receipt).toContain("tx_verify_me");
	});

	it("404s an unknown transaction", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await fetch(`http://127.0.0.1:${ui.port}/api/verify/tx_nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { found: boolean };
		expect(body.found).toBe(false);
	});
});
