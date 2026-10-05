// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_PENDING_TIMEOUT_SECONDS } from "usertrust";
import { z } from "zod";

/** How often the server sweeps pending holds older than `pendingTtlMs`. */
export const SWEEP_INTERVAL_MS = 30_000;

/**
 * The longest `pendingTtlMs` the sweep can honour. A hold is released by the first
 * sweep after its TTL, so up to one sweep interval late, and the ledger voids it on
 * its own at `DEFAULT_PENDING_TIMEOUT_SECONDS`. The release must land first: a
 * settle that reaches a hold the LEDGER already expired fails its POST and is
 * recorded only as ambiguous, while a settle after the release is recorded as
 * unrecoverable and counted (/v1/health) — the record the late settle is owed.
 */
export const MAX_PENDING_TTL_MS = DEFAULT_PENDING_TIMEOUT_SECONDS * 1000 - SWEEP_INTERVAL_MS - 1;

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

const ServerConfigSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().int().min(1).max(65535).default(4519),
	stateDir: z.string().default(".usertrust-server"),
	enforcement: z.enum(["enforce", "evaluate_only"]).default("enforce"),
	// Four minutes: a full sweep interval of margin under MAX_PENDING_TTL_MS.
	pendingTtlMs: z.number().int().positive().max(MAX_PENDING_TTL_MS).default(240_000),
	dryRun: z.boolean().default(false),
	tenants: z.array(TenantSchema).min(1),
});

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
