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
import {
	buildMerkleTree as pkgBuildMerkleTree,
	generateInclusionProof as pkgGenerateInclusionProof,
	verifyInclusionProof as pkgVerifyInclusionProof,
} from "../../../verify/src/verify.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import {
	buildMerkleTree as coreBuildMerkleTree,
	generateInclusionProof as coreGenerateInclusionProof,
	verifyInclusionProof as coreVerifyInclusionProof,
	type MerkleInclusionProof,
	type MerkleSibling,
} from "../../src/audit/merkle.js";
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

// ═══════════════════════════════════════════════════════════════
// Inclusion proofs are driven DIRECTLY, not through a vault. No
// vault format carries an attacker-supplied inclusion proof — core
// builds roots, and verify generates its own proof immediately
// before checking it (verify/src/index.ts) — so a forged proof
// smuggled into vault data would have both packages "agree" for a
// reason that has nothing to do with this function.
// ═══════════════════════════════════════════════════════════════

function merkleLeaves(n: number): string[] {
	return Array.from({ length: n }, (_, i) =>
		createHash("sha256").update(`leaf-${i}`).digest("hex"),
	);
}

/**
 * Both implementations must return the same boolean, and neither may throw.
 * Cross-fed as well: core's generator against verify's verifier and back, so
 * a drift in either the generator or the topology derivation surfaces here.
 */
function assertInclusionAgree(
	proof: MerkleInclusionProof,
	root: string,
	treeSize: number,
	expected: boolean,
): void {
	let core: boolean | undefined;
	let pkg: boolean | undefined;
	expect(() => {
		core = coreVerifyInclusionProof(proof, root, treeSize);
	}).not.toThrow();
	expect(() => {
		pkg = pkgVerifyInclusionProof(proof, root, treeSize);
	}).not.toThrow();
	expect(core).toBe(pkg);
	expect(core).toBe(expected);
}

describe("HARDEN: core vs verify pkg agree on inclusion-proof topology", () => {
	it("7. both generators produce proofs both verifiers accept (sizes 1..17)", () => {
		for (let size = 1; size <= 17; size++) {
			const leaves = merkleLeaves(size);
			const coreRoot = coreBuildMerkleTree(leaves).root as string;
			const pkgRoot = pkgBuildMerkleTree(leaves).root as string;
			expect(coreRoot).toBe(pkgRoot);

			for (let i = 0; i < size; i++) {
				assertInclusionAgree(coreGenerateInclusionProof(i, leaves, "seg"), coreRoot, size, true);
				assertInclusionAgree(pkgGenerateInclusionProof(i, leaves, "seg"), coreRoot, size, true);
			}
		}
	});

	it("8. both reject a forged leafIndex on an otherwise-valid fold", () => {
		const leaves = merkleLeaves(8);
		const root = coreBuildMerkleTree(leaves).root as string;
		const proof = coreGenerateInclusionProof(3, leaves, "seg-forged");

		assertInclusionAgree(proof, root, 8, true);
		for (const leafIndex of [0, 1, 2, 4, 5, 6, 7]) {
			assertInclusionAgree({ ...proof, leafIndex }, root, 8, false);
		}
	});

	it("9. both reject the equal-hash position flip", () => {
		const twin = createHash("sha256").update("twin").digest("hex");
		const pair = [twin, twin];
		const root = coreBuildMerkleTree(pair).root as string;
		const proof = coreGenerateInclusionProof(0, pair, "seg-twin");

		assertInclusionAgree(proof, root, 2, true);
		assertInclusionAgree(
			{ ...proof, siblings: [{ hash: proof.siblings[0]?.hash as string, position: "left" }] },
			root,
			2,
			false,
		);
	});

	it("10. both reject malformed proofs identically, neither throws", () => {
		const leaves = merkleLeaves(8);
		const root = coreBuildMerkleTree(leaves).root as string;
		const proof = coreGenerateInclusionProof(3, leaves, "seg-malformed");
		const bad = (v: unknown): MerkleInclusionProof => v as MerkleInclusionProof;

		const cases: MerkleInclusionProof[] = [
			bad({ ...proof, siblings: null }),
			bad({ ...proof, siblings: [...proof.siblings, proof.siblings[0]] }),
			bad({ ...proof, siblings: proof.siblings.slice(0, 1) }),
			bad({ ...proof, siblings: [proof.siblings[0], null, proof.siblings[2]] }),
			bad({ ...proof, siblings: proof.siblings.map((s) => ({ ...s, position: "bogus" })) }),
			bad({ ...proof, siblings: proof.siblings.map(({ position }) => ({ position })) }),
			bad({ ...proof, leafHash: undefined }),
			bad({ ...proof, leafIndex: Number.NaN }),
			bad({ ...proof, leafIndex: -1 }),
			bad({ ...proof, leafIndex: 1.5 }),
		];

		for (const c of cases) {
			assertInclusionAgree(c, root, 8, false);
		}
	});

	it("11. both reject non-safe-integer tree sizes", () => {
		const leaves = merkleLeaves(8);
		const root = coreBuildMerkleTree(leaves).root as string;
		const proof = coreGenerateInclusionProof(3, leaves, "seg-size");

		for (const treeSize of [0, -1, 8.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
			assertInclusionAgree({ ...proof, treeSize }, root, treeSize, false);
		}
	});

	it("12. both reject hostile objects that answer differently on a second read", () => {
		// A fresh fixture per verifier: a one-shot getter is consumed by the
		// first call. Defends the exported contract, not a vault path.
		const leaves = merkleLeaves(4);
		const root = coreBuildMerkleTree(leaves).root as string;
		const source = coreGenerateInclusionProof(0, leaves, "seg-hostile");

		const flippingGetter = (): MerkleInclusionProof => {
			let reads = 0;
			return {
				...source,
				leafIndex: 2,
				siblings: [
					source.siblings[0],
					{
						hash: (source.siblings[1] as MerkleSibling).hash,
						get position(): string {
							reads += 1;
							return reads === 1 ? "left" : "right";
						},
					},
				],
			} as unknown as MerkleInclusionProof;
		};

		const hostileIterator = (): MerkleInclusionProof => {
			const real = source.siblings[1] as MerkleSibling;
			const indexed: unknown[] = [source.siblings[0], { ...real, position: "left" }];
			Object.defineProperty(indexed, Symbol.iterator, {
				value: function* () {
					yield source.siblings[0];
					yield real;
				},
			});
			return { ...source, leafIndex: 2, siblings: indexed } as unknown as MerkleInclusionProof;
		};

		for (const make of [flippingGetter, hostileIterator]) {
			let core: boolean | undefined;
			let pkg: boolean | undefined;
			expect(() => {
				core = coreVerifyInclusionProof(make(), root, 4);
			}).not.toThrow();
			expect(() => {
				pkg = pkgVerifyInclusionProof(make(), root, 4);
			}).not.toThrow();
			expect(core).toBe(pkg);
			expect(core).toBe(false);
		}
	});
});
