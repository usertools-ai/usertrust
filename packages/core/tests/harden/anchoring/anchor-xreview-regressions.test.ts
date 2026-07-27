// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — regressions for the xhigh code-review findings on PR #51:
 * CLI strict-gate fail-opens, adversarial timestamp/freshness bypasses,
 * benign-twin linkage, post-rotation partial history, emitter crash-window
 * self-heal, vault-behind guard, resume validation, snapshot/anchor
 * isolation, key-path guard, and the DLQ NaN drop.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseAnchorRecord as pkgParseAnchorRecord,
	verifyTransaction as pkgVerifyTransaction,
} from "../../../../verify/src/index.js";
import {
	createAnchorEmitter,
	initAnchorIdentity,
	readAnchorIdentity,
	resumeAnchorMirror,
} from "../../../src/audit/anchor.js";
import { anchorPayloadHash, parseAnchorRecord } from "../../../src/audit/anchor-verify.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import { createAuditWriter } from "../../../src/audit/chain.js";
import { exitCodeForAnchored } from "../../../src/audit/verify.js";
import { run as verifyRun } from "../../../src/cli/verify.js";
import { VAULT_DIR } from "../../../src/shared/constants.js";
import { createSnapshot, restoreSnapshot } from "../../../src/snapshot/checkpoint.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	nextPayload,
	pubPemFromKeyFile,
	rotateOnce,
	signRecord,
	storeRaw,
	storeRecords,
	tmp,
	verify,
} from "./fixtures.js";

const origCwd = process.cwd();
const origArgv = process.argv;

afterEach(() => {
	process.chdir(origCwd);
	process.argv = origArgv;
	process.exitCode = 0;
	vi.restoreAllMocks();
	cleanupAll();
});

describe("finding 0: --tx mode enforces strict gates", () => {
	it("verifyTransaction exposes anchorState/anchoring so strict gates compose", async () => {
		const s = await makeAnchoredVault(3);
		// No anchors emitted, strict-gate params supplied.
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_2", {
			externalAnchorsRaw: [],
			trust: s.trust,
			witness: { requested: false },
		});
		expect(tx.valid).toBe(true);
		expect(tx.anchorState).toBe("UNANCHORED");
		expect(tx.anchoring).toBeDefined();
		const gate = exitCodeForAnchored(
			{
				valid: true,
				anchorState: tx.anchorState as NonNullable<typeof tx.anchorState>,
				anchoring: tx.anchoring as NonNullable<typeof tx.anchoring>,
			},
			{ requireExternalAnchor: true },
		);
		expect(gate).toBe(1);
	});

	it("CLI: --tx --require-external-anchor exits 1 on an unanchored vault (and 0 without the flag)", async () => {
		const s = await makeAnchoredVault(3);
		const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
		const cli = join(repoRoot, "packages", "verify", "src", "cli.ts");
		const strict = spawnSync(
			"npx",
			["tsx", cli, s.vaultPath, "--tx", "tr_2", "--require-external-anchor"],
			{ cwd: repoRoot, encoding: "utf-8" },
		);
		expect(strict.status).toBe(1);
		const lax = spawnSync("npx", ["tsx", cli, s.vaultPath, "--tx", "tr_2"], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		expect(lax.status).toBe(0);
	}, 30_000);
});

describe("finding 1/14: freshness-policy values fail loudly; global flags stay accepted", () => {
	function captureLog(): { lines: string[]; restore: () => void } {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		return { lines, restore: () => spy.mockRestore() };
	}

	it("typo'd --max-unanchored-events / --max-anchor-age exit 1 instead of silently disabling the gate", async () => {
		const root = tmp("flags-");
		await appendEvents(root, 2);
		for (const argv of [
			["--require-anchor", "--max-unanchored-events", "1O0"],
			["--max-anchor-age", "15min"],
		]) {
			process.exitCode = 0;
			process.argv = ["node", "usertrust", "verify", ...argv];
			const { lines, restore } = captureLog();
			try {
				await verifyRun(root, { json: false });
			} finally {
				restore();
			}
			expect(lines.join("\n"), argv.join(" ")).toMatch(/Invalid --max/);
			expect(process.exitCode, argv.join(" ")).toBe(1);
		}
	});

	it("global flags (--skip-verify, --reconfigure) are not rejected", async () => {
		const root = tmp("flags-global-");
		await appendEvents(root, 2);
		process.argv = ["node", "usertrust", "verify", "--skip-verify", "--reconfigure"];
		const { lines, restore } = captureLog();
		try {
			await verifyRun(root, { json: false });
		} finally {
			restore();
		}
		expect(lines.join("\n")).not.toMatch(/Unknown flag/);
		expect(process.exitCode).toBe(0);
	});
});

describe("finding 2: relative --key-file cannot land the signing key inside the vault", () => {
	it("initAnchorIdentity resolves the key path before the inside-vault guard", async () => {
		const root = tmp("keyguard-");
		await appendEvents(root, 1);
		process.chdir(root);
		expect(() => initAnchorIdentity(root, { keyFile: `${VAULT_DIR}/keys/anchor.pem` })).toThrow(
			/inside the vault/,
		);
		expect(existsSync(join(root, VAULT_DIR, "keys", "anchor.pem"))).toBe(false);
	});
});

describe("finding 3 (downstream): witness evidence with embedded garbage fails closed, not open", () => {
	it("a body of valid records + one garbage line yields a FAIL state, never a silent pass", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const body = `${storeRaw(s)}{garbage\n`;
		const result = verify(s, { external: [body], witness: { requested: true, ok: true } });
		expect(["ANCHOR_INVALID", "ANCHOR_MISMATCH"]).toContain(result.anchorState);
		expect(result.valid).toBe(false);
	});
});

describe("finding 4: signed-but-unparseable timestamps are rejected at parse", () => {
	it("timestamp 'n/a' is malformed-anchor in BOTH packages (age gate cannot be defused)", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const doctored = { ...JSON.parse(canonicalize(r1)), timestamp: "n/a" };
		for (const parse of [parseAnchorRecord, pkgParseAnchorRecord]) {
			const { record, error } = parse(JSON.stringify(doctored));
			expect(record).toBeNull();
			expect(error).toMatch(/timestamp/);
		}
	});
});

describe("finding 5: benign committed-equal twins do not break successor linkage", () => {
	it("a successor linking to the DROPPED twin still verifies (order-independent)", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const { sig: _s1, ...p1 } = r1;
		const twin = signRecord(
			{ ...p1, timestamp: new Date(Date.parse(r1.timestamp) + 1000).toISOString() },
			s.keyFile,
		);
		await appendEvents(s.root, 2, 4);
		// Successor minted against the TWIN as predecessor.
		const r2 = signRecord({ ...nextPayload(s, twin) }, s.keyFile);
		expect(r2.prevAnchorHash).toBe(anchorPayloadHash(twin));
		for (const order of [
			[r1, twin, r2],
			[twin, r1, r2],
		]) {
			const result = verify(s, {
				external: [order.map((r) => canonicalize(r)).join("\n")],
			});
			expect(result.anchorState).toBe("ANCHORED_VERIFIED");
			expect(result.anchoring.warnings).toContain("duplicate-anchor");
		}
	});
});

describe("finding 6: partial history starting after a rotation verifies under a pinned successor", () => {
	it("lone post-rotation checkpoint + root & successor pin → ANCHORED_VERIFIED (partial-history)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		const successor = await rotateOnce(s);
		await appendEvents(s.root, 1, 5);
		await anchorOnce(s, successor.keyFile);
		const latest = storeRecords(s).at(-1) as NonNullable<ReturnType<typeof storeRecords>[0]>;
		expect(latest.keyId).toBe(successor.keyId);
		// Auditor holds ONLY the newest checkpoint; mirror unavailable.
		writeFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "");
		const result = verify(s, {
			external: [canonicalize(latest)],
			trust: { rootPem: s.rootPem, successorPinsPem: [successor.publicKeyPem] },
		});
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.warnings).toContain("partial-history");
	});
});

describe("finding 7: outbox-first ordering + orphan self-heal (no permanent store gaps)", () => {
	it("an outbox record missing from the mirror is re-appended, then emission continues", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		// Simulate the crash window: a fully minted seq-2 record durably in the
		// outbox, absent from the mirror (outbox is written first now).
		const orphan = signRecord(nextPayload(s, r1), s.keyFile);
		writeFileSync(
			join(s.vaultPath, "audit", "anchors", "outbox", "000000000002.json"),
			canonicalize(orphan),
			{ mode: 0o600 },
		);
		await appendEvents(s.root, 1, 6);
		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const r3 = await emitter.anchorNow();
		await emitter.stop();
		expect(r3.emitted).toBe(true);
		expect(r3.record?.anchorSeq).toBe(3);
		// Mirror healed: 1,2,3 contiguous; store received the orphan too.
		const mirrorSeqs = readFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as { anchorSeq: number }).anchorSeq);
		expect(mirrorSeqs).toEqual([1, 2, 3]);
		expect(
			storeRecords(s)
				.map((r) => r.anchorSeq)
				.sort(),
		).toEqual([1, 2, 3]);
		expect(verify(s).anchorState).toBe("ANCHORED_VERIFIED");
	});

	it("an INVALID outbox orphan refuses emission instead of forking", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		const attacker = await makeAnchoredVault(1);
		const real = storeRecords(s)[0] as NonNullable<ReturnType<typeof storeRecords>[0]>;
		const forged = signRecord({ ...nextPayload(s, real), vaultId: real.vaultId }, attacker.keyFile);
		writeFileSync(
			join(s.vaultPath, "audit", "anchors", "outbox", "000000000002.json"),
			canonicalize(forged),
			{ mode: 0o600 },
		);
		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const result = await emitter.anchorNow();
		await emitter.stop();
		expect(result.emitted).toBe(false);
		expect(result.reason).toMatch(/outbox-orphan-invalid/);
	});
});

describe("finding 8: stale-lock reclaim is single-winner (no unlink TOCTOU)", () => {
	it("a dead-pid lock is reclaimed atomically and emission proceeds once", async () => {
		const s = await makeAnchoredVault(3);
		const lockPath = join(s.vaultPath, "audit", "anchors", ".anchor-writer.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "x" }), { mode: 0o600 });
		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const result = await emitter.anchorNow();
		await emitter.stop();
		expect(result.emitted).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
		// No stray reclaim artifacts left behind.
		const strays = readdirSync(join(s.vaultPath, "audit", "anchors")).filter((f) =>
			f.includes(".reclaim-"),
		);
		expect(strays).toEqual([]);
	});
});

describe("finding 9: snapshots never capture nor restore anchoring state", () => {
	it("capture excludes audit/anchors; restore preserves the live high-water", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		// Satisfy the pre-existing money/audit desync guard on restore.
		writeFileSync(join(s.vaultPath, "spend-ledger.json"), "{}");
		await createSnapshot(s.vaultPath, "pre");
		const payload = JSON.parse(
			readFileSync(join(s.vaultPath, "snapshots", "pre.json"), "utf-8"),
		) as { entries: Record<string, string> };
		expect(Object.keys(payload.entries).filter((p) => p.startsWith("audit/anchors"))).toEqual([]);

		// Even a snapshot that DOES carry anchors entries (older format /
		// tampered) must not roll the live state back.
		payload.entries["audit/anchors/identity.json"] = Buffer.from("{}").toString("base64");
		payload.entries["audit/anchors/anchors.jsonl"] = Buffer.from("").toString("base64");
		writeFileSync(join(s.vaultPath, "snapshots", "pre.json"), JSON.stringify(payload));

		await appendEvents(s.root, 2, 4);
		await anchorOnce(s); // high-water now 2
		await restoreSnapshot(s.vaultPath, "pre", { forceLedgerDesync: true });

		const identity = readAnchorIdentity(s.root);
		expect(identity?.lastAnchorSeq).toBe(2);
		const mirrorSeqs = readFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as { anchorSeq: number }).anchorSeq);
		expect(mirrorSeqs).toEqual([1, 2]);
	});
});

describe("finding 10: vault-behind guard refuses decreasing-treeSize anchors", () => {
	it("events restored below the anchored head refuse emission (no rollback evidence minted)", async () => {
		const s = await makeAnchoredVault(6);
		await anchorOnce(s); // treeSize 6
		// Partial event restore: truncate events+meta to 3 while anchors stay.
		const logPath = join(s.vaultPath, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n").slice(0, 3);
		const last = JSON.parse(lines[2] as string) as { hash: string };
		writeFileSync(logPath, `${lines.join("\n")}\n`);
		writeFileSync(`${logPath}.meta`, JSON.stringify({ lastHash: last.hash, sequence: 3 }));

		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const result = await emitter.anchorNow();
		await emitter.stop();
		expect(result.emitted).toBe(false);
		expect(result.reason).toMatch(/vault-behind-anchors/);
		expect(storeRecords(s).length).toBe(1);
	});
});

describe("finding 11: resume validates the supplied record cryptographically", () => {
	it("rejects a record signed by a different key even with the right vaultId", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const attacker = await makeAnchoredVault(1);
		const { sig: _s2, ...payload } = r1;
		const forged = signRecord({ ...payload }, attacker.keyFile);
		unlinkSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"));
		expect(() => resumeAnchorMirror(s.root, canonicalize(forged))).toThrow(
			/does not verify under this vault's current anchor key/,
		);
	});

	it("rejects a record older than the durable high-water", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		await anchorOnce(s); // high-water 2
		unlinkSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"));
		expect(() => resumeAnchorMirror(s.root, canonicalize(r1))).toThrow(/high-water/);
	});
});

describe("finding 12: identity.json writes are atomic", () => {
	it("no temp files linger after emissions and the identity stays parseable", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		await anchorOnce(s);
		const files = readdirSync(join(s.vaultPath, "audit", "anchors"));
		expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
		expect(readAnchorIdentity(s.root)?.lastAnchorSeq).toBe(2);
	});
});

describe("finding 13: DLQ persists dead letters carrying NaN payloads", () => {
	it("appendEvent with NaN data still writes the dead letter (canonicalize fallback)", async () => {
		const root = tmp("dlq-nan-");
		const w = createAuditWriter(root);
		try {
			await expect(
				w.appendEvent({ kind: "llm_call", actor: "sys", data: { amount: Number.NaN } }),
			).rejects.toThrow();
		} finally {
			w.release();
		}
		const dlqPath = join(root, VAULT_DIR, "dlq", "dead-letters.jsonl");
		expect(existsSync(dlqPath)).toBe(true);
		const entry = JSON.parse(readFileSync(dlqPath, "utf-8").trim().split("\n")[0] as string) as {
			source: string;
			checksum?: string;
		};
		expect(entry.source).toContain("appendEvent");
		expect(entry.checksum).toHaveLength(64);
	});
});
