// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Loopback-only HTTP server over a usertrust vault. Read-only except
 * POST /api/export. Static SPA assets are wired in Task 14; SSE in Task 6.
 *
 * Hardening (Amendment A3): every response carries
 * `X-Content-Type-Options: nosniff`; requests whose Host header is not the
 * bound loopback host:port are 403'd (DNS-rebinding guard); POSTs with a
 * foreign Origin header are 403'd (CSRF guard).
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { VAULT_DIR } from "usertrust";
import { type LedgerState, loadState } from "./state.js";

export interface UiServer {
	server: Server;
	port: number;
	close(): Promise<void>;
	reload(): void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

export async function createUiServer(rootDir: string, opts?: { port?: number }): Promise<UiServer> {
	const vaultPath = join(rootDir, VAULT_DIR);
	let state: LedgerState = loadState(vaultPath);
	let port = 0;

	const handler = (req: IncomingMessage, res: ServerResponse): void => {
		// Amendment A3: on every response, including errors.
		res.setHeader("x-content-type-options", "nosniff");

		// Amendment A3: DNS-rebinding guard — only loopback Host headers.
		const host = req.headers.host;
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
			sendJson(res, 403, { error: "forbidden host" });
			return;
		}

		// Amendment A3: CSRF guard — reject POSTs carrying a foreign Origin.
		if (req.method === "POST") {
			const origin = req.headers.origin;
			if (
				origin !== undefined &&
				origin !== `http://127.0.0.1:${port}` &&
				origin !== `http://localhost:${port}`
			) {
				sendJson(res, 403, { error: "forbidden origin" });
				return;
			}
		}

		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		if (url.pathname === "/api/summary" && req.method === "GET") {
			sendJson(res, 200, state.summary);
			return;
		}
		if (url.pathname === "/api/events" && req.method === "GET") {
			sendJson(res, 200, { rows: state.rows });
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			sendJson(res, 404, { error: "not found" });
			return;
		}
		// Non-API routes: static SPA (Task 14). Until then, 404.
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("usertrust-ui");
	};

	const server = createServer(handler);
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(opts?.port ?? 4180, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		server,
		port,
		reload(): void {
			state = loadState(vaultPath);
		},
		close(): Promise<void> {
			return new Promise((resolvePromise) => server.close(() => resolvePromise()));
		},
	};
}
