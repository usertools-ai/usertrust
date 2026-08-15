// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { createUiServer, type UiServer } from "../src/server/server.js";

/** Raw HTTP request helper — lets tests set forbidden headers (Host, Origin). */
function rawRequest(
	port: number,
	options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
	return new Promise((resolvePromise, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				headers: options.headers,
			},
			(res) => {
				res.resume();
				res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("usertrust-ui server", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-ui-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function seed(count: number): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (let i = 0; i < count; i++) {
			await writer.appendEvent({
				kind: "llm_call",
				actor: "local",
				data: { model: "claude-sonnet-4-6", cost: 5, settled: true, transferId: `tx_${i}` },
			});
		}
		writer.release();
	}

	it("serves summary with budget, spend, and chain verdict", async () => {
		await seed(3);
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await fetch(`http://127.0.0.1:${ui.port}/api/summary`);
		expect(res.status).toBe(200);
		const summary = (await res.json()) as {
			spentUt: number;
			chain: { events: number; valid: boolean };
			anchorFile: string;
			rowCount: number;
			truncated: boolean;
		};
		expect(summary.spentUt).toBe(15);
		expect(summary.chain).toMatchObject({ events: 3, valid: true });
		expect(summary.anchorFile).toBe("absent");
		expect(summary.rowCount).toBe(3);
		expect(summary.truncated).toBe(false);
	});

	it("serves flattened rows", async () => {
		await seed(2);
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await fetch(`http://127.0.0.1:${ui.port}/api/events`);
		const { rows } = (await res.json()) as {
			rows: Array<{ transferId: string; provider: string; integrity: string }>;
		};
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			transferId: "tx_0",
			provider: "anthropic",
			integrity: "verified",
		});
	});

	it("404s unknown api routes and serves an empty vault", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		expect((await fetch(`http://127.0.0.1:${ui.port}/api/nope`)).status).toBe(404);
		const { rows } = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: unknown[];
		};
		expect(rows).toEqual([]);
	});

	it("sets X-Content-Type-Options: nosniff on every response", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const ok = await fetch(`http://127.0.0.1:${ui.port}/api/summary`);
		expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
		const missing = await fetch(`http://127.0.0.1:${ui.port}/api/nope`);
		expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("403s requests with a non-loopback Host header (DNS-rebinding guard)", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const rebound = await rawRequest(ui.port, {
			path: "/api/summary",
			headers: { host: "evil.example.com" },
		});
		expect(rebound.status).toBe(403);
		const withPort = await rawRequest(ui.port, {
			path: "/api/summary",
			headers: { host: `evil.example.com:${ui.port}` },
		});
		expect(withPort.status).toBe(403);
		const localhost = await rawRequest(ui.port, {
			path: "/api/summary",
			headers: { host: `localhost:${ui.port}` },
		});
		expect(localhost.status).toBe(200);
	});

	it("403s cross-origin POSTs; same-origin and origin-less POSTs pass the guard", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const cross = await rawRequest(ui.port, {
			method: "POST",
			path: "/api/anything",
			headers: { host: `127.0.0.1:${ui.port}`, origin: "http://evil.example.com" },
		});
		expect(cross.status).toBe(403);
		// Same-origin and origin-less POSTs reach routing (404 — no POST routes yet).
		const sameOrigin = await rawRequest(ui.port, {
			method: "POST",
			path: "/api/anything",
			headers: { host: `127.0.0.1:${ui.port}`, origin: `http://127.0.0.1:${ui.port}` },
		});
		expect(sameOrigin.status).toBe(404);
		const originless = await rawRequest(ui.port, {
			method: "POST",
			path: "/api/anything",
			headers: { host: `127.0.0.1:${ui.port}` },
		});
		expect(originless.status).toBe(404);
	});
});
