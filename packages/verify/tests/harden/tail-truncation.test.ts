// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — verify pkg verifyVault must fail on tail truncation by consulting the
 * fsync'd .meta head anchor (byte-identical semantics to core).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, GENESIS_HASH, verifyVault } from "../../src/index.js";

interface Ev {
	kind: string;
	data: Record<string, unknown>;
}

function buildChain(events: Ev[]): { lines: string[]; lastHash: string } {
	let previousHash = GENESIS_HASH;
	let lastHash = GENESIS_HASH;
	const lines: string[] = [];
	for (let i = 0; i < events.length; i++) {
		const ev = events[i] as Ev;
		const event = {
			id: `evt-${i + 1}`,
			timestamp: new Date(Date.now() + i * 1000).toISOString(),
			previousHash,
			kind: ev.kind,
			actor: "sys",
			data: ev.data,
			sequence: i + 1,
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(canonicalize({ ...event, hash }));
		previousHash = hash;
		lastHash = hash;
	}
	return { lines, lastHash };
}

describe("HARDEN: verify pkg verifyVault fails on tail truncation via .meta", () => {
	let vaultPath: string;

	beforeEach(() => {
		vaultPath = mkdtempSync(join(tmpdir(), "harden-verify-trunc-"));
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
	});

	afterEach(() => {
		rmSync(vaultPath, { recursive: true, force: true });
	});

	it("drops the last line but keeps the anchor recording all 3 events", () => {
		const { lines, lastHash } = buildChain([
			{ kind: "a", data: { n: 1 } },
			{ kind: "b", data: { n: 2 } },
			{ kind: "c", data: { n: 3 } },
		]);
		const auditDir = join(vaultPath, "audit");
		writeFileSync(join(auditDir, "events.jsonl"), `${lines.slice(0, -1).join("\n")}\n`);
		writeFileSync(join(auditDir, "events.jsonl.meta"), JSON.stringify({ lastHash, sequence: 3 }));

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => /anchor mismatch|truncation/.test(e))).toBe(true);
	});

	it("detects full deletion of the log while .meta records events", () => {
		const { lastHash } = buildChain([
			{ kind: "a", data: { n: 1 } },
			{ kind: "b", data: { n: 2 } },
		]);
		const auditDir = join(vaultPath, "audit");
		// No events.jsonl written at all, but the anchor says 2 events existed.
		writeFileSync(join(auditDir, "events.jsonl.meta"), JSON.stringify({ lastHash, sequence: 2 }));

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => /missing.*anchor|deletion/.test(e))).toBe(true);
	});
});
