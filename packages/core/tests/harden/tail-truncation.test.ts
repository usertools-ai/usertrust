// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — Truncated/deleted audit log must NOT verify. The fsync'd .meta head
 * anchor makes tail truncation and full deletion detectable even when the
 * remaining chain is internally consistent.
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

describe("HARDEN: tail truncation / deletion fails verification (core verifyVault)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harden-truncate-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("detects a dropped last line via the .meta anchor", async () => {
		const writer = createAuditWriter(root);
		try {
			await writer.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
			await writer.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } });
			await writer.appendEvent({ kind: "c", actor: "sys", data: { n: 3 } });
		} finally {
			writer.release();
		}

		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		// Drop the last event but leave .meta intact (records 3 events, hash h3)
		writeFileSync(logPath, `${lines.slice(0, -1).join("\n")}\n`);

		const result = verifyVault(join(root, VAULT_DIR));
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => /anchor mismatch|truncation/.test(e))).toBe(true);
	});

	it("detects full deletion of the log while .meta still records events", async () => {
		const writer = createAuditWriter(root);
		try {
			await writer.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
			await writer.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } });
		} finally {
			writer.release();
		}

		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		unlinkSync(logPath); // keep .meta

		const result = verifyVault(join(root, VAULT_DIR));
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => /missing.*anchor|deletion/.test(e))).toBe(true);
	});
});
