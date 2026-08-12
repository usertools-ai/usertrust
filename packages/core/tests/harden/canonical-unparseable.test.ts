// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — the canonicalizer emitted syntactically INVALID JSON for three
 * inputs, and `chain.ts` persists canonical bytes AS the audit line. One
 * `governAction({ params: { arr: [1,,2] } })` therefore wrote an unparseable
 * line: `read.ts` skips it, the next event's `previousHash` dangles, and
 * `verifyVault` reports "malformed JSON" + "anchor mismatch" forever —
 * indistinguishable from real tampering, with the pre-image lost.
 *
 * A canonicalizer-only test passes happily while the chain breaks, so these
 * assertions are made at the CHAIN level: what reaches the log, and what the
 * verifier says about it afterwards.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

function countLines(path: string): number {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.length > 0).length;
}

describe("HARDEN: no unparseable line may ever reach the audit log", () => {
	let root: string;
	let writer: ReturnType<typeof createAuditWriter>;
	let logPath: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "harden-canonical-"));
		writer = createAuditWriter(root);
		logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		await writer.appendEvent({ kind: "seed", actor: "sys", data: { ok: true } });
	});

	afterEach(() => {
		writer.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("persists an array hole as null and keeps the chain verifiable (the repro)", async () => {
		// `{ arr: [1,,2] }` — the exact payload that used to write `{"arr":[1,,2]}`.
		const holey: number[] = [];
		holey[0] = 1;
		holey[2] = 2;
		expect(1 in holey).toBe(false);

		await writer.appendEvent({ kind: "action", actor: "sys", data: { params: { arr: holey } } });
		await writer.appendEvent({ kind: "after", actor: "sys", data: { n: 2 } });
		writer.release();

		const lines = readFileSync(logPath, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(JSON.parse(lines[1] as string).data.params.arr).toEqual([1, null, 2]);
		expect(verifyVault(join(root, VAULT_DIR)).valid).toBe(true);
	});

	it("REFUSES a function-valued payload — nothing persisted, vault still verifies", async () => {
		const linesBefore = countLines(logPath);

		await expect(
			writer.appendEvent({ kind: "action", actor: "sys", data: { params: { f: () => 1 } } }),
		).rejects.toThrow(/not representable in audit data/);

		expect(countLines(logPath)).toBe(linesBefore);

		// The chain is intact and the NEXT event still chains off the seed — the
		// refused event never claimed a sequence number on disk.
		await writer.appendEvent({ kind: "after", actor: "sys", data: { n: 2 } });
		writer.release();

		const lines = readFileSync(logPath, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(2);
		expect(verifyVault(join(root, VAULT_DIR)).valid).toBe(true);
	});

	it("REFUSES a symbol-valued payload — nothing persisted, vault still verifies", async () => {
		const linesBefore = countLines(logPath);

		await expect(
			writer.appendEvent({ kind: "action", actor: "sys", data: { params: { s: Symbol("x") } } }),
		).rejects.toThrow(/not representable in audit data/);

		expect(countLines(logPath)).toBe(linesBefore);
		writer.release();
		expect(verifyVault(join(root, VAULT_DIR)).valid).toBe(true);
	});

	it("a refusal is never silent — the writer degrades and dead-letters the payload", async () => {
		// This is what makes the new throw survive a caller's bare `.catch(() => {})`:
		// the drop is recorded by the writer itself, not only by the rejection.
		await expect(
			writer.appendEvent({ kind: "action", actor: "sys", data: { params: { f: () => 1 } } }),
		).rejects.toThrow();

		expect(writer.isDegraded()).toBe(true);
		expect(writer.getWriteFailures()).toBe(1);

		const dlqPath = join(root, VAULT_DIR, "dlq", "dead-letters.jsonl");
		expect(existsSync(dlqPath)).toBe(true);
		const dlq = JSON.parse(
			(readFileSync(dlqPath, "utf-8").split("\n").filter(Boolean).at(-1) ?? "") as string,
		);
		expect(dlq.source).toBe("audit.chain.appendEvent");
		expect(dlq.error).toMatch(/not representable in audit data/);
	});
});
