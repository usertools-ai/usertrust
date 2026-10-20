// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const TenantSchema = z.object({
	// Interpolated into a filesystem path (pool.ts vaultBase), so it must not be
	// able to escape stateDir — constrain to a safe, traversal-proof charset.
	id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	/** SHA-256 hex of the tenant's bearer key. Keys are never stored in plaintext. */
	keyHash: z.string().regex(/^[0-9a-f]{64}$/),
	budget: z.number().int().positive().optional(),
	tier: z.string().optional(),
	configPath: z.string().optional(),
});

/** The ledger's longest pending timeout: TigerBeetle's `Transfer.timeout` is a u32 count of seconds. */
const MAX_LEDGER_TIMEOUT_MS = 4_294_967_295_000;

const ServerConfigSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().int().min(1).max(65535).default(4519),
	stateDir: z.string().default(".usertrust-server"),
	enforcement: z.enum(["enforce", "evaluate_only"]).default("enforce"),
	pendingTtlMs: z.number().int().positive().default(300_000),
	/**
	 * The longest life an authorize may ask its hold for (`holdTtlMs`, capability `hold-ttl`), in ms:
	 * a request is clamped to [`pendingTtlMs`, this]. Unset means DEFAULT_MAX_PENDING_TTL_MS (one
	 * hour). At least core's default hold life (300 000), since every hold's ledger timeout is at
	 * least that. A longer one keeps a hold whose client crashed reserved for longer before the
	 * ledger voids it.
	 */
	maxPendingTtlMs: z.number().int().min(300_000).max(MAX_LEDGER_TIMEOUT_MS).optional(),
	dryRun: z.boolean().default(false),
	/**
	 * How long the start-up ledger probe waits for TigerBeetle to answer (ledger-probe.ts).
	 * Unset means DEFAULT_LEDGER_PROBE_TIMEOUT_MS. Not read in dryRun, which needs no ledger.
	 */
	ledgerProbeTimeoutMs: z.number().int().min(1_000).optional(),
	/**
	 * How long `POST /v1/authorize` waits for its governor and the ledger, and `GET /v1/budget` for
	 * the governor, before answering 503 `ledger_unavailable` (server.ts). Also the deadline past
	 * which an unanswered health probe reads `unreachable`. Unset means DEFAULT_LEDGER_TIMEOUT_MS.
	 * Not read in dryRun, which needs no ledger.
	 */
	ledgerTimeoutMs: z.number().int().min(100).optional(),
	/**
	 * Ledger reachability on `/v1/health` and `/v1/budget` (ledger-health.ts): `"child"` runs one
	 * observer child process per distinct ledger target; `"off"` runs none, and reports `unknown`.
	 * Unset means `"off"` for `createUsertrustServer()` (a library starts no background process its
	 * caller did not ask for) and `"child"` for the `usertrust-server` CLI. Not read in dryRun.
	 *
	 * With it unset (or `"off"`), an embedded server's `/v1/health` answers `ledger: "unknown"` and
	 * `ok: true` while its ledger is down: set `"child"` for health to report reachability.
	 */
	ledgerHealth: z.enum(["child", "off"]).optional(),
	/**
	 * How long a health observer child that exited, or failed to start, waits before it is started
	 * again, counted from its exit. Unset means 300 000 (five minutes).
	 */
	healthRespawnCooldownMs: z.number().int().min(100).optional(),
	tenants: z.array(TenantSchema).min(1),
});

/** `ledgerTimeoutMs` when the config leaves it unset. */
export const DEFAULT_LEDGER_TIMEOUT_MS = 5_000;

/** `maxPendingTtlMs` when the config leaves it unset: one hour. */
export const DEFAULT_MAX_PENDING_TTL_MS = 3_600_000;

/**
 * The longest life an authorize may ask for, as the server applies it everywhere (the clamp,
 * `/v1/health`'s `maxHoldTtlMs`, and each tenant's governor): `maxPendingTtlMs`, never less than
 * `pendingTtlMs`, in whole seconds (the ledger's timeout is in seconds). A config built without
 * the schema can lack either; then the default stands.
 */
export function maxHoldLife(config: {
	pendingTtlMs?: number | undefined;
	maxPendingTtlMs?: number | undefined;
}): number {
	const finite = (v: number | undefined) => (Number.isFinite(v) ? (v as number) : 0);
	// The configured ceiling rounded down to whole seconds, but never below the sweep life, which is
	// rounded UP: rounding it down would cap a hold below the life every hold already has.
	return Math.max(
		Math.floor((finite(config.maxPendingTtlMs) || DEFAULT_MAX_PENDING_TTL_MS) / 1000) * 1000,
		Math.ceil(finite(config.pendingTtlMs) / 1000) * 1000,
	);
}

export type TenantConfig = z.infer<typeof TenantSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function hashKey(key: string): string {
	return createHash("sha256").update(key, "utf-8").digest("hex");
}

export async function loadServerConfig(path: string): Promise<ServerConfig> {
	const raw = await readFile(path, "utf-8");
	const config = ServerConfigSchema.parse(JSON.parse(raw));
	const ids = new Set<string>();
	const keyHashes = new Set<string>();
	for (const tenant of config.tenants) {
		if (ids.has(tenant.id)) {
			throw new Error(`duplicate tenant id: ${tenant.id}`);
		}
		ids.add(tenant.id);
		// A duplicated keyHash would silently resolve to the last matching tenant
		// (resolveTenant keeps the last match), misrouting auth. Reject it.
		if (keyHashes.has(tenant.keyHash)) {
			throw new Error(`duplicate tenant keyHash: ${tenant.id}`);
		}
		keyHashes.add(tenant.keyHash);
	}
	return config;
}

/** Constant-time key lookup: hash the presented key, compare against every tenant. */
export function resolveTenant(config: ServerConfig, bearerKey: string): TenantConfig | null {
	const presented = Buffer.from(hashKey(bearerKey), "hex");
	let match: TenantConfig | null = null;
	for (const tenant of config.tenants) {
		const expected = Buffer.from(tenant.keyHash, "hex");
		if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
			match = tenant;
		}
	}
	return match;
}
