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

export const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;

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
	// (usertools-ai/usertrust#130).
	//
	// The whole chain has to be MONOTONIC or the specific error loses a race to the
	// generic one, which is what happened at the first attempt at these numbers:
	//
	//   tigerbeetle.connectTimeoutMs (3s)  <  requestTimeoutMs (4s)
	//     <  the caller's HTTP timeout (5s in usertrust-claude-code)
	//     <  the caller's outer/process timeout (15s for that plugin's hook)
	//
	// Above connectTimeoutMs so a ledger outage reports as the actionable
	// `ledger_unavailable` rather than this generic timeout; below the caller's HTTP
	// timeout so the caller is still listening when either one arrives. Raising this
	// without raising the caller's timeout re-breaks the ordering silently.
	// OPTIONAL, not `.default()`. `ServerConfig` is this schema's inferred OUTPUT and
	// is the public argument type of `createUsertrustServer`/`GovernorPool`, so a
	// defaulted field becomes REQUIRED for every TypeScript caller — adding it would
	// break existing object literals with TS2741 rather than defaulting them. The
	// default lives in `requestTimeoutOf` instead, which is one place, applies to
	// hand-built and file-loaded configs alike, and cannot drift from the type.
	requestTimeoutMs: z.number().int().positive().optional(),
	tenants: z.array(TenantSchema).min(1),
});

export type TenantConfig = z.infer<typeof TenantSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * The request deadline, for a config that may not have come through
 * {@link ServerConfigSchema}.
 *
 * `createUsertrustServer` and `GovernorPool` are both exported, so a caller can
 * hand either one a hand-built config object — including one written before
 * `requestTimeoutMs` existed. Only `loadServerConfig` applies the schema defaults.
 * `setTimeout(fn, undefined)` fires on the next tick, so without this every
 * request from such a caller would answer an instant `governor_timeout`: adding
 * the field would have BROKEN the programmatic path rather than defaulting it.
 */
export function requestTimeoutOf(config: ServerConfig): number {
	const value = config.requestTimeoutMs;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_REQUEST_TIMEOUT_MS;
}

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
