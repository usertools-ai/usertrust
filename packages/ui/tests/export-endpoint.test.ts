// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { CLOSE_GRACE_MS, createUiServer, type UiServer } from "../src/server/server.js";

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

	describe("close()", () => {
		const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

		it("lets an export still receiving its body at close() complete", async () => {
			ui = await createUiServer(tempDir, { port: 0 });
			const body = JSON.stringify({ outDir: "in-flight-out" });
			const cut = Math.floor(body.length / 2);
			const result = await new Promise<{
				status: number;
				text: string;
				connection: string | undefined;
			}>((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port: ui?.port,
						path: "/api/export",
						method: "POST",
						headers: {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(body),
						},
					},
					(res) => {
						let text = "";
						res.setEncoding("utf8");
						res.on("data", (chunk: string) => {
							text += chunk;
						});
						res.on("end", () =>
							resolve({
								status: res.statusCode ?? 0,
								text,
								connection: res.headers.connection,
							}),
						);
					},
				);
				req.on("error", reject);
				req.write(body.slice(0, cut));
				void (async () => {
					await sleep(50);
					const closing = ui?.close();
					await sleep(50);
					req.end(body.slice(cut));
					await closing;
					ui = undefined;
				})().catch(reject);
			});
			expect(result.status).toBe(200);
			expect(result.connection).toBe("close");
			expect((JSON.parse(result.text) as { written: number }).written).toBe(1);
			expect(existsSync(join(tempDir, "in-flight-out", "Receipts.base"))).toBe(true);
		});

		it("refuses a request whose headers arrive on a kept-alive socket after close() was called", async () => {
			ui = await createUiServer(tempDir, { port: 0 });
			const socket = connect(ui.port, "127.0.0.1");
			await new Promise<void>((r) => socket.once("connect", () => r()));
			let received = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				received += chunk;
			});
			socket.on("error", () => undefined);
			const host = `Host: 127.0.0.1:${ui.port}`;
			socket.write(`GET /api/summary HTTP/1.1\r\n${host}\r\n\r\n`);
			while (!received.includes("\r\n\r\n") || !received.includes("}")) await sleep(10);
			expect(received).toContain("HTTP/1.1 200");
			received = "";
			// The second request has begun (its first bytes are in), so the socket is not idle and close()
			// leaves it open for the grace; its headers finish after close().
			const body = JSON.stringify({ outDir: "after-close-out" });
			socket.write(`POST /api/export HTTP/1.1\r\n${host}\r\n`);
			await sleep(50);
			const closing = ui.close();
			await sleep(50);
			socket.write(
				"Content-Type: application/json\r\n" +
					`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
			await closing;
			ui = undefined;
			await new Promise<void>((r) => (socket.destroyed ? r() : socket.once("close", () => r())));
			expect(received).toContain("HTTP/1.1 503");
			expect(received.toLowerCase()).toContain("connection: close");
			expect(received.toLowerCase()).toContain("x-content-type-options: nosniff");
			expect(received).toContain('{"error":"server closing"}');
			expect(existsSync(join(tempDir, "after-close-out"))).toBe(false);
		});

		it("cuts a request still open after the grace, so close() is held no longer than that", async () => {
			ui = await createUiServer(tempDir, { port: 0 });
			const socket = connect(ui.port, "127.0.0.1");
			await new Promise<void>((r) => socket.once("connect", () => r()));
			socket.on("error", () => undefined);
			socket.write(
				`POST /api/export HTTP/1.1\r\nHost: 127.0.0.1:${ui.port}\r\n` +
					"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
			);
			await sleep(50);
			const started = Date.now();
			await ui.close();
			const elapsedMs = Date.now() - started;
			ui = undefined;
			socket.destroy();
			expect(elapsedMs).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 100);
			expect(elapsedMs).toBeLessThan(CLOSE_GRACE_MS + 600);
		});

		it("the timer that cuts connections is unref'd, so it never keeps the process alive", async () => {
			ui = await createUiServer(tempDir, { port: 0 });
			const socket = connect(ui.port, "127.0.0.1");
			await new Promise<void>((r) => socket.once("connect", () => r()));
			socket.on("error", () => undefined);
			socket.write(
				`POST /api/export HTTP/1.1\r\nHost: 127.0.0.1:${ui.port}\r\n` +
					"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
			);
			await sleep(50);
			// The request is still open, so the timer is pending when close() returns: hasRef() is only
			// meaningful before the timer is cleared (a cleared timer reports no ref either way).
			const created: Array<{ ms: unknown; timer: NodeJS.Timeout }> = [];
			const realSetTimeout = globalThis.setTimeout;
			const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
				fn: () => void,
				ms?: number,
			) => {
				const timer = realSetTimeout(fn, ms);
				created.push({ ms, timer });
				return timer;
			}) as unknown as typeof setTimeout);
			let closing: Promise<void> | undefined;
			try {
				closing = ui.close();
			} finally {
				spy.mockRestore();
			}
			const grace = created.filter((c) => c.ms === CLOSE_GRACE_MS);
			expect(grace).toHaveLength(1);
			expect(grace[0]?.timer.hasRef()).toBe(false);
			await closing;
			ui = undefined;
			socket.destroy();
		});

		it("resolves without waiting for the grace when nothing is open", async () => {
			ui = await createUiServer(tempDir, { port: 0 });
			const started = Date.now();
			await ui.close();
			const elapsedMs = Date.now() - started;
			ui = undefined;
			expect(elapsedMs).toBeLessThan(CLOSE_GRACE_MS / 2);
		});

		it("does not cut connections after the grace once every connection ended on its own", async () => {
			ui = await createUiServer(tempDir, { port: 0 });
			const cutAll = vi.spyOn(ui.server, "closeAllConnections");
			await ui.close();
			ui = undefined;
			await sleep(CLOSE_GRACE_MS + 150);
			expect(cutAll).not.toHaveBeenCalled();
		});
	});
});
