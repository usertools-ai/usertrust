// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { type UiServer, createUiServer } from "../src/server/server.js";

describe("POST /api/export", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-exp-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 5 } });
		writer.release();
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function post(body: string, contentType = "application/json"): Promise<Response> {
		if (ui === undefined) throw new Error("server not started");
		return fetch(`http://127.0.0.1:${ui.port}/api/export`, {
			method: "POST",
			headers: { "content-type": contentType },
			body,
		});
	}

	it("exports markdown to the requested directory", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post(JSON.stringify({ outDir: "obsidian-out" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { written: number };
		expect(body.written).toBe(1);
		expect(existsSync(join(tempDir, "obsidian-out", "Receipts.base"))).toBe(true);
	});

	it("400s when outDir is missing", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post(JSON.stringify({}));
		expect(res.status).toBe(400);
	});

	it("415s a non-JSON content-type", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post("outDir=obsidian-out", "text/plain");
		expect(res.status).toBe(415);
	});

	it("413s a body larger than 64 KB", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post(JSON.stringify({ outDir: "x".repeat(70_000) }));
		expect(res.status).toBe(413);
	});

	it("400s an outDir that escapes the project root", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post(JSON.stringify({ outDir: "../../etc" }));
		expect(res.status).toBe(400);
		expect(existsSync(join(tempDir, "..", "..", "etc", "Receipts.base"))).toBe(false);
	});

	it("400s an outDir inside the vault", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post(JSON.stringify({ outDir: ".usertrust/exfil" }));
		expect(res.status).toBe(400);
		expect(existsSync(join(tempDir, ".usertrust", "exfil"))).toBe(false);
	});

	it("400s a case-variant vault path (case-insensitive filesystems)", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await post(JSON.stringify({ outDir: ".USERTRUST/exfil" }));
		expect(res.status).toBe(400);
		expect(existsSync(join(tempDir, ".usertrust", "exfil"))).toBe(false);
	});
});
