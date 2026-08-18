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

const ServerConfigSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().int().min(1).max(65535).default(4519),
	stateDir: z.string().default(".usertrust-server"),
	enforcement: z.enum(["enforce", "evaluate_only"]).default("enforce"),
	pendingTtlMs: z.number().int().positive().default(300_000),
	dryRun: z.boolean().default(false),
	// Ceiling on a single governor interaction. A governance server that HANGS is
	// strictly worse than one that errors: the caller cannot tell "slow" from
	// "dead", and usertrust-claude-code's PreToolUse hook fails CLOSED, so an
	// unbounded wait there is not a slow tool call but a blocked one
	// (usertools-ai/usertrust#130). Keep this comfortably ABOVE
	// tigerbeetle.connectTimeoutMs so a ledger outage surfaces as the specific
	// `ledger_unavailable` rather than as this generic timeout, and BELOW the
	// client's own timeout so the client sees a real 503 instead of giving up first.
	requestTimeoutMs: z.number().int().positive().default(10_000),
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
