// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { createUiServer, type UiServer } from "../src/server/server.js";

/**
 * Sends a request line `fetch` cannot express. An absolute-form request target
 * (RFC 9112 §3.2.2) is only reachable over a raw socket: `fetch` always emits
 * origin-form, so no `fetch`-based test can cover the guard this exercises.
 * Rejects rather than hanging when the server writes nothing back — that
 * silence is exactly the pre-fix symptom, and a bare vitest timeout would not
 * say so.
 */
function rawRequest(port: number, raw: string, timeoutMs = 2000): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		let received = "";
		const socket = connect(port, "127.0.0.1", () => socket.write(raw));
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`no response within ${timeoutMs}ms (received ${JSON.stringify(received)})`));
		}, timeoutMs);
		socket.on("data", (chunk: Buffer) => {
			received += chunk.toString("utf-8");
			if (!received.includes("\r\n\r\n")) return;
			clearTimeout(timer);
			socket.destroy();
			resolvePromise(received);
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			socket.destroy();
			reject(err);
		});
	});
}

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

	it("returns 400 for malformed percent-encoding instead of crashing", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const res = await fetch(`http://127.0.0.1:${ui.port}/api/verify/%E0%A4%A`);
		expect(res.status).toBe(400);
		// The process must still be serving afterwards.
		const after = await fetch(`http://127.0.0.1:${ui.port}/api/tail`);
		expect(after.status).toBe(200);
	});

	// The `decodeURIComponent` guard above closes only the routed path. `new URL`
	// runs first, on `req.url` verbatim, and Node accepts an absolute-form request
	// target — so these never reach a route at all. The Host header is valid
	// loopback in every case: the header is independent of the target, which is
	// why the DNS-rebinding guard does not cover this.
	it.each(["http://foo:999999/", "http://%/", "http://[::1/"])(
		"400s an unparseable request target (%s) instead of crashing",
		async (target) => {
			ui = await createUiServer(tempDir, { port: 0 });
			const raw = await rawRequest(
				ui.port,
				`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${ui.port}\r\nConnection: close\r\n\r\n`,
			);
			expect(raw.startsWith("HTTP/1.1 400 ")).toBe(true);
			expect(raw).toContain("malformed request target");
			// The process must still be serving afterwards.
			const after = await fetch(`http://127.0.0.1:${ui.port}/api/summary`);
			expect(after.status).toBe(200);
		},
	);
});
