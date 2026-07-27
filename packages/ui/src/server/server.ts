// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Loopback-only HTTP server over a usertrust vault. Read-only except
 * POST /api/export. Static SPA assets are wired in Task 14. GET /api/tail
 * streams SSE: appended events are incrementally verified (linkage AND a
 * full hash recompute via usertrust-verify's canonicalize); any mismatch,
 * parse failure, or file shrink triggers a full reload + `resync` event.
 *
 * Hardening (Amendment A3): every response carries
 * `X-Content-Type-Options: nosniff`; requests whose Host header is not the
 * bound loopback host:port are 403'd (DNS-rebinding guard); POSTs with a
 * foreign Origin header are 403'd (CSRF guard).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { type PersistedAuditEvent, VAULT_DIR } from "usertrust";
import { canonicalize, verifyTransaction } from "usertrust-verify";
import { toLedgerRows } from "../shared/rows.js";
import { type LedgerState, ROW_CAP, loadState } from "./state.js";
import { watchLedger } from "./tail.js";

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

	const clients = new Set<ServerResponse>();

	function broadcast(eventName: string, data: unknown): void {
		const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of clients) client.write(frame);
	}

	function handleGrow(): void {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		try {
			const buf = readFileSync(logPath);
			const appended = buf.subarray(state.byteOffset);
			// Amendment A4: process only complete newline-terminated lines — hold
			// a partial tail back and let the next watch tick deliver the rest.
			const lastNewline = appended.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			const complete = appended.subarray(0, lastNewline + 1).toString("utf-8");
			const lines = complete.split("\n").filter((l) => l.trim());
			const fresh: PersistedAuditEvent[] = [];
			let lastHash = state.lastHash;
			for (const line of lines) {
				const e = JSON.parse(line) as PersistedAuditEvent;
				if (e.previousHash !== lastHash) throw new Error("linkage mismatch");
				// Amendment A4: linkage alone doesn't catch forged payloads —
				// recompute the hash exactly as usertrust-verify does.
				const { hash, ...rest } = e;
				const computed = createHash("sha256").update(canonicalize(rest)).digest("hex");
				if (computed !== hash) throw new Error("hash mismatch");
				fresh.push(e);
				lastHash = e.hash;
			}
			const rows = toLedgerRows(fresh, { valid: true, breakIndex: null });
			state.rows.push(...rows);
			state.lastHash = lastHash;
			state.byteOffset += lastNewline + 1;
			for (const r of rows) {
				if (r.kind === "llm_call" && r.costUt !== undefined) state.summary.spentUt += r.costUt;
			}
			state.summary.remainingUt = state.summary.budget - state.summary.spentUt;
			state.summary.chain.events += fresh.length;
			// Amendment A4: enforce ROW_CAP after append.
			if (state.rows.length > ROW_CAP) {
				state.rows.splice(0, state.rows.length - ROW_CAP);
				state.summary.truncated = true;
			}
			state.summary.rowCount = state.rows.length;
			broadcast("rows", rows);
			broadcast("summary", state.summary);
		} catch {
			handleResync();
		}
	}

	function handleResync(): void {
		state = loadState(vaultPath);
		broadcast("resync", {});
		broadcast("summary", state.summary);
	}

	const stopWatching = watchLedger(vaultPath, () => state.byteOffset, {
		onGrow: handleGrow,
		onResync: handleResync,
	});

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
		if (url.pathname === "/api/tail" && req.method === "GET") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(": connected\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (url.pathname.startsWith("/api/verify/") && req.method === "GET") {
			const txId = decodeURIComponent(url.pathname.slice("/api/verify/".length));
			const result = verifyTransaction(vaultPath, txId);
			sendJson(res, result.found ? 200 : 404, result);
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
			stopWatching();
			for (const c of clients) c.end();
			clients.clear();
			return new Promise((resolvePromise) => server.close(() => resolvePromise()));
		},
	};
}
