// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Loopback-only HTTP server over a usertrust vault. Read-only except
 * POST /api/export. Non-API routes serve the prebuilt SPA. GET /api/tail
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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exportMarkdown, type PersistedAuditEvent, VAULT_DIR } from "usertrust";
import { canonicalize, verifyTransaction } from "usertrust-verify";
import { toLedgerRows } from "../shared/rows.js";
import { type LedgerState, loadState, ROW_CAP } from "./state.js";
import { serveStatic } from "./static.js";
import { watchLedger } from "./tail.js";

/** Amendment A5: maximum accepted /api/export request body, in bytes. */
const EXPORT_BODY_CAP = 64 * 1024;

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

export async function createUiServer(
	rootDir: string,
	opts?: { port?: number; appDir?: string },
): Promise<UiServer> {
	const vaultPath = join(rootDir, VAULT_DIR);
	// Compiled location is dist/server/ — the built SPA sits beside it in dist/app/.
	const appDir = opts?.appDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "app");
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
		if (url.pathname === "/api/export" && req.method === "POST") {
			// Amendment A5: JSON bodies only.
			const contentType = req.headers["content-type"];
			if (contentType === undefined || !contentType.toLowerCase().startsWith("application/json")) {
				sendJson(res, 415, { error: "content-type must be application/json" });
				return;
			}
			const chunks: Buffer[] = [];
			let received = 0;
			let overCap = false;
			req.on("data", (chunk: Buffer) => {
				if (overCap) return;
				received += chunk.length;
				// Amendment A5: cap the request body; flush the 413 before
				// destroying so the client reliably sees the status.
				if (received > EXPORT_BODY_CAP) {
					overCap = true;
					const payload = JSON.stringify({ error: "request body too large" });
					res.writeHead(413, {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(payload),
					});
					res.end(payload, () => req.destroy());
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (overCap) return;
				try {
					const raw = Buffer.concat(chunks).toString("utf-8");
					const body = JSON.parse(raw || "{}") as { outDir?: string };
					if (typeof body.outDir !== "string" || body.outDir.length === 0) {
						sendJson(res, 400, { error: "outDir required" });
						return;
					}
					const outDir = resolve(rootDir, body.outDir);
					// Amendment A5: containment — the resolved outDir must stay
					// inside the project root and out of the vault interior.
					const rootResolved = resolve(rootDir);
					const vaultResolved = resolve(vaultPath);
					const insideRoot = outDir === rootResolved || outDir.startsWith(rootResolved + sep);
					// Vault exclusion compares case-insensitively: on case-insensitive
					// filesystems (darwin/win32) ".USERTRUST" IS the vault. Folding only
					// the deny-side check widens the deny set, never the allow set.
					const outFolded = outDir.toLowerCase();
					const vaultFolded = vaultResolved.toLowerCase();
					const insideVault = outFolded === vaultFolded || outFolded.startsWith(vaultFolded + sep);
					if (!insideRoot || insideVault) {
						sendJson(res, 400, {
							error: "outDir must resolve inside the project root, outside the vault",
						});
						return;
					}
					sendJson(res, 200, exportMarkdown(vaultPath, outDir));
				} catch (err) {
					sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			});
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
		// Non-API routes: the prebuilt SPA, with index.html fallback for client routing.
		serveStatic(appDir, url.pathname, res);
	};

	const server = createServer(handler);
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(opts?.port ?? 4180, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	port = typeof address === "object" && address !== null ? address.port : 0;

	// Watch only once the bind succeeded — a failed bind must not leak an
	// fs.watch handle (createUiServer throws and close() is never reachable).
	const stopWatching = watchLedger(vaultPath, () => state.byteOffset, {
		onGrow: handleGrow,
		onResync: handleResync,
	});

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
