// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Start-up ledger probe. A server that is not in dryRun needs TigerBeetle, and the
 * native TigerBeetle client fails in two ways no request handler can survive: where
 * io_uring is blocked (Docker's default seccomp profile) it PANICS, killing the whole
 * process on the first authorize; with no TigerBeetle listening it retries without end,
 * so the first authorize hangs. The probe finds both before the server binds: a child
 * process (cli/ledger-probe-child.ts) makes one round trip to each ledger the tenants use,
 * and the server refuses to start unless every one answered.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type TrustConfig, VAULT_DIR } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";
import { tenantVaultBase } from "./pool.js";

export const DEFAULT_LEDGER_PROBE_TIMEOUT_MS = 5_000;

/** The child's stderr quoted in a refusal, at most (its tail, where a crash says why). */
const STDERR_QUOTE_BYTES = 2_048;
/** The child's stderr kept while it runs, at most. */
const STDERR_KEEP_BYTES = 16_384;

/** What the probe child prints when its own deadline fires (cli/ledger-probe-child.ts). */
const CHILD_DEADLINE_LINE = "ledger probe: no answer before the deadline";

const FIXES = 'or set "dryRun": true in the server config to try it without a ledger.';

/** One TigerBeetle cluster a tenant's governor would connect to. */
export interface LedgerTarget {
	clusterId: number;
	addresses: string[];
}

/** How the probe's child process ended. */
export interface LedgerProbeOutcome {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	/** The probe killed the child at its timeout. */
	timedOut: boolean;
}

export type LedgerProbeResult = { ok: true } | { ok: false; message: string };

/**
 * The ledger a tenant's governor would use: the `tigerbeetle` section of its usertrust
 * config, resolved as `createGovernor` resolves it: `tenant.configPath`, else the
 * vault's `usertrust.config.json`, else the core's defaults; parsed by the core's own
 * schema (`defineConfig`).
 */
async function tenantLedger(config: ServerConfig, tenant: TenantConfig): Promise<LedgerTarget> {
	const vaultBase = tenantVaultBase(config, tenant);
	const configPath = tenant.configPath ?? join(vaultBase, VAULT_DIR, "usertrust.config.json");
	try {
		const raw: Record<string, unknown> = existsSync(configPath)
			? (JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>)
			: {};
		// `budget` is required by the schema and irrelevant to the ledger address; the
		// placeholder only stands in where createGovernor would supply its default.
		const { tigerbeetle } = defineConfig({
			budget: 1,
			...raw,
			...(tenant.budget !== undefined ? { budget: tenant.budget } : {}),
		} as TrustConfig);
		return { clusterId: tigerbeetle.clusterId, addresses: tigerbeetle.addresses };
	} catch (err) {
		throw new Error(
			`tenant ${tenant.id}: cannot read its usertrust config (${configPath}): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Every distinct ledger the tenants resolve to, in tenant order. */
export async function resolveLedgerTargets(config: ServerConfig): Promise<LedgerTarget[]> {
	const targets = new Map<string, LedgerTarget>();
	for (const tenant of config.tenants) {
		const target = await tenantLedger(config, tenant);
		const key = JSON.stringify([target.clusterId, target.addresses]);
		if (!targets.has(key)) targets.set(key, target);
	}
	return [...targets.values()];
}

/** The last lines of `stderr`, at most STDERR_QUOTE_BYTES, never starting mid-line. */
function stderrTail(stderr: string): string {
	const trimmed = stderr.trimEnd();
	if (trimmed.length <= STDERR_QUOTE_BYTES) return trimmed;
	const tail = trimmed.slice(-STDERR_QUOTE_BYTES);
	const newline = tail.indexOf("\n");
	return newline >= 0 ? tail.slice(newline + 1) : tail;
}

/** Pure: how the probe's child ended → OK, or why the server must not start. */
export function classifyLedgerProbe(
	outcome: LedgerProbeOutcome,
	target: LedgerTarget,
	timeoutMs: number,
): LedgerProbeResult {
	if (outcome.exitCode === 0 && !outcome.timedOut) return { ok: true };
	const where = `${target.addresses.join(",")} (cluster ${target.clusterId})`;
	if (outcome.stderr.includes("io_uring")) {
		return {
			ok: false,
			message:
				"the TigerBeetle client cannot start here: io_uring is unavailable (blocked by the " +
				"container's seccomp profile or by kernel.io_uring_disabled). Either run where io_uring " +
				"is allowed (for Docker: --security-opt seccomp=unconfined, or a profile that allows " +
				"io_uring; on a host: sysctl kernel.io_uring_disabled=0) with TigerBeetle running, " +
				FIXES,
		};
	}
	// The parent's kill, or the child's own deadline (DEADLINE_LINE in cli/ledger-probe-child.ts).
	if (outcome.timedOut || outcome.stderr.includes(CHILD_DEADLINE_LINE)) {
		return {
			ok: false,
			message: `no TigerBeetle answered at ${where} within ${timeoutMs} ms. Start TigerBeetle 0.17.x on that address, ${FIXES}`,
		};
	}
	const how =
		outcome.signal !== null ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
	const quoted = stderrTail(outcome.stderr);
	return {
		ok: false,
		message:
			`the TigerBeetle ledger probe for ${where} failed (${how})` +
			(quoted === "" ? ". " : `:\n${quoted}\n`) +
			`Start TigerBeetle 0.17.x on that address, ${FIXES}`,
	};
}

/** The child script, in cli/ beside this module: `.ts` when running from source, else `.js`. */
function childScript(): string {
	const self = fileURLToPath(import.meta.url);
	return join(self, "..", "cli", `ledger-probe-child${self.endsWith(".ts") ? ".ts" : ".js"}`);
}

/**
 * Start one probe child for `target`. It never outlives what started it: it keeps
 * `timeoutMs` as its own deadline, and the IPC channel (stdio[3]) closes when this
 * process dies by any signal, which the child takes as its cue to exit. The caller owns
 * it: `runProbeChild` reads its stderr and kills it at the same deadline, as a backstop.
 */
export function spawnProbeChild(target: LedgerTarget, timeoutMs: number): ChildProcess {
	return spawn(
		process.execPath,
		[childScript(), String(target.clusterId), JSON.stringify(target.addresses), String(timeoutMs)],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
}

function runProbeChild(target: LedgerTarget, timeoutMs: number): Promise<LedgerProbeOutcome> {
	return new Promise((resolve) => {
		const child = spawnProbeChild(target, timeoutMs);
		let stderr = "";
		let timedOut = false;
		// stdio[2] is "pipe", so stderr is always present.
		child.stderr?.setEncoding("utf-8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_KEEP_BYTES);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("error", (err) => {
			clearTimeout(timer);
			resolve({ exitCode: null, signal: null, stderr: `${stderr}${err.message}\n`, timedOut });
		});
		child.once("close", (exitCode, signal) => {
			clearTimeout(timer);
			// The child is gone; its IPC channel must not hold this process open.
			if (child.connected) child.disconnect();
			resolve({ exitCode, signal, stderr, timedOut });
		});
	});
}

/**
 * Refuse to start a server whose ledger is unusable: resolves when every distinct ledger
 * the tenants use answered a round trip, and throws an Error naming the cause and the
 * fixes otherwise. A dryRun server needs no ledger, so it resolves at once without
 * probing. `createUsertrustServer` never calls this; the CLI calls it before listening,
 * and an embedder may do the same.
 */
export async function probeLedger(config: ServerConfig): Promise<void> {
	if (config.dryRun) return;
	const timeoutMs = config.ledgerProbeTimeoutMs ?? DEFAULT_LEDGER_PROBE_TIMEOUT_MS;
	const targets = await resolveLedgerTargets(config);
	const results = await Promise.all(
		targets.map(async (target) =>
			classifyLedgerProbe(await runProbeChild(target, timeoutMs), target, timeoutMs),
		),
	);
	const refusals = results.flatMap((result) => (result.ok ? [] : [result.message]));
	if (refusals.length > 0) throw new Error(refusals.join("\n"));
}
