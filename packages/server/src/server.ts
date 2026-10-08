// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AbortOutcome, Authorization, ReleaseOutcome } from "usertrust";
import { sanitizeReleaseReason } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";
import { resolveTenant } from "./config.js";
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

/**
 * What this server honours beyond the base two-phase API, published on /v1/health
 * for a client that must not assume it. An older server's request schemas STRIP
 * unknown keys, so a `principal` it does not understand is dropped in silence and
 * the call is recorded as nobody's: a client checks this list before sending one.
 * A later capability is APPENDED here; the name and shape never change.
 * `hold-expiry`: an authorize answer carries `expiresInMs`, the hold's remaining life.
 * `release`: `POST /v1/release` gives a hold back without a failure: no circuit-breaker
 * failure, and a `hold_released` record rather than `llm_call_failed`.
 */
const SERVER_CAPABILITIES = Object.freeze([
	"principal",
	"authorize-cache-tiers",
	"hold-expiry",
	"release",
	// `job`: authorize accepts `job`/`jobState`/`usageFrom` and settle accepts
	// `usageTo` (and a `job`/`jobState` it must agree with). All recorded verbatim on
	// the audit records, none a pricing input, none selecting a wallet.
	"job",
]);
/**
 * A dryRun server has no ledger, so it writes no `user_data` tags — but it records
 * the principal on every audit record exactly as a ledger-backed server does, so it
 * honours the same list today. Kept as its own constant because a capability that
 * needs the ledger must be left out of it.
 */
const DRY_RUN_CAPABILITIES = Object.freeze([...SERVER_CAPABILITIES]);
const SWEEP_INTERVAL_MS = 30_000;
/** Max concurrent SSE streams a single tenant may hold open at once. */
const MAX_SSE_PER_TENANT = 8;
/** Drop an SSE subscriber whose kernel send buffer backs up past this. */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

interface PendingEntry {
	auth: Authorization;
	tenantId: string;
	/** When the authorize request arrived, in epoch ms: what an explicit `sweepExpired(now)` reads. */
	createdAt: number;
	/**
	 * The same moment on the MONOTONIC clock (`performance.now()`): what an authorize
	 * answers from and the server's own sweep reads (`monoAge`). Process-local; it never
	 * leaves the process. A later keyed replay (#205) must keep this field as it is, never
	 * overwrite it with its own request's. And it must answer from the LARGER of the
	 * hold's monotonic and wall-clock ages: the monotonic clock stops while the host
	 * sleeps, the ledger's timeout does not, and an answer given long after the hold began
	 * would otherwise state more life than the hold has.
	 */
	startedMono: number;
	/**
	 * The job labels this hold was AUTHORIZED with, kept by the server from its own
	 * parse of the authorize body: what a settle's `job` is checked against, and the
	 * floor of its `usageTo`. Never read from the handle, which is the caller's.
	 */
	labels: { job?: string; jobState?: "invalid"; usageFrom?: string };
}

/**
 * The longest a pending hold can still be pending once it is `ageMs` old, in whole ms,
 * never negative: the shorter of the server's own sweep (`pendingTtlMs`) and the
 * ledger's pending timeout (`auth.holdTimeoutMs`), less that age. Both lives count from
 * the request's arrival, which comes before the hold was reserved. No expiry ends the
 * hold sooner; a settle, a void or a server restart can.
 *
 * One rule, read at the hold's MONOTONIC age (`monoAge`), so no wall-clock step moves it:
 * - An authorize answers it as `expiresInMs`. The answer is a DURATION: a client on
 *   another machine adds it to its own clock reading taken before it sent the request,
 *   and gets a time no later than the hold's last moment whatever the offset between
 *   the two clocks.
 * - The server's own sweep ends the hold when it reaches 0. An explicit
 *   `sweepExpired(now)` reads the same rule at the wall-clock age `now` gives.
 *
 * Null when the life is UNKNOWN: a ledger-backed hold whose handle does not state the
 * ledger's timeout. Nothing is advertised then, so a client never reuses the hold, and
 * the sweep falls back to `pendingTtlMs` alone. In dry run there is no ledger hold, so
 * the sweep alone is the life.
 */
export function remainingLifeMs(
	auth: { holdTimeoutMs?: number | undefined },
	config: { pendingTtlMs: number; dryRun: boolean },
	ageMs: number,
): number | null {
	const ledger = auth.holdTimeoutMs;
	if (ledger === undefined && !config.dryRun) return null;
	const life = Math.min(config.pendingTtlMs, ledger ?? Number.POSITIVE_INFINITY);
	const left = Math.floor(life - ageMs);
	// Anything unusable reads as no life left: a client then never reuses the hold.
	return Number.isSafeInteger(left) && left > 0 ? left : 0;
}

/** The answer's `expiresInMs`, or nothing when the hold's life is unknown. */
function expiresIn(lifeMs: number | null): { expiresInMs?: number } {
	return lifeMs === null ? {} : { expiresInMs: lifeMs };
}

export interface UsertrustServer {
	listen(): Promise<{ port: number }>;
	close(): Promise<void>;
	readonly bus: EventBus;
	readonly pool: GovernorPool;
	pendingCount(): number;
	/**
	 * Release every pending hold whose life is spent (`remainingLifeMs`), or, for a hold
	 * of unknown life, that is `pendingTtlMs` old. With no argument (the server's own
	 * sweep), a hold's age is read on the monotonic clock (`monoAge`). An explicit `now`
	 * is epoch ms, read against each hold's arrival.
	 */
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
	/**
	 * A hold's age on the monotonic clock: what its authorize answer and the server's own
	 * sweep both read. No wall-clock step moves it, forward or back, so the sweep never
	 * ends a hold before the life it was advertised with. Declared: the monotonic clock
	 * does not count a host's sleep, which the ledger's timeout does. A hold of life L,
	 * aged a when a sleep of length D begins, keeps counting past its real end for
	 * min(D, L − a) after wake: at most one hold life, plus one sweep interval. Its budget
	 * stays reserved that long (a false denial, never an early void). From inside the
	 * process, a sleep and a forward wall-clock step look alike.
	 */
	const monoAge = (entry: PendingEntry): number => performance.now() - entry.startedMono;
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
		// The hold's clock starts NOW, before any ledger I/O this request causes: the
		// ledger's own pending timeout starts when the reserve commits, which is later.
		const createdAt = Date.now();
		const startedMono = performance.now();
		const governor = await pool.get(tenant);
		try {
			const auth = await governor.authorize(parsed.data);
			const entry: PendingEntry = {
				auth,
				tenantId: tenant.id,
				createdAt,
				startedMono,
				labels: {
					...(parsed.data.job === undefined ? {} : { job: parsed.data.job }),
					...(parsed.data.jobState === undefined ? {} : { jobState: parsed.data.jobState }),
					...(parsed.data.usageFrom === undefined ? {} : { usageFrom: parsed.data.usageFrom }),
				},
			};
			pending.set(auth.transferId, entry);
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
				...expiresIn(remainingLifeMs(auth, config, monoAge(entry))),
			});
		} catch (err) {
			const mapped = toHttpError(err);
			const shadow = config.enforcement === "evaluate_only" && mapped.status !== 500;
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
		const { transferId, job, jobState, ...usage } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// The record carries the AUTHORIZE capture's labels. A settle that names a
		// different job (or job state) is refused BEFORE the claim, so nothing is written
		// and the hold stays settleable. A legitimate client never trips this: it settles
		// a hold under the job the hold was authorized with.
		if (
			(job !== undefined && job !== entry.labels.job) ||
			(jobState !== undefined && jobState !== entry.labels.jobState)
		) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: "settle job differs from the hold's job",
			});
			return;
		}
		if (
			usage.usageTo !== undefined &&
			entry.labels.usageFrom !== undefined &&
			Date.parse(entry.labels.usageFrom) > Date.parse(usage.usageTo)
		) {
			sendJson(res, 400, { error: "bad_request", reason: "usageTo precedes the hold's usageFrom" });
			return;
		}
		// Atomic claim: first concurrent caller wins; a governor failure re-inserts
		// the entry so a transient settle error stays retryable.
		pending.delete(transferId);
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
		let outcome: AbortOutcome;
		try {
			const governor = await pool.get(tenant);
			outcome = await governor.abort(entry.auth, parsed.data.error);
		} catch (err) {
			pending.set(transferId, entry);
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		if (!outcome.aborted) {
			// Release's rule: the governor no longer held it, so this request aborted nothing
			// and must not say it did, and the entry stays out.
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		bus.publish(tenant.id, {
			type: "aborted",
			transferId,
			reason: parsed.data.error ?? "aborted",
			at: new Date().toISOString(),
		});
		sendJson(res, 200, {
			aborted: true,
			transferId,
			...(outcome.voidError === undefined ? {} : { voidError: outcome.voidError }),
		});
	}

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
		const { transferId, reason, releaseClass } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			// "unknown transferId", never "unknown route": a client that could not read this
			// server's capabilities falls back to /v1/abort only on an unknown route.
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// Abort's claim: the first caller wins, and a governor that THROWS puts the entry
		// back, so the release stays retryable.
		pending.delete(transferId);
		let outcome: ReleaseOutcome;
		try {
			const governor = await pool.get(tenant);
			outcome = await governor.release(entry.auth, reason, { releaseClass });
		} catch (err) {
			pending.set(transferId, entry);
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		if (!outcome.released) {
			// The governor no longer held it (its settle is in flight, or it already
			// ended), so this request released nothing and must not say it did. The entry
			// stays out: a hold the governor does not own is not the sweep's to meet again.
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		bus.publish(tenant.id, {
			type: "released",
			transferId,
			// What the chain recorded, by the governor's own rule: never the raw body.
			reason: sanitizeReleaseReason(reason),
			at: new Date().toISOString(),
		});
		sendJson(res, 200, {
			released: true,
			transferId,
			...(outcome.voidError === undefined ? {} : { voidError: outcome.voidError }),
		});
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
				capabilities: config.dryRun ? DRY_RUN_CAPABILITIES : SERVER_CAPABILITIES,
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
			else if (url === "/v1/abort") await handleAbort(tenant, body, res);
			else await handleRelease(tenant, body, res);
			return;
		}
		sendJson(res, 404, { error: "not_found", reason: "unknown route" });
	}

	/**
	 * End a hold the control plane gives up on itself (its life is spent, or the server
	 * is shutting down) through the governor's RELEASE terminal. Nothing failed, so it
	 * is no circuit-breaker failure and no `llm_call_failed` record (#238, #204).
	 * Answers what the governor did, or `undefined` when it could not be asked.
	 */
	async function releaseEntry(
		transferId: string,
		entry: PendingEntry,
		reason: string,
	): Promise<ReleaseOutcome | undefined> {
		const tenant = config.tenants.find((t) => t.id === entry.tenantId);
		if (tenant) {
			try {
				const governor = await pool.get(tenant);
				return await governor.release(entry.auth, reason);
			} catch {
				// Best-effort — the Governor's own destroy()/reconciliation voids
				// anything the control plane fails to release here.
			}
		}
		return undefined;
	}

	async function sweepExpired(now?: number): Promise<number> {
		// One rule for every sweep: a hold is due when the life it was advertised with is
		// spent at its age, so the ledger's timeout, when it comes before `pendingTtlMs`,
		// frees the hold's budget then. A hold of unknown life is due at `pendingTtlMs`.
		// The server's own sweep reads the monotonic age; an explicit `now` is epoch ms.
		const due = (entry: PendingEntry): boolean => {
			const age = now === undefined ? monoAge(entry) : now - entry.createdAt;
			const left = remainingLifeMs(entry.auth, config, age);
			return left === null ? age >= config.pendingTtlMs : left === 0;
		};
		let swept = 0;
		for (const [transferId, entry] of pending) {
			if (!due(entry)) continue;
			pending.delete(transferId);
			swept += 1;
			await releaseEntry(transferId, entry, "pending TTL expired");
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
			// Release every remaining pending hold (best-effort) so the control plane
			// and the ledger stay consistent; Governor.destroy() voids at the ledger
			// layer as the backstop.
			const remaining = [...pending.entries()];
			pending.clear();
			for (const [transferId, entry] of remaining) {
				const outcome = await releaseEntry(transferId, entry, "server shutdown");
				// Announced only when the governor says it released the hold: one it no
				// longer held, or could not be asked about, was not released here.
				if (outcome?.released !== true) continue;
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
