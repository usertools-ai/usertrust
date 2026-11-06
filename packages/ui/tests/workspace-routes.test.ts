// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { createUiServer, type UiServer } from "../src/server/server.js";
import { Workspace } from "../src/server/workspace.js";
import type { SettingsPayload } from "../src/shared/api.js";

const posix = process.platform !== "win32";

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

/**
 * Raw HTTP request: lets a test set Host and Origin, and send any method and body. A body is sent with its
 * content-length, unless `chunked` asks for chunked transfer encoding.
 */
function send(
	port: number,
	options: {
		method?: string;
		path: string;
		headers?: Record<string, string>;
		body?: string;
		chunked?: boolean;
	},
): Promise<Reply> {
	const headers: Record<string, string | number> = { ...options.headers };
	if (options.body !== undefined && options.chunked !== true) {
		headers["content-length"] = Buffer.byteLength(options.body);
	}
	return new Promise((resolvePromise, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () =>
					resolvePromise({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf-8"),
					}),
				);
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

/** Every file under `dir`, by relative path, with its sha256. */
function hashTree(dir: string, prefix = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) Object.assign(out, hashTree(full, rel));
		else out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
	}
	return out;
}

describe("settings routes", () => {
	let tempDir: string;
	let wsDir: string;
	let ui: UiServer | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-settings-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		wsDir = join(tempDir, "workspace");
		const writer = createAuditWriter(tempDir);
		for (let i = 0; i < 2; i++) {
			await writer.appendEvent({
				kind: "llm_call",
				actor: "local",
				data: { model: "claude-sonnet-4-6", cost: 5, settled: true, transferId: `tx_${i}` },
			});
		}
		writer.release();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function start(dir: string = wsDir): Promise<UiServer> {
		ui = await createUiServer(tempDir, { port: 0, workspaceDir: dir });
		return ui;
	}

	function settingsBytes(dir: string = wsDir): string | null {
		const file = join(dir, "settings.jsonl");
		return existsSync(file) ? readFileSync(file, "utf-8") : null;
	}

	function put(
		server: UiServer,
		body: string,
		headers: Record<string, string> = {},
		chunked = false,
	): Promise<Reply> {
		return send(server.port, {
			method: "PUT",
			path: "/api/settings",
			headers: {
				"content-type": "application/json",
				"x-usertrust-token": server.token,
				...headers,
			},
			body,
			chunked,
		});
	}

	async function getSettings(server: UiServer): Promise<SettingsPayload> {
		const res = await send(server.port, { path: "/api/settings" });
		expect(res.status).toBe(200);
		return JSON.parse(res.body) as SettingsPayload;
	}

	const valid = JSON.stringify({ key: "plan.monthlyUt", value: 500000 });

	it("session gives a 64-hex token", async () => {
		const server = await start();
		const res = await send(server.port, { path: "/api/session" });
		expect(res.status).toBe(200);
		const { token } = JSON.parse(res.body) as { token: string };
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(token).toBe(server.token);
		// Once per start: a second read gives the same token.
		const again = JSON.parse((await send(server.port, { path: "/api/session" })).body) as {
			token: string;
		};
		expect(again.token).toBe(token);
	});

	it("PUT without token is 403, and with a wrong token is 403", async () => {
		const server = await start();
		expect((await put(server, valid)).status).toBe(200);
		const before = settingsBytes();
		const without = await send(server.port, {
			method: "PUT",
			path: "/api/settings",
			headers: { "content-type": "application/json" },
			body: valid,
		});
		expect(without.status).toBe(403);
		expect(JSON.parse(without.body)).toEqual({ error: "missing or wrong token" });
		const wrong = await put(server, valid, { "x-usertrust-token": "0".repeat(64) });
		expect(wrong.status).toBe(403);
		expect(JSON.parse(wrong.body)).toEqual({ error: "missing or wrong token" });
		expect(settingsBytes()).toBe(before);
	});

	it("PUT with foreign Origin is 403, even with the right token", async () => {
		const server = await start();
		const res = await put(server, valid, { origin: "http://evil.example.com" });
		expect(res.status).toBe(403);
		expect(settingsBytes()).toBeNull();
	});

	it("PATCH /api/settings is 405; DELETE /api/settings is 405; POST /api/session is 405", async () => {
		const server = await start();
		const headers = { "x-usertrust-token": server.token, "content-type": "application/json" };
		for (const [method, path] of [
			["PATCH", "/api/settings"],
			["DELETE", "/api/settings"],
			["POST", "/api/session"],
			["OPTIONS", "/api/settings"],
		] as const) {
			const res = await send(server.port, { method, path, headers, body: valid });
			expect(res.status, `${method} ${path}`).toBe(405);
		}
		expect(settingsBytes()).toBeNull();
	});

	it("OPTIONS is 405 with no CORS headers, so a cross-origin preflight fails", async () => {
		const server = await start();
		const res = await send(server.port, {
			method: "OPTIONS",
			path: "/api/settings",
			headers: {
				origin: "http://evil.example.com",
				"access-control-request-method": "PUT",
				"access-control-request-headers": "x-usertrust-token, content-type",
			},
		});
		expect(res.status).toBe(405);
		expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
	});

	it("GET /api/session with a foreign Host is 403", async () => {
		const server = await start();
		const res = await send(server.port, {
			path: "/api/session",
			headers: { host: "evil.example.com" },
		});
		expect(res.status).toBe(403);
		expect(res.body).not.toContain(server.token);
	});

	it("/api/session has no-store and no CORS headers", async () => {
		const server = await start();
		const res = await send(server.port, {
			path: "/api/session",
			headers: { origin: `http://127.0.0.1:${server.port}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
	});

	it("token of the wrong length is 403", async () => {
		const server = await start();
		for (const token of ["a".repeat(10), "a".repeat(200)]) {
			const res = await put(server, valid, { "x-usertrust-token": token });
			expect(res.status, `length ${token.length}`).toBe(403);
		}
		expect(settingsBytes()).toBeNull();
	});

	it("PUT with extra fields is 400", async () => {
		const server = await start();
		const res = await put(
			server,
			JSON.stringify({ key: "plan.monthlyUt", value: 500000, at: "2020-01-01T00:00:00Z" }),
		);
		expect(res.status).toBe(400);
		expect(settingsBytes()).toBeNull();
		expect((await getSettings(server)).history).toEqual([]);
	});

	it("PUT with the token writes and GET reads it back", async () => {
		const server = await start();
		const res = await put(server, valid);
		expect(res.status).toBe(200);
		const written = JSON.parse(res.body) as SettingsPayload;
		expect(written.values["plan.monthlyUt"]).toBe(500000);
		const read = await getSettings(server);
		expect(read.values["plan.monthlyUt"]).toBe(500000);
		expect(read.values["people.rateUsdPerHour"]).toBeNull();
		expect(read.history).toHaveLength(1);
		expect(read.history[0]).toMatchObject({ key: "plan.monthlyUt", value: 500000 });
		expect(read.problem).toBeNull();
		// null unsets the value from now on, and is a dated entry of its own.
		const unset = await put(server, JSON.stringify({ key: "plan.monthlyUt", value: null }));
		expect(unset.status).toBe(200);
		const after = await getSettings(server);
		expect(after.values["plan.monthlyUt"]).toBeNull();
		expect(after.history).toHaveLength(2);
	});

	it("PUT bad key / NaN / text body is 400 / 400 / 415", async () => {
		const server = await start();
		expect((await put(server, JSON.stringify({ key: "plan.nope", value: 1 }))).status).toBe(400);
		expect((await put(server, '{"key":"plan.monthlyUt","value":NaN}')).status).toBe(400);
		expect(
			(await put(server, "key=plan.monthlyUt&value=1", { "content-type": "text/plain" })).status,
		).toBe(415);
		for (const body of [
			JSON.stringify({ key: "plan.monthlyUt", value: -1 }),
			JSON.stringify({ key: "plan.monthlyUt", value: "500" }),
			JSON.stringify({ key: "plan.monthlyUt" }),
			JSON.stringify([{ key: "plan.monthlyUt", value: 1 }]),
			"null",
			"",
		]) {
			expect((await put(server, body)).status, body).toBe(400);
		}
		expect(settingsBytes()).toBeNull();
	});

	it("PUT over 4 KB is 413, with a content-length and chunked", async () => {
		const server = await start();
		const big = JSON.stringify({ key: "plan.monthlyUt", value: 1, pad: "x".repeat(5000) });
		// The rest of the body is read and dropped before the 413, so the close is clean and the client always
		// reads the status; a reset would surface here as a rejected request, not a status.
		for (const chunked of [false, true]) {
			const res = await put(server, big, {}, chunked);
			expect(res.status, chunked ? "chunked" : "content-length").toBe(413);
			expect(res.headers.connection).toBe("close");
		}
		expect(settingsBytes()).toBeNull();
		// The server still answers after both.
		expect((await put(server, valid)).status).toBe(200);
	});

	it("a settings log that throws on read is a 500, and the server keeps serving", async () => {
		const server = await start();
		expect((await put(server, valid)).status).toBe(200);
		// A read that throws from inside the workspace (an I/O error, the file swapped mid-read): a file that is
		// merely the wrong kind is caught by the safety check first and never read, so this uses a seam.
		const eio = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
		const history = vi.spyOn(Workspace.prototype, "history").mockImplementation(() => {
			throw eio;
		});
		const get = await send(server.port, { path: "/api/settings" });
		expect(get.status).toBe(500);
		expect(JSON.parse(get.body)).toEqual({ error: "settings could not be read" });
		// A write whose read-back throws: saved, but the answer is the same 500.
		const written = await put(server, JSON.stringify({ key: "people.rateUsdPerHour", value: 90 }));
		expect(written.status).toBe(500);
		expect(JSON.parse(written.body)).toEqual({ error: "settings could not be read" });
		// The process is alive.
		expect((await send(server.port, { path: "/api/summary" })).status).toBe(200);
		history.mockRestore();
		expect((await getSettings(server)).history).toHaveLength(2);
	});

	it("an I/O failure on write is a 500 with a fixed message", async () => {
		const server = await start();
		const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
			code: "ENOSPC",
		});
		vi.spyOn(Workspace.prototype, "append").mockImplementation(() => {
			throw enospc;
		});
		const res = await put(server, valid);
		expect(res.status).toBe(500);
		expect(JSON.parse(res.body)).toEqual({ error: "settings could not be saved" });
		expect((await send(server.port, { path: "/api/summary" })).status).toBe(200);
	});

	it("an unknown api path is 404 and closes the connection, so the next request is not lost", async () => {
		const server = await start();
		const res = await send(server.port, {
			method: "POST",
			path: "/api/nope",
			headers: { "content-type": "application/json" },
			body: valid,
		});
		expect(res.status).toBe(404);
		expect(res.headers.connection).toBe("close");
		expect((await send(server.port, { path: "/api/session" })).status).toBe(200);
	});

	it("the vault directory is byte-identical after PUTs", async () => {
		const vault = join(tempDir, ".usertrust");
		const before = hashTree(vault);
		expect(Object.keys(before).length).toBeGreaterThan(0);
		const server = await start();
		expect((await put(server, valid)).status).toBe(200);
		expect(
			(await put(server, JSON.stringify({ key: "people.rateUsdPerHour", value: 120 }))).status,
		).toBe(200);
		expect((await put(server, JSON.stringify({ key: "plan.monthlyUt", value: null }))).status).toBe(
			200,
		);
		await getSettings(server);
		await server.close();
		ui = undefined;
		expect(hashTree(vault)).toEqual(before);
	});

	it("no route sets an anchor", async () => {
		const server = await start();
		const res = await put(server, JSON.stringify({ key: "anchor.publicKey", value: 1 }));
		expect(res.status).toBe(400);
		expect(settingsBytes()).toBeNull();
		expect(Object.keys((await getSettings(server)).values).sort()).toEqual([
			"people.rateUsdPerHour",
			"plan.monthlyUt",
		]);
	});

	it("settings off when the workspace would sit inside the vault", async () => {
		const inside = join(tempDir, ".usertrust", "ws");
		const vault = join(tempDir, ".usertrust");
		const before = hashTree(vault);
		const server = await start(inside);
		const read = await getSettings(server);
		expect(read.values).toEqual({ "plan.monthlyUt": null, "people.rateUsdPerHour": null });
		expect(read.history).toEqual([]);
		expect(read.problem).toMatch(/workspace would sit inside the vault/);
		const res = await put(server, valid);
		expect(res.status).toBe(409);
		expect(JSON.parse(res.body)).toEqual({ error: read.problem });
		expect(existsSync(inside)).toBe(false);
		expect(hashTree(vault)).toEqual(before);
		// The rest of the dashboard still serves.
		expect((await send(server.port, { path: "/api/summary" })).status).toBe(200);
	});

	it.skipIf(!posix)(
		"an unsafe workspace is not read or written: GET reports it, PUT is 409",
		async () => {
			mkdirSync(wsDir, { recursive: true });
			chmodSync(wsDir, 0o777);
			const server = await start();
			const read = await getSettings(server);
			expect(read.problem).toMatch(/mode 0777/);
			expect(read.values["plan.monthlyUt"]).toBeNull();
			const res = await put(server, valid);
			expect(res.status).toBe(409);
			expect((JSON.parse(res.body) as { error: string }).error).toContain(read.problem);
			expect(settingsBytes()).toBeNull();
		},
	);
});
