// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — Serialization mismatch (writer hashes canonical bytes but persisted
 * JSON.stringify output). For any value with a toJSON (e.g. Buffer) these diverge,
 * so an untampered vault verifies as TAMPERED. The bytes hashed MUST equal the
 * bytes persisted.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyChain, verifyVault } from "../../src/audit/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

describe("HARDEN: hashed bytes must equal persisted bytes", () => {
	let root: string;
	let writer: ReturnType<typeof createAuditWriter>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harden-serial-"));
		writer = createAuditWriter(root);
	});

	afterEach(() => {
		writer.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies an untampered event whose data contains a Buffer (toJSON divergence)", async () => {
		await writer.appendEvent({
			kind: "blob.test",
			actor: "sys",
			data: { blob: Buffer.from("hi"), n: 1 },
		});
		await writer.appendEvent({ kind: "plain.test", actor: "sys", data: { ok: true } });
		writer.release();

		const vaultPath = join(root, VAULT_DIR);
		expect(verifyVault(vaultPath).valid).toBe(true);
		expect(verifyChain(join(vaultPath, "audit", "events.jsonl")).valid).toBe(true);
	});

	it("persists canonical bytes, not JSON.stringify (no Buffer.toJSON shape on disk)", async () => {
		await writer.appendEvent({
			kind: "blob.test",
			actor: "sys",
			data: { blob: Buffer.from("hi") },
		});
		writer.release();

		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8");
		expect(content).not.toContain('"type":"Buffer"');
	});
});
