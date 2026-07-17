// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — DIFFERENTIAL. The core verifier and the zero-dep verify package must
 * return byte-identical verdicts for the same vault. This is the guard the
 * lockstep constraint demands: any future change to canonicalization / hash /
 * chain / .meta format must land in BOTH packages or this test breaks.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Zero-dep verify package, imported by relative path across the workspace.
import { verifyVault as pkgVerifyVault } from "../../../verify/src/index.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVault as coreVerifyVault } from "../../src/audit/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";

const dirs: string[] = [];
function makeRoot(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

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

/** Assert both verifiers agree, and the shared verdict matches `expectedValid`. */
function assertAgree(vaultPath: string, expectedValid: boolean): void {
	const core = coreVerifyVault(vaultPath);
	const pkg = pkgVerifyVault(vaultPath);
	expect(core.valid).toBe(pkg.valid);
	expect(core.chainLength).toBe(pkg.chainLength);
	expect(core.valid).toBe(expectedValid);
}

describe("HARDEN: core vs verify pkg produce identical verdicts", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("1. clean writer-produced vault → both VERIFIED", async () => {
		const root = makeRoot("harden-diff-clean-");
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
		await w.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } });
		w.release();
		assertAgree(join(root, VAULT_DIR), true);
	});

	it("2. tail-truncated (drop last line, keep .meta) → both FAILED", async () => {
		const root = makeRoot("harden-diff-trunc-");
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
		await w.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } });
		await w.appendEvent({ kind: "c", actor: "sys", data: { n: 3 } });
		w.release();
		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		writeFileSync(logPath, `${lines.slice(0, -1).join("\n")}\n`);
		assertAgree(join(root, VAULT_DIR), false);
	});

	it("3. whole-segment-deleted continuous rotation → both FAILED", () => {
		const root = makeRoot("harden-diff-segdel-");
		const auditDir = join(root, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });
		const { lines, hashes } = buildContinuousChain([
			{ kind: "a", data: { n: 1 } },
			{ kind: "b", data: { n: 2 } },
			{ kind: "c", data: { n: 3 } },
			{ kind: "d", data: { n: 4 } },
		]);
		writeFileSync(join(auditDir, "events-0001.jsonl"), `${lines.slice(0, 2).join("\n")}\n`);
		writeFileSync(join(auditDir, "events.jsonl"), `${lines.slice(2).join("\n")}\n`);
		writeFileSync(
			join(auditDir, "events.jsonl.meta"),
			JSON.stringify({ lastHash: hashes[3], sequence: 4 }),
		);
		unlinkSync(join(auditDir, "events-0001.jsonl"));
		assertAgree(join(root, VAULT_DIR), false);
	});

	it("4. legit continuous rotation (+.meta) → both VERIFIED", () => {
		const root = makeRoot("harden-diff-rot-");
		const auditDir = join(root, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });
		const { lines, hashes } = buildContinuousChain([
			{ kind: "a", data: { n: 1 } },
			{ kind: "b", data: { n: 2 } },
			{ kind: "c", data: { n: 3 } },
			{ kind: "d", data: { n: 4 } },
		]);
		writeFileSync(join(auditDir, "events-0001.jsonl"), `${lines.slice(0, 2).join("\n")}\n`);
		writeFileSync(join(auditDir, "events.jsonl"), `${lines.slice(2).join("\n")}\n`);
		writeFileSync(
			join(auditDir, "events.jsonl.meta"),
			JSON.stringify({ lastHash: hashes[3], sequence: 4 }),
		);
		assertAgree(join(root, VAULT_DIR), true);
	});

	it("5. Buffer/toJSON-bearing vault → both VERIFIED", async () => {
		const root = makeRoot("harden-diff-buffer-");
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "blob", actor: "sys", data: { blob: Buffer.from("hi"), n: 1 } });
		await w.appendEvent({ kind: "plain", actor: "sys", data: { ok: true } });
		w.release();
		assertAgree(join(root, VAULT_DIR), true);
	});

	it("6. hand-tampered data → both FAILED", async () => {
		const root = makeRoot("harden-diff-tamper-");
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });
		await w.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } });
		w.release();
		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		const ev = JSON.parse(lines[0] as string) as { data: Record<string, unknown> };
		ev.data.n = 999;
		lines[0] = JSON.stringify(ev);
		writeFileSync(logPath, `${lines.join("\n")}\n`);
		assertAgree(join(root, VAULT_DIR), false);
	});
});
