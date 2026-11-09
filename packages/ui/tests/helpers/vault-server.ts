// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A temporary vault and the server over it, for the endpoint tests. `useVaultServer()` registers the `beforeEach` and
 * `afterEach` that make and remove them, so call it once inside a `describe`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedAuditEvent } from "usertrust";
import { canonicalize } from "usertrust-verify";
import { afterEach, beforeEach } from "vitest";
import { createAuditWriter } from "../../../core/src/audit/chain.js";
import { createUiServer, type UiServer } from "../../src/server/server.js";

export const GENESIS = "0".repeat(64);
export const T0 = Date.parse("2026-11-06T10:00:00.000Z");

export type Spec = {
	kind: string;
	/** The record's actor, which is its lane. "local" unless given. */
	actor?: string;
	data?: Record<string, unknown>;
	timestamp?: string;
};

/**
 * A hash-linked chain with `sequence`, one event per spec; event i is at 10:00Z plus i minutes unless given. The first
 * event links from genesis and carries `firstSequence` (1 unless given: a larger one is a chain re-rooted after its
 * leading events were deleted).
 */
export function chain(specs: readonly Spec[], firstSequence = 1): PersistedAuditEvent[] {
	let previousHash = GENESIS;
	return specs.map((s, i) => {
		const rest = {
			actor: s.actor ?? "local",
			data: s.data ?? {},
			id: `evt-${i}`,
			kind: s.kind,
			previousHash,
			sequence: firstSequence + i,
			timestamp: s.timestamp ?? new Date(T0 + i * 60_000).toISOString(),
		};
		const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
		previousHash = hash;
		return { ...rest, hash } as PersistedAuditEvent;
	});
}

/** The directories of the current test; read them inside a test, after `beforeEach` has made them. */
export interface VaultDirs {
	/** The vault's parent directory: what `createUiServer` and `createAuditWriter` take. */
	readonly tempDir: string;
	readonly vaultPath: string;
	/** The audit log file. */
	readonly logPath: string;
	/** A base for workspace directories. */
	readonly wsBase: string;
}

export interface VaultServer {
	start(opts?: { rowCap?: number; workspaceDir?: string }): Promise<UiServer>;
	/** The server `start` made, until the test closes it and calls `forget`. */
	readonly ui: UiServer | undefined;
	/** Drops the server the test has already closed, so the teardown does not close it again. */
	forget(): void;
	seed(count: number, spec?: (i: number) => Spec): Promise<void>;
	writeEvents(events: readonly PersistedAuditEvent[]): void;
	/** Changes event `index`'s cost in place, so its hash no longer matches: the chain breaks AT that event. */
	tamper(index: number): void;
	chain: typeof chain;
	readonly dir: VaultDirs;
}

export function useVaultServer(): VaultServer {
	let tempDir = "";
	let vaultPath = "";
	let logPath = "";
	let wsBase = "";
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-at-"));
		vaultPath = join(tempDir, ".usertrust");
		logPath = join(vaultPath, "audit", "events.jsonl");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		wsBase = mkdtempSync(join(tmpdir(), "trust-at-ws-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(wsBase, { recursive: true, force: true });
	});

	return {
		async start(opts = {}) {
			ui = await createUiServer(tempDir, {
				port: 0,
				workspaceDir: opts.workspaceDir ?? join(wsBase, "workspace"),
				...(opts.rowCap !== undefined ? { rowCap: opts.rowCap } : {}),
			});
			return ui;
		},
		get ui() {
			return ui;
		},
		forget() {
			ui = undefined;
		},
		async seed(count, spec) {
			const writer = createAuditWriter(tempDir);
			for (let i = 0; i < count; i++) {
				const s = spec?.(i) ?? { kind: "llm_call", data: { cost: 1 } };
				await writer.appendEvent({ kind: s.kind, actor: s.actor ?? "local", data: s.data ?? {} });
			}
			writer.release();
		},
		writeEvents(events) {
			writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
		},
		tamper(index) {
			const lines = readFileSync(logPath, "utf-8").trim().split("\n");
			const parsed = JSON.parse(lines[index] as string) as { data: { cost?: number } };
			parsed.data.cost = 9999;
			lines[index] = JSON.stringify(parsed);
			writeFileSync(logPath, `${lines.join("\n")}\n`);
		},
		chain,
		dir: {
			get tempDir() {
				return tempDir;
			},
			get vaultPath() {
				return vaultPath;
			},
			get logPath() {
				return logPath;
			},
			get wsBase() {
				return wsBase;
			},
		},
	};
}
