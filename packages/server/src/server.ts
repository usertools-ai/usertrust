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
import type { SettleRequest } from "./wire.js";
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
 * `cache-write-1h`: `POST /v1/settle` accepts `cacheWrite1hTokens`, the 1-hour share of
 * `cacheWriteTokens`, and prices it at the model's 1-hour write rate. Without it a client
 * must not send the field: an older server strips it and bills those tokens at the
 * cheaper 5-minute rate.
 */
const SERVER_CAPABILITIES = Object.freeze([
	"principal",
	"authorize-cache-tiers",
	"hold-expiry",
	"release",
	"cache-write-1h",
	// `job`: authorize accepts `job`/`jobState`/`usageFrom` and settle accepts
	// `usageTo` (and a `job`/`jobState` it must agree with). All recorded verbatim on
	// the audit records, none a pricing input, none selecting a wallet.
	"job",
	// `settle-unrecoverable`: `POST /v1/settle` for a transferId this server holds no hold for no
	// longer answers a bare 404 (and drops real provider spend): it answers `410
	// settlement_unrecoverable` (recorded on the chain, counted per tenant as
	// `settlementsUnrecoverable` on the authenticated /v1/budget), `409 already_settled` for a retry of a settle that went through in
	// this process, or `409 settle_in_progress`. BREAKING for a client that read every settle 404 the
	// same way; it checks this list before relying on the new codes (see the CHANGELOG).
	"settle-unrecoverable",
	// `refused`: `POST /v1/settle` accepts a per-tier `refused` flag (a figure the client refused to state as a count) and
	// charges the estimate when any tier is flagged. Without it a client must not send zeroed counts for a refused tier: an
	// older server strips the unknown key and would price the zeros at the floor.
	"refused",
]);
/**
 * A dryRun server has no ledger, so it writes no `user_data` tags — but it records
 * the principal on every audit record exactly as a ledger-backed server does, so it
 * honours the same list today. Kept as its own constant because a capability that
 * needs the ledger must be left out of it.
 */
const DRY_RUN_CAPABILITIES = Object.freeze([...SERVER_CAPABILITIES]);
const SWEEP_INTERVAL_MS = 30_000;
/**
 * How many settled transferIds the server remembers to tell a RETRY of a settle that went through
 * from a settle for a hold that is gone. In-process and bounded: the oldest is forgotten first, and a
 * restart forgets all of them. A retry past that memory reads as an unknown hold and is RECORDED as
 * `settlement_unrecoverable` (410): a duplicate record of spend the ledger did charge, never a lost
 * one. That is the declared residue of having no idempotency key.
 */
export const RECENTLY_SETTLED_MEMORY = 10_000;
/** How long a settle that finds its hold mid-release waits for the release before answering 409. */
const HELD_WAIT_MS = 2_000;
const HELD_POLL_MS = 50;
/** The longest a settle waits for the sweep's release to land: past the ledger's own pending timeout. */
const RELEASE_WAIT_MAX_MS = 30_000;
/** The longest transferId a settle for an UNKNOWN hold may carry: it is hashed into an audit event. */
const MAX_RECORDED_TRANSFER_ID = 256;
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

type TerminalKind = "settle" | "abort" | "release" | "sweep" | "shutdown";

const noop = (): void => {};

/** `claim` found the entry gone or replaced: another terminal owns it, and this caller ended nothing. */
const NOT_CLAIMED = Symbol("not-claimed");

export function createUsertrustServer(opts: {
	config: ServerConfig;
	factory?: GovernorFactory;
}): UsertrustServer {
	const { config } = opts;
	const bus = new EventBus();
	const pool = opts.factory ? new GovernorPool(config, opts.factory) : new GovernorPool(config);
	const pending = new Map<string, PendingEntry>();
	// `${tenantId}\0${transferId}` of settles that completed in this process (FIFO, bounded by
	// RECENTLY_SETTLED_MEMORY) and of settles in flight, so a concurrent or repeated settle is told
	// apart from one whose hold is gone.
	// The memory is PER TENANT, so one tenant's settles can never evict another's remembered ids.
	// id -> how its settle ended: "settled" (it posted) or "ambiguous" (the ledger post's outcome is
	// unknown: it may have charged). A Map keeps insertion order, so eviction is FIFO.
	const recentlySettled = new Map<string, Map<string, "settled" | "ambiguous">>();
	// `${tenantId}\0${transferId}` -> the terminal that took the hold out of `pending` and is still running:
	// a settle, an abort, a release, the TTL sweep or a shutdown. The governor still holds the hold until that
	// terminal lands, so a settle that finds it must wait for the terminal itself (bounded by the governor's
	// own void), not for a fixed window. `claim` is the ONLY code that removes an entry from `pending`, and it
	// registers the terminal here in the same synchronous step: a route that took an entry out on its own,
	// without registering, left a settle racing it nothing to wait on (it polled 2 s and answered a 409 the
	// plugin reads as "claimed", so the usage was never charged or recorded).
	const claimed = new Map<string, { kind: TerminalKind; done: Promise<void> }>();
	/**
	 * Take an entry out of `pending` and run its terminal, registering the terminal in `claimed` in the same
	 * step. The first caller wins (the entry is gone for every later one). With `restoreOnThrow`, a terminal that
	 * THROWS puts the entry back before `done` resolves, so the hold stays retryable and a waiter that wakes sees
	 * it. Every path that ends a hold goes through here: pinned by tests/claim.test.ts, which requires exactly one
	 * delete call on `pending` and no clear call in this file, comments aside.
	 * It refuses (NOT_CLAIMED) unless `entry` is STILL the one in `pending`: a caller holding a stale reference
	 * (shutdown's snapshot of `pending`, taken before awaits) must not claim an entry a client terminal already
	 * took, overwrite its registration, or, when its terminal throws, put the entry back into `pending` on a
	 * closing server. The check lives here so every caller is safe, not only today's routes.
	 */
	function claim<T>(
		tenantId: string,
		transferId: string,
		entry: PendingEntry,
		kind: TerminalKind,
		restoreOnThrow: boolean,
		work: () => Promise<T>,
	): Promise<T | typeof NOT_CLAIMED> {
		if (pending.get(transferId) !== entry) return Promise.resolve(NOT_CLAIMED);
		pending.delete(transferId);
		const key = `${tenantId}\0${transferId}`;
		const run = (async (): Promise<T> => {
			try {
				return await work();
			} catch (err) {
				if (restoreOnThrow) pending.set(transferId, entry);
				throw err;
			} finally {
				claimed.delete(key);
			}
		})();
		claimed.set(key, { kind, done: run.then(noop, noop) });
		return run;
	}

	// Per tenant, and served only on the authenticated /v1/budget: the unauthenticated /v1/health
	// must not tell anyone when some tenant's settles are being dropped.
	const settlementsUnrecoverable = new Map<string, number>();
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
			await handleUnheldSettle(tenant, transferId, usage, res);
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
		try {
			const claimedNow = await claim(tenant.id, transferId, entry, "settle", true, async () => {
				const governor = await pool.get(tenant);
				const receipt = await governor.settle(entry.auth, usage);
				// A settle that reached the ledger and did not confirm (`settled: false`, recorded as
				// ambiguous) may STILL have charged: its retry is told so (409 settlement_ambiguous), never
				// "the charge stands" and never "authorize again", which could charge the call twice.
				rememberSettled(tenant.id, transferId, receipt.settled === false ? "ambiguous" : "settled");
				bus.publish(tenant.id, {
					type: "settled",
					transferId,
					cost: receipt.cost,
					budgetRemaining: receipt.budgetRemaining,
					at: new Date().toISOString(),
				});
				sendJson(res, 200, receipt);
			});
			// Another terminal took the hold between the lookup and the claim: this is an unheld settle.
			if (claimedNow === NOT_CLAIMED) await handleUnheldSettle(tenant, transferId, usage, res);
		} catch (err) {
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
		}
	}

	function rememberSettled(
		tenantId: string,
		transferId: string,
		how: "settled" | "ambiguous",
	): void {
		let map = recentlySettled.get(tenantId);
		if (map === undefined) {
			map = new Map();
			recentlySettled.set(tenantId, map);
		}
		map.set(transferId, how);
		if (map.size > RECENTLY_SETTLED_MEMORY) {
			const oldest = map.keys().next().value;
			if (oldest !== undefined) map.delete(oldest);
		}
	}

	/**
	 * Answers (and returns true) when the id is NOT an unknown hold after all: a settle for it is in flight,
	 * it was settled in this process, or its entry is back in `pending` (a release or abort that claimed it
	 * threw and put it back). Checked before EVERY record and once more after the last one: a release or abort
	 * takes the entry out of `pending` under a non-settle terminal (see `claimed`), so a settle that arrived meanwhile must not
	 * write settlement_unrecoverable and answer 410 ("authorize again") for a charge that stands.
	 */
	function answerIfKnown(tenant: TenantConfig, transferId: string, res: ServerResponse): boolean {
		const key = `${tenant.id}\0${transferId}`;
		if (claimed.get(key)?.kind === "settle") {
			sendJson(res, 409, {
				error: "settle_in_progress",
				reason: "a settle for this transferId is in progress: retry shortly",
				transferId,
			});
			return true;
		}
		const earlier = recentlySettled.get(tenant.id)?.get(transferId);
		if (earlier === "ambiguous") {
			sendJson(res, 409, {
				error: "settlement_ambiguous",
				reason:
					"the first settle's ledger post was ambiguous: it may have charged. Do not authorize again to settle it; check the ledger",
				transferId,
			});
			return true;
		}
		if (earlier === "settled") {
			sendJson(res, 409, {
				error: "already_settled",
				reason: "this transferId was already settled: the charge stands",
				transferId,
			});
			return true;
		}
		const live = pending.get(transferId);
		if (live !== undefined && live.tenantId === tenant.id) {
			sendJson(res, 409, {
				error: "hold_active",
				reason: "the hold is live again (a release or abort did not complete): retry the settle",
				transferId,
			});
			return true;
		}
		return false;
	}

	/**
	 * A settle for a transferId this server holds no hold for. It used to be a bare 404, which dropped
	 * real provider spend the ledger would never charge. Now: a settle in flight or a retry of one that
	 * went through is a 409 (nothing recorded); anything else is RECORDED on the chain as
	 * `settlement_unrecoverable` and answers 410. The record moves no money and re-opens nothing; the
	 * client re-authorizes and settles to be charged.
	 */
	async function handleUnheldSettle(
		tenant: TenantConfig,
		transferId: string,
		usage: Omit<SettleRequest, "transferId" | "job" | "jobState">,
		res: ServerResponse,
	): Promise<void> {
		const key = `${tenant.id}\0${transferId}`;
		if (answerIfKnown(tenant, transferId, res)) return;
		// Only the RECORD of an unknown hold bounds the id (it is hashed into an audit event). The checks
		// above come first on purpose: a retry of an already-settled settle with a long id (a custom factory
		// may issue them for live holds) must still be told 409 already_settled / settlement_ambiguous, never
		// "names no hold here", which could send the client to re-authorize and charge twice.
		if (transferId.length > MAX_RECORDED_TRANSFER_ID) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: `transferId longer than ${MAX_RECORDED_TRANSFER_ID} characters names no hold here`,
			});
			return;
		}
		try {
			const governor = await pool.get(tenant);
			const record = () =>
				governor.recordUnheldSettlement({
					transferId,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					cacheWrite1hTokens: usage.cacheWrite1hTokens,
					refused: usage.refused,
					chunksDelivered: usage.chunksDelivered,
					usageSource: usage.usageSource,
					computeMs: usage.computeMs,
					usageTo: usage.usageTo,
				});
			// A settle racing a sweep, a client release or a client abort: it has taken the hold out of
			// `pending` and is ending it, and the governor still holds it until that lands. Wait for it
			// (bounded: it is one ledger void) and answer what the settle then IS (a recorded 410), so the
			// race ends as it did when the answer was a 404. Only a hold that is still held after the
			// wait is a 409 hold_active.
			// The terminal is awaited directly, however long the ledger void takes: a fixed
			// window would turn a slow void into a 409 that the plugin never retries, and the spend would be
			// neither charged nor recorded. The poll below covers any other path that leaves a hold held.
			const inFlight = claimed.get(key);
			// Bounded beyond the ledger's own timeout: a terminal that never settles must not hold the settle
			// forever (it then falls through to the poll, and at worst a 409 hold_active).
			if (inFlight !== undefined && inFlight.kind !== "settle") {
				await Promise.race([
					inFlight.done,
					new Promise<void>((resolve) => setTimeout(resolve, RELEASE_WAIT_MAX_MS).unref()),
				]);
			}
			if (answerIfKnown(tenant, transferId, res)) return;
			let outcome = await record();
			for (
				let waited = 0;
				outcome.outcome === "held" && waited < HELD_WAIT_MS;
				waited += HELD_POLL_MS
			) {
				await new Promise<void>((resolve) => setTimeout(resolve, HELD_POLL_MS));
				// The state can change while we wait (a failed release puts the entry back, a settle may
				// then charge it): recheck before each record.
				if (answerIfKnown(tenant, transferId, res)) return;
				outcome = await record();
			}
			if (outcome.outcome === "held") {
				sendJson(res, 409, {
					error: "hold_active",
					reason: "the governor still holds this transferId",
					transferId,
				});
				return;
			}
			// ... and once more after the last record: if the id turned out to be known meanwhile, the charge
			// stands, so the answer is that, never "not charged, authorize again".
			if (answerIfKnown(tenant, transferId, res)) return;
			if (outcome.recorded) {
				settlementsUnrecoverable.set(tenant.id, (settlementsUnrecoverable.get(tenant.id) ?? 0) + 1);
			}
			bus.publish(tenant.id, {
				type: "settlement_unrecoverable",
				transferId,
				recorded: outcome.recorded,
				at: new Date().toISOString(),
			});
			sendJson(res, 410, {
				error: "settlement_unrecoverable",
				reason:
					"no hold for this transferId here (swept, restarted or already settled): the settle is recorded, not charged. Authorize again and settle to be charged.",
				transferId,
				recorded: outcome.recorded,
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
		let outcome: AbortOutcome | typeof NOT_CLAIMED;
		try {
			outcome = await claim(tenant.id, transferId, entry, "abort", true, async () => {
				const governor = await pool.get(tenant);
				return governor.abort(entry.auth, parsed.data.error);
			});
		} catch (err) {
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		if (outcome === NOT_CLAIMED || !outcome.aborted) {
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
		let outcome: ReleaseOutcome | typeof NOT_CLAIMED;
		try {
			outcome = await claim(tenant.id, transferId, entry, "release", true, async () => {
				const governor = await pool.get(tenant);
				return governor.release(entry.auth, reason, { releaseClass });
			});
		} catch (err) {
			const mapped = toHttpError(err);
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		if (outcome === NOT_CLAIMED || !outcome.released) {
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
			sendJson(res, 200, {
				remaining: governor.budgetRemaining(),
				settlementsUnrecoverable: settlementsUnrecoverable.get(tenant.id) ?? 0,
			});
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
		kind: "sweep" | "shutdown",
		reason: string,
	): Promise<ReleaseOutcome | undefined> {
		const tenant = config.tenants.find((t) => t.id === entry.tenantId);
		if (tenant === undefined) {
			// No tenant to ask: the entry still leaves through `claim`, never on its own.
			await claim("", transferId, entry, kind, false, async () => undefined);
			return undefined;
		}
		const ended = await claim(
			tenant.id,
			transferId,
			entry,
			kind,
			false,
			async (): Promise<ReleaseOutcome | undefined> => {
				try {
					const governor = await pool.get(tenant);
					return await governor.release(entry.auth, reason);
				} catch {
					// Best-effort — the Governor's own destroy()/reconciliation voids
					// anything the control plane fails to release here.
					return undefined;
				}
			},
		);
		return ended === NOT_CLAIMED ? undefined : ended;
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
			swept += 1;
			await releaseEntry(transferId, entry, "sweep", "pending TTL expired");
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
			for (const [transferId, entry] of remaining) {
				const outcome = await releaseEntry(transferId, entry, "shutdown", "server shutdown");
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
