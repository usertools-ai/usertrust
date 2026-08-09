// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — an append that rejects has NOT necessarily written nothing.
 *
 * `appendEvent` writes `events.jsonl`, fsyncs it, and only THEN writes the
 * `.meta` sidecar. A sidecar failure therefore rejects for an event that is
 * durably on the chain. Reporting only `auditDegraded` there throws away the
 * correlation handle for a record an auditor can still read and verify — the
 * one failure mode where the hash is known and we were about to discard it.
 *
 * The fault is injected at the syscall the sidecar uses, so the log write, the
 * fsync, the DLQ and the advisory lock all run for real.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		// ONLY the sidecar's own `openSync(path, "w")`. The log's `"a"`, the DLQ's
		// `"a"` and the lock file's numeric O_EXCL flags all fall through, so this
		// reproduces a sidecar-only failure rather than a general write outage.
		openSync: (path: unknown, flags?: unknown, mode?: unknown) => {
			if (typeof path === "string" && path.endsWith(".meta") && flags === "w") {
				const err = new Error(`EACCES: permission denied, open '${path}'`);
				(err as NodeJS.ErrnoException).code = "EACCES";
				throw err;
			}
			return (actual.openSync as (...a: unknown[]) => number)(path, flags, mode);
		},
	};
});

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const { trust } = await import("../../src/govern.js");
const { verifyVault } = await import("../../src/audit/verify.js");
const { PolicyDeniedError } = await import("../../src/shared/errors.js");

const VAULT_DIR = ".usertrust";

describe("HARDEN: a sidecar-only append failure keeps the correlation handle", () => {
	let vault: string;

	beforeEach(() => {
		vault = join(tmpdir(), `harden-meta-${randomUUID()}`);
		mkdirSync(join(vault, VAULT_DIR, "policies"), { recursive: true });
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 1_000_000, policies: "./policies/deny.json" }),
		);
		writeFileSync(
			join(vault, VAULT_DIR, "policies", "deny.json"),
			JSON.stringify({
				rules: [
					{
						id: "no-frontier",
						name: "No frontier models",
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "model", operator: "eq", value: "forbidden-model" }],
					},
				],
			}),
		);
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("reports the REAL hash alongside auditDegraded, and the chain still verifies", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault },
		);

		let caught: unknown;
		try {
			await governed.messages.create({
				model: "forbidden-model",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			});
		} catch (e) {
			caught = e;
		}
		await governed.destroy();

		// The denial is unchanged — a sidecar failure never rewrites the decision.
		expect(caught).toBeInstanceOf(PolicyDeniedError);
		const err = caught as InstanceType<typeof PolicyDeniedError>;

		// BOTH fields. Together they say: the event IS on the chain at this hash,
		// AND the write reported failure, so the vault wants a verify pass. That
		// is strictly more than either field alone could tell the caller.
		expect(err.auditEventHash).toMatch(/^[0-9a-f]{64}$/);
		expect(err.auditDegraded).toBe(true);

		// The hash is the REAL one: it is the hash of the event actually persisted.
		const vaultDir = join(vault, VAULT_DIR);
		const raw = readFileSync(join(vaultDir, "audit", "events.jsonl"), "utf-8").trim();
		const persisted = JSON.parse(raw) as { kind: string; hash: string };
		expect(persisted.kind).toBe("policy_denied");
		expect(persisted.hash).toBe(err.auditEventHash);

		// The sidecar never landed, and an ABSENT anchor is not a corrupt one —
		// the chain verifies VALID and the recovered hash is genuinely usable.
		expect(existsSync(join(vaultDir, "audit", "events.jsonl.meta"))).toBe(false);
		expect(verifyVault(vaultDir).valid).toBe(true);

		// The payload was still dead-lettered, because the append DID fail.
		const dlq = readFileSync(join(vaultDir, "dlq", "dead-letters.jsonl"), "utf-8");
		expect(dlq).toContain("policy_denied");
		expect(dlq).not.toContain("hello");
	});

	it("still reports no hash when nothing durable was written", async () => {
		// Log write fails too (events.jsonl is a directory) → total failure, so
		// there is no on-chain event to correlate and the handle stays absent.
		const auditDir = join(vault, VAULT_DIR, "audit");
		mkdirSync(join(auditDir, "events.jsonl"), { recursive: true });

		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault },
		);
		let caught: unknown;
		try {
			await governed.messages.create({
				model: "forbidden-model",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			});
		} catch (e) {
			caught = e;
		}
		await governed.destroy();

		const err = caught as InstanceType<typeof PolicyDeniedError>;
		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(err.auditEventHash).toBeUndefined();
		expect(err.auditDegraded).toBe(true);
	});
});
