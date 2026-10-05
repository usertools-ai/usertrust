// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Authorization, Principal, SettleParams } from "usertrust";
import { AlreadySettledError, sanitizeReleaseReason } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";
import { MAX_PENDING_TTL_MS, resolveTenant, SWEEP_INTERVAL_MS } from "./config.js";
import { EventBus } from "./events.js";
import type { GovernorFactory } from "./pool.js";
import { GovernorPool } from "./pool.js";
import {
	AbortRequestSchema,
	AuthorizeRequestSchema,
	ReleaseRequestSchema,
	SettleRequestSchema,
	toHttpError,
} from "./wire.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SERVER_NAME = "usertrust-server";
/** Reported by /healthz — read from this package's own manifest so the
 * version can never drift from the published package again (Addendum D5). */
const SERVER_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string })
	.version;
/** Max concurrent SSE streams a single tenant may hold open at once. */
const MAX_SSE_PER_TENANT = 8;
/** Drop an SSE subscriber whose kernel send buffer backs up past this. */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
/**
 * The statuses a governance DECISION produces (policy 403, budget 402, anomaly 429)
 * — the only refusals `evaluate_only` turns into a shadow allow. A ledger outage
 * (503) or a key already charged (409) is not a decision to shadow: allowing it
 * would send a call ahead with no hold, or repeat one already paid for.
 */
const SHADOWABLE_STATUSES = new Set([402, 403, 429]);
/**
 * What this server honours beyond the base two-phase API, published on /v1/health
 * for a client that must not assume it. An older server's request schemas STRIP
 * unknown keys, so an `idempotencyKey` it does not understand is dropped in silence
 * — and a client that retried an ambiguous settle "safely" under its key would post
 * twice. A client checks this list before relying on any of these.
 */
const SERVER_CAPABILITIES = Object.freeze([
	"release",
	"idempotency-key",
	"principal",
	"settlement-unrecoverable",
]);

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
	// The loader's schema enforces this too; a config built in code skips the schema.
	if (config.pendingTtlMs > MAX_PENDING_TTL_MS) {
		throw new Error(
			`pendingTtlMs ${config.pendingTtlMs} must be at most ${MAX_PENDING_TTL_MS}: the sweep has to release a hold before the ledger expires it`,
		);
	}
	const bus = new EventBus();
	const pool = opts.factory ? new GovernorPool(config, opts.factory) : new GovernorPool(config);
	const pending = new Map<string, PendingEntry>();
	// Holds CLAIMED out of `pending` by a terminal that has not finished yet. A
	// keyed authorize replayed in that window gets the same handle back, and must
	// not re-insert it: the hold is being settled, aborted or released.
	const terminating = new Set<string>();
	// Late settles recorded as `settlement_unrecoverable` since this process
	// started — real spend no settle could charge. Reported on /v1/health.
	let settlementsUnrecoverable = 0;
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
		const governor = await pool.get(tenant);
		try {
			const auth = await governor.authorize(parsed.data);
			// A keyed replay answers with the SAME live hold. It is already pending (or
			// mid-terminal) here, so it neither restarts the TTL clock nor announces a
			// second hold that does not exist.
			if (!pending.has(auth.transferId) && !terminating.has(auth.transferId)) {
				pending.set(auth.transferId, { auth, tenantId: tenant.id, createdAt: Date.now() });
				bus.publish(tenant.id, {
					type: "authorized",
					transferId: auth.transferId,
					model: auth.model,
					estimatedCost: auth.estimatedCost,
					at: new Date().toISOString(),
				});
			}
			sendJson(res, 200, {
				transferId: auth.transferId,
				estimatedCost: auth.estimatedCost,
				model: auth.model,
				createdAt: auth.createdAt,
			});
		} catch (err) {
			const mapped = toHttpError(err);
			const shadow =
				config.enforcement === "evaluate_only" && SHADOWABLE_STATUSES.has(mapped.status);
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
		const { transferId, idempotencyKey, principal, ...usage } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			if (idempotencyKey !== undefined) {
				await handleUnheldSettle(tenant, transferId, { idempotencyKey, principal, usage }, res);
				return;
			}
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// Atomic claim: first concurrent caller wins; a governor failure re-inserts
		// the entry so a transient settle error stays retryable.
		pending.delete(transferId);
		terminating.add(transferId);
		try {
			const governor = await pool.get(tenant);
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
			if (err instanceof AlreadySettledError) {
				// NOT retryable: another hold already charged this key, and the
				// governor released this one. Re-inserting it would leave a hold the
				// ledger no longer has, waiting for a TTL sweep.
				bus.publish(tenant.id, {
					type: "released",
					transferId,
					reason: "already settled under this idempotency key",
					at: new Date().toISOString(),
				});
			} else {
				pending.set(transferId, entry);
			}
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
		} finally {
			terminating.delete(transferId);
		}
	}

	/**
	 * A keyed settle for a hold this server does not hold — its TTL released it, or
	 * the server restarted since it was authorized. Real spend no settle can charge
	 * any more must never vanish into a 404, so the governor records it:
	 *  - 410 `settlement_unrecoverable`: recorded on the tenant's chain, counted on
	 *    /v1/health, announced over SSE;
	 *  - 409 `already_settled`: the key's charge stands (a retry of a settle that
	 *    already landed);
	 *  - 409 `hold_active`: the key has a live hold here under another transferId,
	 *    which the response names.
	 */
	async function handleUnheldSettle(
		tenant: TenantConfig,
		transferId: string,
		late: {
			idempotencyKey: string;
			principal: Principal | undefined;
			usage: Pick<
				SettleParams,
				"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "usageSource"
			>;
		},
		res: ServerResponse,
	): Promise<void> {
		try {
			const governor = await pool.get(tenant);
			const found = await governor.recordUnheldSettlement({
				idempotencyKey: late.idempotencyKey,
				usage: late.usage,
				principal: late.principal,
			});
			if (found.outcome === "held") {
				// The tenant presented the key, so it may learn which of its holds the
				// key is on — and settle that one.
				sendJson(res, 409, {
					error: "hold_active",
					reason: "this idempotency key has a live hold: settle it by its own transferId",
					transferId: found.transferId,
				});
				return;
			}
			// An exact retry the governor had already recorded is answered the same way,
			// but is not a second loss: count and announce only what was recorded.
			if (found.recorded) {
				settlementsUnrecoverable += 1;
				bus.publish(tenant.id, {
					type: "settlement_unrecoverable",
					transferId,
					at: new Date().toISOString(),
				});
			}
			sendJson(res, 410, {
				error: "settlement_unrecoverable",
				reason:
					"the hold this settle names is gone and nothing was charged under its key; the usage is recorded. Authorize again under the same idempotencyKey and settle to charge it.",
			});
		} catch (err) {
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
		terminating.add(transferId);
		try {
			const governor = await pool.get(tenant);
			await governor.abort(entry.auth, parsed.data.error);
		} catch (err) {
			pending.set(transferId, entry);
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		} finally {
			terminating.delete(transferId);
		}
		bus.publish(tenant.id, {
			type: "aborted",
			transferId,
			reason: parsed.data.error ?? "aborted",
			at: new Date().toISOString(),
		});
		sendJson(res, 200, { aborted: true, transferId });
	}

	/**
	 * `/v1/release` — give a hold back without calling it a failure (#204). The same
	 * atomic claim and re-insert-on-failure contract as abort; only the meaning of
	 * the terminal differs: no circuit-breaker failure, `hold_released` on the chain.
	 */
	async function handleRelease(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = ReleaseRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, { error: "bad_request", reason: "invalid release request" });
			return;
		}
		const { transferId, reason } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		pending.delete(transferId);
		terminating.add(transferId);
		try {
			const governor = await pool.get(tenant);
			await governor.release(entry.auth, reason);
		} catch (err) {
			pending.set(transferId, entry);
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		} finally {
			terminating.delete(transferId);
		}
		bus.publish(tenant.id, {
			type: "released",
			transferId,
			// What the chain recorded, by the governor's own rule — never the raw body.
			reason: sanitizeReleaseReason(reason),
			at: new Date().toISOString(),
		});
		sendJson(res, 200, { released: true, transferId });
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
			sendJson(res, 200, {
				ok: true,
				name: SERVER_NAME,
				version: SERVER_VERSION,
				capabilities: SERVER_CAPABILITIES,
				// A count, never a tenant id or a key: this endpoint is unauthenticated.
				settlementsUnrecoverable,
			});
			return;
		}
		const key = bearerKey(req);
		const tenant = key ? resolveTenant(config, key) : null;
		if (!tenant) {
			sendJson(res, 401, { error: "unauthorized", reason: "missing or invalid bearer key" });
			return;
		}
		if (req.method === "GET" && url === "/v1/budget") {
			const governor = await pool.get(tenant);
			sendJson(res, 200, { remaining: governor.budgetRemaining() });
			return;
		}
		if (req.method === "GET" && url === "/v1/events") {
			handleEvents(tenant, req, res);
			return;
		}
		if (
			req.method === "POST" &&
			(url === "/v1/authorize" ||
				url === "/v1/settle" ||
				url === "/v1/abort" ||
				url === "/v1/release")
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
			else if (url === "/v1/release") await handleRelease(tenant, body, res);
			else await handleAbort(tenant, body, res);
			return;
		}
		sendJson(res, 404, { error: "not_found", reason: "unknown route" });
	}

	/**
	 * The TTL sweep's and shutdown's terminal: RELEASE, never abort. Neither is a
	 * failed call, and booking them as one recorded `llm_call_failed` and fed the
	 * circuit breaker — five expired holds in a row opened it on a healthy provider
	 * (#204).
	 */
	async function releaseEntry(entry: PendingEntry, reason: string): Promise<void> {
		const tenant = config.tenants.find((t) => t.id === entry.tenantId);
		if (tenant) {
			try {
				const governor = await pool.get(tenant);
				await governor.release(entry.auth, reason);
			} catch {
				// Best-effort — the Governor's own destroy()/reconciliation voids
				// anything the control plane fails to release here.
			}
		}
	}

	async function sweepExpired(now: number = Date.now()): Promise<number> {
		// CLAIM the whole due batch first, synchronously: from here no settle can reach
		// these holds (a late one takes the unheld path), so none of them can be POSTed
		// after the ledger's own timeout has expired it. Then release them CONCURRENTLY:
		// the batch takes about one release's latency however many holds expired
		// together, instead of one after another eating the margin MAX_PENDING_TTL_MS
		// leaves before that timeout.
		const due: Array<[string, PendingEntry]> = [];
		for (const [transferId, entry] of pending) {
			if (now - entry.createdAt < config.pendingTtlMs) continue;
			pending.delete(transferId);
			terminating.add(transferId);
			due.push([transferId, entry]);
		}
		await Promise.all(
			due.map(async ([transferId, entry]) => {
				try {
					await releaseEntry(entry, "pending TTL expired");
				} finally {
					terminating.delete(transferId);
				}
				bus.publish(entry.tenantId, {
					type: "pending_expired",
					transferId,
					at: new Date().toISOString(),
				});
			}),
		);
		return due.length;
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
			// Release every remaining pending hold (best-effort) so the control plane
			// and the ledger stay consistent; Governor.destroy() voids at the ledger
			// layer as the backstop. A shutdown is not a failed call.
			const remaining = [...pending.entries()];
			pending.clear();
			for (const [transferId, entry] of remaining) {
				await releaseEntry(entry, "server shutdown");
				bus.publish(entry.tenantId, {
					type: "released",
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
