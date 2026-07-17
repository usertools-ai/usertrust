// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — Rotation continuity. A legitimately rotated vault (chain continuous
 * across segment files, ordered by the persisted global `sequence`) must verify
 * VERIFIED; whole-segment deletion must surface as a distinct, principled FAILED
 * (sequence gap / leading-events-deleted / anchor mismatch), not the same
 * indistinguishable "previousHash mismatch" a legit rotation produced before.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { verifyVault } from "../../src/audit/verify.js";
import { GENESIS_HASH } from "../../src/shared/constants.js";

interface Ev {
	kind: string;
	data: Record<string, unknown>;
}

function buildContinuousChain(events: Ev[]): { lines: string[]; hashes: string[] } {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	const hashes: string[] = [];
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
		hashes.push(hash);
		previousHash = hash;
	}
	return { lines, hashes };
}

describe("HARDEN: rotation continuity (core verifyVault)", () => {
	let vaultPath: string;
	let auditDir: string;

	beforeEach(() => {
		vaultPath = mkdtempSync(join(tmpdir(), "harden-rot-core-"));
		auditDir = join(vaultPath, "audit");
		mkdirSync(auditDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(vaultPath, { recursive: true, force: true });
	});

	function writeRotatedVault(): string[] {
		const { lines, hashes } = buildContinuousChain([
			{ kind: "a", data: { n: 1 } },
			{ kind: "b", data: { n: 2 } },
			{ kind: "c", data: { n: 3 } },
			{ kind: "d", data: { n: 4 } },
		]);
		// events 1-2 rotated into a segment; events 3-4 in the live log.
		writeFileSync(join(auditDir, "events-0001.jsonl"), `${lines.slice(0, 2).join("\n")}\n`);
		writeFileSync(join(auditDir, "events.jsonl"), `${lines.slice(2).join("\n")}\n`);
		writeFileSync(
			join(auditDir, "events.jsonl.meta"),
			JSON.stringify({ lastHash: hashes[3], sequence: 4 }),
		);
		return hashes;
	}

	it("accepts a legitimately rotated continuous chain (VERIFIED)", () => {
		writeRotatedVault();
		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(4);
	});

	it("flags whole-segment deletion with a meaningful error", () => {
		writeRotatedVault();
		unlinkSync(join(auditDir, "events-0001.jsonl")); // delete the first segment, keep .meta seq 4
		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				/sequence|leading events deleted|anchor mismatch|previousHash/.test(e),
			),
		).toBe(true);
	});
});
