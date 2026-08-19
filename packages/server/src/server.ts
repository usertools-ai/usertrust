// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Authorization } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";
import { requestTimeoutOf, resolveTenant } from "./config.js";
import { withDeadline as withDeadlineMs } from "./deadline.js";
import { EventBus } from "./events.js";
import type { GovernorFactory } from "./pool.js";
import { GovernorPool } from "./pool.js";
import {
	AbortRequestSchema,
	AuthorizeRequestSchema,
	SettleRequestSchema,
	toHttpError,
} from "./wire.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SERVER_NAME = "usertrust-server";
/** Reported by /healthz — read from this package's own manifest so the
 * version can never drift from the published package again (Addendum D5). */
const SERVER_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string })
	.version;
const SWEEP_INTERVAL_MS = 30_000;
/** Max concurrent SSE streams a single tenant may hold open at once. */
const MAX_SSE_PER_TENANT = 8;
/** Drop an SSE subscriber whose kernel send buffer backs up past this. */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

interface PendingEntry {
	auth: Authorization;
	tenantId: string;
	createdAt: number;
}

export interface UsertrustServer {
	listen(): Promise<{ port: number }>;
	close(): Promise<void>;
	readonly bus: EventBus;
	readonly pool: GovernorPool;
	pendingCount(): number;
	sweepExpired(now?: number): Promise<number>;
}

export function createUsertrustServer(opts: {
	config: ServerConfig;
	factory?: GovernorFactory;
}): UsertrustServer {
	const { config } = opts;
	const bus = new EventBus();
	const pool = opts.factory ? new GovernorPool(config, opts.factory) : new GovernorPool(config);
	const pending = new Map<string, PendingEntry>();
	// Live SSE stream count per tenant id, enforcing MAX_SSE_PER_TENANT.
	const sseCounts = new Map<string, number>();
	let httpServer: Server | undefined;
	let sweeper: NodeJS.Timeout | undefined;

	function sendJson(res: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(payload),
		});
		res.end(payload);
	}

	function readBody(req: IncomingMessage): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					// Stop buffering and let the caller answer 413; destroying the
					// socket here would reset the connection before the response
					// can be flushed to the client.
					req.removeAllListeners("data");
					req.removeAllListeners("end");
					resolve(null);
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	/** Extract the bearer key. Empty or whitespace-only tokens are rejected before hashing. */
	function bearerKey(req: IncomingMessage): string | null {
		const header = req.headers.authorization;
		if (!header?.startsWith("Bearer ")) return null;
		const token = header.slice("Bearer ".length);
		if (token.trim() === "") return null;
		return token;
	}

	/**
	 * Bound a governor interaction so a stalled dependency cannot pin an HTTP
	 * request open forever.
	 *
	 * The ledger client this ultimately calls has no timeout of its own and retries
	 * an unreachable cluster indefinitely without ever rejecting, so "TigerBeetle is
	 * down" arrives here as a promise that simply never settles — indistinguishable,
	 * from the socket, from a governor that is merely slow. `usertrust-claude-code`
	 * resolves that ambiguity by failing CLOSED, which turns a dependency outage into
	 * a client that blocks every tool call. Answering 503 is the whole point: it is
	 * information, where a hang is not.
	 *
	 * The core-side `tigerbeetle.connectTimeoutMs` normally fires first and gives the
	 * far more useful `ledger_unavailable`; this is the backstop for every OTHER way a
	 * governor call can stall, including a cluster that dies AFTER the governor was
	 * built (which no construction-time deadline can see).
	 */
	const withDeadline = <T>(
		what: string,
		op: Promise<T>,
		onAbandoned?: (value: T) => void,
	): Promise<T> => withDeadlineMs(what, op, requestTimeoutOf(config), onAbandoned);

	async function handleAuthorize(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = AuthorizeRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: parsed.error.issues[0]?.message ?? "invalid",
			});
			return;
		}
		const governor = await withDeadline("pool.get", pool.get(tenant));
		try {
			const auth = await withDeadline("authorize", governor.authorize(parsed.data), (late) => {
				// The deadline abandoned this authorize, but the ledger did not: the hold
				// exists and its transferId reached nobody, so no client can ever settle or
				// abort it. AGENTS.md gives every hold exactly one terminal outcome and makes
				// no exception for "the server stopped waiting" — without this, each timed-out
				// authorize permanently retires part of the tenant's budget, and a retry loop
				// against a slow ledger exhausts it while every request reports a timeout.
				const reason = "authorize abandoned after server deadline";
				void governor
					.abort(late, reason)
					.then(() => {
						bus.publish(tenant.id, {
							type: "aborted",
							transferId: late.transferId,
							reason,
							at: new Date().toISOString(),
						});
					})
					.catch(() => {
						// Best-effort, like the sweeper's abortEntry: the governor's own
						// destroy()/pending reconciliation voids whatever is left.
					});
			});
			pending.set(auth.transferId, { auth, tenantId: tenant.id, createdAt: Date.now() });
			bus.publish(tenant.id, {
				type: "authorized",
				transferId: auth.transferId,
				model: auth.model,
				estimatedCost: auth.estimatedCost,
				at: new Date().toISOString(),
			});
			sendJson(res, 200, {
				transferId: auth.transferId,
				estimatedCost: auth.estimatedCost,
				model: auth.model,
				createdAt: auth.createdAt,
			});
		} catch (err) {
			const mapped = toHttpError(err);
			// Shadow mode reports what enforcement WOULD have decided, so it may only
			// swallow governance verdicts (4xx). Infrastructure failures must stay
			// failures: this read `!== 500` until `ledger_unavailable` and
			// `governor_timeout` started answering 503, at which point a ledger outage
			// would have been reported to the caller as a clean 200 "would_deny" — a
			// dependency outage laundered into a policy opinion.
			const shadow = config.enforcement === "evaluate_only" && mapped.status < 500;
			bus.publish(tenant.id, {
				type: "denied",
				error: mapped.body.error,
				reason: mapped.body.reason,
				shadow,
				at: new Date().toISOString(),
			});
			if (shadow) {
				// Shadow ids are NOT transferIds: no reservation exists, so they can
				// never be settled or aborted (those routes 404 on unknown ids).
				sendJson(res, 200, {
					shadow: true,
					shadowId: `shadow_${randomUUID()}`,
					decision: "would_deny",
					reason: mapped.body.reason,
				});
				return;
			}
			sendJson(res, mapped.status, mapped.body);
		}
	}

	async function handleSettle(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = SettleRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, { error: "bad_request", reason: "invalid settle request" });
			return;
		}
		const { transferId, ...usage } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// Atomic claim: first concurrent caller wins; a governor failure re-inserts
		// the entry so a transient settle error stays retryable.
		pending.delete(transferId);
		try {
			const governor = await withDeadline("pool.get", pool.get(tenant));
			// NOT deadlined: a timed-out settle has an UNKNOWN outcome on the money path
			// (the post may land in the ledger afterwards), and the catch below re-inserts
			// the pending entry to keep it retryable — so timing out here would invite a
			// double-settle. Governor CONSTRUCTION above is bounded because it has no such
			// ambiguity: a governor either exists or it does not.
			const receipt = await governor.settle(entry.auth, usage);
			bus.publish(tenant.id, {
				type: "settled",
				transferId,
				cost: receipt.cost,
				budgetRemaining: receipt.budgetRemaining,
				at: new Date().toISOString(),
			});
			sendJson(res, 200, receipt);
		} catch (err) {
			pending.set(transferId, entry);
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
		}
	}

	async function handleAbort(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = AbortRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, { error: "bad_request", reason: "invalid abort request" });
			return;
		}
		const { transferId } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// Atomic claim with re-insert on failure (same contract as settle).
		pending.delete(transferId);
		try {
			const governor = await withDeadline("pool.get", pool.get(tenant));
			// Not deadlined, for the same reason as settle: an abort that timed out may
			// still void the hold.
			await governor.abort(entry.auth, parsed.data.error);
		} catch (err) {
			pending.set(transferId, entry);
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		bus.publish(tenant.id, {
			type: "aborted",
			transferId,
			reason: parsed.data.error ?? "aborted",
			at: new Date().toISOString(),
		});
		sendJson(res, 200, { aborted: true, transferId });
	}

	function handleEvents(tenant: TenantConfig, req: IncomingMessage, res: ServerResponse): void {
		// Per-tenant fan-out cap: a tenant opening unbounded SSE streams would pin
		// memory and file descriptors. Reject past the cap; the slot is released
		// when the connection closes (below).
		const active = sseCounts.get(tenant.id) ?? 0;
		if (active >= MAX_SSE_PER_TENANT) {
			sendJson(res, 429, { error: "too_many_streams", reason: "SSE subscriber limit reached" });
			return;
		}
		sseCounts.set(tenant.id, active + 1);
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			const remaining = (sseCounts.get(tenant.id) ?? 1) - 1;
			if (remaining <= 0) sseCounts.delete(tenant.id);
			else sseCounts.set(tenant.id, remaining);
		};

		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		// SSE is best-effort operational telemetry — a broken pipe drops the
		// subscriber, it never breaks governance processing.
		const unsubscribe = bus.subscribe(tenant.id, (event) => {
			try {
				const ok = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				// Backpressure guard: a subscriber that cannot keep up (kernel send
				// buffer backed up past 1 MiB) is dropped rather than allowed to grow
				// unbounded. destroy() fires the close handler → unsubscribe + release.
				if (!ok && res.writableLength > MAX_SSE_BUFFER_BYTES) res.destroy();
			} catch {
				unsubscribe();
			}
		});
		const heartbeat = setInterval(() => {
			try {
				res.write(": heartbeat\n\n");
			} catch {
				clearInterval(heartbeat);
				unsubscribe();
			}
		}, 15_000);
		heartbeat.unref();
		req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
			release();
		});
	}

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";
		if (req.method === "GET" && url === "/v1/health") {
			sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
			return;
		}
		const key = bearerKey(req);
		const tenant = key ? resolveTenant(config, key) : null;
		if (!tenant) {
			sendJson(res, 401, { error: "unauthorized", reason: "missing or invalid bearer key" });
			return;
		}
		if (req.method === "GET" && url === "/v1/budget") {
			const governor = await withDeadline("pool.get", pool.get(tenant));
			sendJson(res, 200, { remaining: governor.budgetRemaining() });
			return;
		}
		if (req.method === "GET" && url === "/v1/events") {
			handleEvents(tenant, req, res);
			return;
		}
		if (
			req.method === "POST" &&
			(url === "/v1/authorize" || url === "/v1/settle" || url === "/v1/abort")
		) {
			const raw = await readBody(req);
			if (raw === null) {
				// The rest of the oversized body is never read — close the
				// connection after the response so the socket cannot be reused.
				res.setHeader("connection", "close");
				sendJson(res, 413, { error: "too_large", reason: "body exceeds 1 MiB" });
				return;
			}
			let body: unknown;
			try {
				body = JSON.parse(raw === "" ? "{}" : raw);
			} catch {
				sendJson(res, 400, { error: "bad_request", reason: "invalid JSON" });
				return;
			}
			if (url === "/v1/authorize") await handleAuthorize(tenant, body, res);
			else if (url === "/v1/settle") await handleSettle(tenant, body, res);
			else await handleAbort(tenant, body, res);
			return;
		}
		sendJson(res, 404, { error: "not_found", reason: "unknown route" });
	}

	async function abortEntry(
		transferId: string,
		entry: PendingEntry,
		reason: string,
	): Promise<void> {
		const tenant = config.tenants.find((t) => t.id === entry.tenantId);
		if (tenant) {
			try {
				const governor = await withDeadline("pool.get", pool.get(tenant));
				// Bounded, unlike the /v1/abort route. This path is best-effort by
				// construction (the catch below swallows) and it runs during shutdown and
				// the sweep, where close() awaits it BEFORE pool.destroyAll() — so a
				// stalled ledger here does not merely fail to void a hold, it prevents
				// teardown from ever reaching the governor destroy that would void it
				// anyway. The route keeps its unbounded abort because there a caller is
				// waiting to be told the outcome; nobody is waiting here.
				await withDeadline("abort", governor.abort(entry.auth, reason));
			} catch {
				// Best-effort — the Governor's own destroy()/reconciliation voids
				// anything the control plane fails to abort here.
			}
		}
	}

	async function sweepExpired(now: number = Date.now()): Promise<number> {
		let swept = 0;
		for (const [transferId, entry] of pending) {
			if (now - entry.createdAt < config.pendingTtlMs) continue;
			pending.delete(transferId);
			swept += 1;
			await abortEntry(transferId, entry, "pending TTL expired");
			bus.publish(entry.tenantId, {
				type: "pending_expired",
				transferId,
				at: new Date().toISOString(),
			});
		}
		return swept;
	}

	return {
		bus,
		pool,
		pendingCount: () => pending.size,
		sweepExpired,
		listen(): Promise<{ port: number }> {
			return new Promise((resolve, reject) => {
				httpServer = createServer((req, res) => {
					route(req, res).catch((err: unknown) => {
						const mapped = toHttpError(err);
						if (!res.headersSent) sendJson(res, mapped.status, mapped.body);
					});
				});
				httpServer.on("error", reject);
				httpServer.listen(config.port, config.host, () => {
					sweeper = setInterval(() => {
						void sweepExpired();
					}, SWEEP_INTERVAL_MS);
					sweeper.unref();
					const address = httpServer?.address();
					const port = typeof address === "object" && address !== null ? address.port : config.port;
					resolve({ port });
				});
			});
		},
		async close(): Promise<void> {
			if (sweeper) clearInterval(sweeper);
			// Abort every remaining pending hold (best-effort) so the control plane
			// and the ledger stay consistent; Governor.destroy() voids at the ledger
			// layer as the backstop.
			const remaining = [...pending.entries()];
			pending.clear();
			for (const [transferId, entry] of remaining) {
				await abortEntry(transferId, entry, "server shutdown");
				bus.publish(entry.tenantId, {
					type: "aborted",
					transferId,
					reason: "server shutdown",
					at: new Date().toISOString(),
				});
			}
			await new Promise<void>((resolve) => {
				if (!httpServer) return resolve();
				httpServer.closeAllConnections();
				httpServer.close(() => resolve());
			});
			await pool.destroyAll();
		},
	};
}
