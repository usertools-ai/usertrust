// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — EXTERNAL ANCHORING ADVERSARIAL CORPUS (spec §10, constraints §5.11)
 *
 * Every attack asserts the exact FAIL state + reason code. Fixtures are built
 * by the real writer + emitter, then mutated. Row numbers reference
 * docs/superpowers/specs/2026-07-26-external-anchoring-design.md §10.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyTransaction as pkgVerifyTransaction } from "../../../../verify/src/index.js";
import { createAnchorEmitter } from "../../../src/audit/anchor.js";
import { anchorPayloadHash } from "../../../src/audit/anchor-verify.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import { exitCodeForAnchored } from "../../../src/audit/verify.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	computeRoot,
	makeAnchoredVault,
	mutateAndRechain,
	nextPayload,
	pubPemFromKeyFile,
	restoreVault,
	rotateOnce,
	signRecord,
	snapshotVault,
	storeRaw,
	storeRecords,
	truncateVault,
	verify,
} from "./fixtures.js";

afterEach(() => {
	cleanupAll();
});

describe("HARDEN: anchoring corpus — mutation / deletion / rollback (rows 1-5)", () => {
	it("1. F1 KILL: mutate anchored event + full re-chain + .meta rewrite → ANCHOR_MISMATCH/root-mismatch; --tx never prints INCLUSION VERIFIED", async () => {
		const s = await makeAnchoredVault(5);
		await anchorOnce(s);
		mutateAndRechain(s, 1);

		// The pre-anchor verifier is blind to this by construction: the chain
		// is internally consistent again. The anchor closes exactly this hole.
		const result = verify(s);
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("root-mismatch");
		expect(result.valid).toBe(false);
		expect(exitCodeForAnchored(result, {})).toBe(1);

		// AC-5.1: the receipt must not overclaim either.
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_2", {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust,
			witness: { requested: false },
		});
		expect(tx.receipt).not.toContain("INCLUSION VERIFIED");
		expect(tx.valid).toBe(false);
	});

	it("2. F2 KILL: delete the ENTIRE audit tree; external anchor supplied → ANCHOR_MISMATCH/deletion, exit 1", async () => {
		const s = await makeAnchoredVault(5);
		await anchorOnce(s);
		rmSync(join(s.vaultPath, "audit"), { recursive: true, force: true });

		const result = verify(s);
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("deletion");
		expect(result.valid).toBe(false);
		expect(exitCodeForAnchored(result, {})).toBe(1);
	});

	it("3. tail truncation below latest treeSize + .meta rewrite → ANCHOR_MISMATCH/rollback", async () => {
		const s = await makeAnchoredVault(6);
		await anchorOnce(s);
		truncateVault(s, 3);

		const result = verify(s);
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("rollback");
	});

	it("4. rollback to an older internally-valid snapshot → ANCHOR_MISMATCH/rollback (AC-1.3)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const snap = snapshotVault(s);
		await appendEvents(s.root, 3, 4);
		await anchorOnce(s);
		restoreVault(s, snap);

		const result = verify(s);
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("rollback");
	});

	it("5. fork: rewrite events ≤ treeSize, regrow chain → root-mismatch + consistency-failure (AC-1.4, row 17)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 3, 4);
		await anchorOnce(s);
		mutateAndRechain(s, 1);

		const result = verify(s);
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("root-mismatch");
		// The consistency proof is BOUND to the signed roots — the bare
		// verifyConsistencyProof call would pass on the re-chained leaves.
		expect(result.anchoring.reasons).toContain("consistency-failure");
	});
});

describe("HARDEN: anchoring corpus — forged trust material (rows 6-7)", () => {
	it("6. attacker keypair re-signs full history; auditor pins the real root → ANCHOR_INVALID (AC-6.3)", async () => {
		const s = await makeAnchoredVault(4);
		await anchorOnce(s);
		const real = storeRecords(s)[0] as NonNullable<ReturnType<typeof storeRecords>[0]>;

		// Attacker: own keypair, correct roots, re-signed records.
		const attacker = await makeAnchoredVault(1); // just for its keypair
		const forged = signRecord(
			{
				v: 1,
				vaultId: real.vaultId,
				anchorSeq: 1,
				prevAnchorHash: real.prevAnchorHash,
				treeSize: real.treeSize,
				lastHash: real.lastHash,
				merkleRoot: real.merkleRoot,
				timestamp: real.timestamp,
				keyId: (await import("../../../src/audit/anchor-verify.js")).keyIdFromKeyObject(
					(await import("node:crypto")).createPublicKey(
						(await import("node:crypto")).createPrivateKey(
							(await import("node:fs")).readFileSync(attacker.keyFile, "utf-8"),
						),
					),
				),
			},
			attacker.keyFile,
		);
		// Attacker also wipes the vault mirror (they own the vault).
		writeFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "");

		const result = verify(s, { external: [`${canonicalize(forged)}\n`] });
		expect(result.anchorState).toBe("ANCHOR_INVALID");
		expect(result.anchoring.reasons).toContain("sig-invalid");
	});

	it("7. key swap inside the vault: doctored identity.json + attacker-signed mirror → ANCHOR_INVALID (pinned root governs)", async () => {
		const s = await makeAnchoredVault(4);
		await anchorOnce(s);
		const real = storeRecords(s)[0] as NonNullable<ReturnType<typeof storeRecords>[0]>;

		const attacker = await makeAnchoredVault(1);
		const attackerPub = pubPemFromKeyFile(attacker.keyFile);
		const { keyIdFromKeyObject, publicKeyFromPem } = await import(
			"../../../src/audit/anchor-verify.js"
		);
		const attackerKeyId = keyIdFromKeyObject(
			publicKeyFromPem(attackerPub) as NonNullable<ReturnType<typeof publicKeyFromPem>>,
		);
		const forged = signRecord(
			{
				v: 1,
				vaultId: real.vaultId,
				anchorSeq: 1,
				prevAnchorHash: real.prevAnchorHash,
				treeSize: real.treeSize,
				lastHash: real.lastHash,
				merkleRoot: real.merkleRoot,
				timestamp: real.timestamp,
				keyId: attackerKeyId,
			},
			attacker.keyFile,
		);
		// Attacker rewrites mirror + identity.json inside the vault.
		writeFileSync(
			join(s.vaultPath, "audit", "anchors", "anchors.jsonl"),
			`${canonicalize(forged)}\n`,
		);
		writeFileSync(
			join(s.vaultPath, "audit", "anchors", "identity.json"),
			JSON.stringify({
				v: 1,
				vaultId: real.vaultId,
				keyId: attackerKeyId,
				publicKeySpki: "x",
				createdAt: "now",
			}),
		);

		// Auditor supplies NO external artifacts (mirror-only) but pins the
		// REAL root key — the vault-resident key material must be ignored.
		const result = verify(s, { external: [] });
		expect(result.anchorState).toBe("ANCHOR_INVALID");
		expect(result.anchoring.reasons).toContain("sig-invalid");
	});
});

describe("HARDEN: anchoring corpus — anchor-history integrity (rows 8-14)", () => {
	it("8. gap: middle record deleted from the supplied set (mirror wiped) → anchor-chain-gap (AC-1.5)", async () => {
		const s = await makeAnchoredVault(2);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 3);
		await anchorOnce(s);
		await appendEvents(s.root, 2, 5);
		await anchorOnce(s);
		const records = storeRecords(s);
		expect(records.length).toBe(3);
		const withGap = [records[0], records[2]].map((r) => canonicalize(r as object)).join("\n");
		writeFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "");

		const result = verify(s, { external: [withGap] });
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("anchor-chain-gap");
	});

	it("9. monotonicity: decreasing treeSize across records → ANCHOR_MISMATCH", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		// Key-holder signs a syntactically valid successor with SMALLER treeSize.
		const shrunk = signRecord(
			nextPayload(s, r1, {
				treeSize: 2,
				lastHash: (await import("../../../src/audit/anchor-verify.js")).gatherOrderedEventHashes(
					s.vaultPath,
				)[1] as string,
				merkleRoot: computeRoot(s, 2),
			}),
			s.keyFile,
		);
		const result = verify(s, { external: [`${storeRaw(s)}${canonicalize(shrunk)}\n`] });
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("rollback");
	});

	it("10. fork evidence: same prevAnchorHash, same key, DIVERGENT content → ANCHOR_MISMATCH/fork", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		await appendEvents(s.root, 2, 4);
		const a = signRecord(nextPayload(s, r1), s.keyFile);
		const b = signRecord(
			nextPayload(s, r1, {
				treeSize: 4,
				lastHash: (await import("../../../src/audit/anchor-verify.js")).gatherOrderedEventHashes(
					s.vaultPath,
				)[3] as string,
				merkleRoot: computeRoot(s, 4),
			}),
			s.keyFile,
		);
		const result = verify(s, {
			external: [`${canonicalize(r1)}\n${canonicalize(a)}\n${canonicalize(b)}\n`],
		});
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("fork");
	});

	it("11. benign duplicate: identical modulo timestamp/sig → ANCHORED_VERIFIED + duplicate-anchor warning", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const { sig: _sig, ...payload } = r1;
		const dup = signRecord(
			{ ...payload, timestamp: new Date(Date.now() + 5000).toISOString() },
			s.keyFile,
		);
		const result = verify(s, { external: [`${canonicalize(r1)}\n${canonicalize(dup)}\n`] });
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.warnings).toContain("duplicate-anchor");
		expect(result.valid).toBe(true);
	});

	it("12. emitter race with the lock: exactly one record minted, loser skips", async () => {
		const s = await makeAnchoredVault(3);
		const mk = () =>
			createAnchorEmitter(s.root, {
				signer: { type: "pem", file: s.keyFile },
				sinks: [{ type: "file", path: s.storeFile }],
			});
		const e1 = mk();
		const e2 = mk();
		const [r1, r2] = await Promise.all([e1.anchorNow(), e2.anchorNow()]);
		await e1.stop();
		await e2.stop();
		const emitted = [r1, r2].filter((r) => r.emitted);
		const skipped = [r1, r2].filter((r) => !r.emitted);
		expect(emitted.length).toBe(1);
		expect(skipped.length).toBe(1);
		expect(["locked", "no-new-events"]).toContain(skipped[0]?.reason);
		expect(storeRecords(s).length).toBe(1);
		const result = verify(s);
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
	});

	it("13. mirror↔external disagreement at one anchorSeq → ANCHOR_MISMATCH/mirror-disagreement; external governs (AC-1.2)", async () => {
		const s = await makeAnchoredVault(4);
		const r1 = await anchorOnce(s);
		// Key-holding attacker rewrites the MIRROR copy with a different root.
		const { sig: _sig, ...payload } = r1;
		const doctored = signRecord(
			{
				...payload,
				merkleRoot: computeRoot(s, 2),
				treeSize: 2,
				lastHash: (await import("../../../src/audit/anchor-verify.js")).gatherOrderedEventHashes(
					s.vaultPath,
				)[1] as string,
			},
			s.keyFile,
		);
		writeFileSync(
			join(s.vaultPath, "audit", "anchors", "anchors.jsonl"),
			`${canonicalize(doctored)}\n`,
		);
		const result = verify(s);
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("mirror-disagreement");
	});

	it("14. cross-vault replay: valid record from another vaultId → ANCHOR_MISMATCH/vault-id-mismatch", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const other = await makeAnchoredVault(3);
		const foreign = await anchorOnce(other);
		const result = verify(s, {
			external: [`${storeRaw(s)}${canonicalize(foreign)}\n`],
		});
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("vault-id-mismatch");

		// expectedVaultId pinning also rejects a wholesale-substituted set.
		const pinned = verify(s, {
			external: [canonicalize(foreign)],
			expectedVaultId: storeRecords(s)[0]?.vaultId as string,
		});
		expect(pinned.anchorState).toBe("ANCHOR_MISMATCH");
		expect(pinned.anchoring.reasons).toContain("vault-id-mismatch");
	});
});

describe("HARDEN: anchoring corpus — malformed / degenerate records (rows 15-16)", () => {
	it("15. corrupt JSON and unknown extra fields → ANCHOR_INVALID (fail-closed)", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const corrupt = verify(s, { external: ["{not json"] });
		expect(corrupt.anchorState).toBe("ANCHOR_INVALID");

		const extra = { ...JSON.parse(canonicalize(r1)), smuggled: true };
		const withExtra = verify(s, { external: [JSON.stringify(extra)] });
		expect(withExtra.anchorState).toBe("ANCHOR_INVALID");
		expect(withExtra.anchoring.reasons).toContain("malformed-anchor");
	});

	it("16. degenerate numerics (treeSize 0 / negative / float / unsafe) → ANCHOR_INVALID/range-invalid, NO throw", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const base = JSON.parse(canonicalize(r1)) as Record<string, unknown>;
		for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
			const record = { ...base, treeSize: bad };
			const result = verify(s, { external: [JSON.stringify(record)] });
			expect(result.anchorState).toBe("ANCHOR_INVALID");
			expect(result.anchoring.reasons).toContain("range-invalid");
		}
	});
});

describe("HARDEN: anchoring corpus — freshness / trust-material states (rows 18-23)", () => {
	it("18. stale beyond thresholds → ANCHOR_STALE; exit 0 default, 1 strict", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 5, 4);
		const result = verify(s, { maxUnanchoredEvents: 2 });
		expect(result.anchorState).toBe("ANCHOR_STALE");
		expect(result.valid).toBe(true);
		expect(exitCodeForAnchored(result, {})).toBe(0);
		expect(exitCodeForAnchored(result, { requireAnchor: true })).toBe(1);

		const aged = verify(s, { maxAnchorAgeMs: 1, nowMs: Date.now() + 3_600_000 });
		expect(aged.anchorState).toBe("ANCHOR_STALE");
	});

	it("19. future-dated timestamp on the newest anchor → future-timestamp warning; event threshold still fires", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const result = verify(s, { nowMs: Date.parse(r1.timestamp) - 60_000 });
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.warnings).toContain("future-timestamp");

		// Clock gaming cannot defuse the clock-independent control.
		await appendEvents(s.root, 5, 4);
		const stale = verify(s, {
			nowMs: Date.parse(r1.timestamp) - 60_000,
			maxUnanchoredEvents: 2,
		});
		expect(stale.anchorState).toBe("ANCHOR_STALE");
	});

	it("20. anchors present, no trust material → ANCHOR_UNVERIFIABLE/no-trust-material; exit 0 default, 1 strict", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const result = verify(s, { trust: undefined });
		expect(result.anchorState).toBe("ANCHOR_UNVERIFIABLE");
		expect(result.anchoring.reasons).toContain("no-trust-material");
		expect(result.valid).toBe(true);
		expect(exitCodeForAnchored(result, {})).toBe(0);
		expect(exitCodeForAnchored(result, { requireAnchor: true })).toBe(1);
	});

	it("21. legacy vault, no anchors anywhere → UNANCHORED; exit 0 default, 1 strict (AC-4.1)", async () => {
		const root = (await import("./fixtures.js")).tmp("anchor-legacy-");
		await appendEvents(root, 3);
		const { verifyVaultWithAnchors } = await import("../../../src/audit/verify.js");
		const { VAULT_DIR } = await import("../../../src/shared/constants.js");
		const result = verifyVaultWithAnchors(join(root, VAULT_DIR));
		expect(result.anchorState).toBe("UNANCHORED");
		expect(result.valid).toBe(true);
		expect(exitCodeForAnchored(result, {})).toBe(0);
		expect(exitCodeForAnchored(result, { requireAnchor: true })).toBe(1);
	});

	it("22. witness unreachable → ANCHOR_UNVERIFIABLE/witness-unreachable; NEVER ANCHORED_VERIFIED from the mirror (AC-2.4)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		// Mirror intact + trust supplied — without the witness rule this would
		// be mirror-only ANCHORED_VERIFIED. The failed fetch caps it.
		const result = verify(s, {
			external: [],
			witness: { requested: true, ok: false, error: "ECONNREFUSED" },
		});
		expect(result.anchorState).toBe("ANCHOR_UNVERIFIABLE");
		expect(result.anchoring.reasons).toContain("witness-unreachable");
		expect(result.anchoring.witness.status).toBe("unreachable");
		expect(result.valid).toBe(true);
		expect(exitCodeForAnchored(result, {})).toBe(0);
		expect(exitCodeForAnchored(result, { requireAnchor: true })).toBe(1);
	});

	it("23. witness disagrees: fetched record contradicts the vault → ANCHOR_MISMATCH, always exit 1", async () => {
		const s = await makeAnchoredVault(4);
		const r1 = await anchorOnce(s);
		const { sig: _sig, ...payload } = r1;
		const contradicting = signRecord(
			{
				...payload,
				merkleRoot: computeRoot(s, 2),
				treeSize: 2,
				lastHash: (await import("../../../src/audit/anchor-verify.js")).gatherOrderedEventHashes(
					s.vaultPath,
				)[1] as string,
			},
			s.keyFile,
		);
		const result = verify(s, {
			external: [canonicalize(contradicting)],
			witness: { requested: true, ok: true },
		});
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.witness.status).toBe("disagrees");
		expect(exitCodeForAnchored(result, {})).toBe(1);
	});
});

describe("HARDEN: anchoring corpus — rotation (rows 24-28)", () => {
	it("24. records after a rotation still signed by the superseded key → ANCHOR_MISMATCH/rotation-continuity", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		await rotateOnce(s);
		await appendEvents(s.root, 1, 5);
		const rotation = storeRecords(s).at(-1) as NonNullable<ReturnType<typeof storeRecords>[0]>;
		// Old key signs a post-rotation record (keyId still the OLD key's).
		const stale = signRecord({ ...nextPayload(s, rotation), keyId: rotation.keyId }, s.keyFile);
		const result = verify(s, { external: [`${storeRaw(s)}${canonicalize(stale)}\n`] });
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("rotation-continuity");
	});

	it("25. genesis under a successor pin instead of the root → ANCHOR_MISMATCH (valid sig, wrong position)", async () => {
		const s = await makeAnchoredVault(3);
		const other = await makeAnchoredVault(3);
		// "Successor" key = other vault's key, supplied as a pin. A history
		// rooted at the PIN (not the root) must not verify from genesis.
		const otherPub = pubPemFromKeyFile(other.keyFile);
		const foreignSigned = await anchorOnce(other);
		const rewritten = {
			...foreignSigned,
			vaultId: storeRecords(s)[0]?.vaultId ?? foreignSigned.vaultId,
		};
		void rewritten;
		// Simplest concrete form: vault s's genesis anchor re-signed by the
		// pin key (attacker compromised an old successor pin).
		const real = await anchorOnce(s);
		const { sig: _s2, ...payload } = real;
		const { keyIdFromKeyObject, publicKeyFromPem } = await import(
			"../../../src/audit/anchor-verify.js"
		);
		const pinKeyId = keyIdFromKeyObject(
			publicKeyFromPem(otherPub) as NonNullable<ReturnType<typeof publicKeyFromPem>>,
		);
		const resigned = signRecord({ ...payload, keyId: pinKeyId }, other.keyFile);
		writeFileSync(join(s.vaultPath, "audit", "anchors", "anchors.jsonl"), "");
		const result = verify(s, {
			external: [canonicalize(resigned)],
			trust: { rootPem: s.rootPem, successorPinsPem: [otherPub] },
		});
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("rotation-continuity");
	});

	it("26. rotation hijack with pins supplied: rotation to an unpinned key → ANCHOR_MISMATCH/rotation-unpinned", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		const attacker = await rotateOnce(s); // rotation to a key the auditor did NOT pin
		void attacker;
		const legit = await makeAnchoredVault(1); // unrelated key the auditor pinned
		const result = verify(s, {
			trust: { rootPem: s.rootPem, successorPinsPem: [pubPemFromKeyFile(legit.keyFile)] },
		});
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("rotation-unpinned");
	});

	it("27. rotation without pins: accepted + prominent rotation-unpinned warning; successor chain verifies", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		const successor = await rotateOnce(s);
		await appendEvents(s.root, 1, 5);
		await anchorOnce(s, successor.keyFile);

		const result = verify(s);
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.warnings).toContain("rotation-unpinned");

		// With the successor properly pinned: clean pass, no warning.
		const pinned = verify(s, {
			trust: { rootPem: s.rootPem, successorPinsPem: [successor.publicKeyPem] },
		});
		expect(pinned.anchorState).toBe("ANCHORED_VERIFIED");
		expect(pinned.anchoring.warnings).not.toContain("rotation-unpinned");
	});

	it("28. competing rotations extending the same predecessor → ANCHOR_MISMATCH/fork", async () => {
		const s = await makeAnchoredVault(3);
		const r1 = await anchorOnce(s);
		const attacker = await makeAnchoredVault(1);
		const attackerSpki = (await import("node:crypto"))
			.createPublicKey(
				(await import("node:crypto")).createPrivateKey(
					(await import("node:fs")).readFileSync(attacker.keyFile, "utf-8"),
				),
			)
			.export({ type: "spki", format: "der" }) as Buffer;
		const { keyIdFromSpkiDer } = await import("../../../src/audit/anchor-verify.js");
		const rotA = signRecord(
			{
				...nextPayload(s, r1),
				rotation: {
					nextKeyId: keyIdFromSpkiDer(attackerSpki),
					nextPublicKeySpki: attackerSpki.toString("base64"),
				},
			},
			s.keyFile,
		);
		const legit = await mintKeyFor(s);
		const rotB = signRecord(
			{
				...nextPayload(s, r1),
				timestamp: new Date(Date.now() + 1000).toISOString(),
				rotation: legit,
			},
			s.keyFile,
		);
		const result = verify(s, {
			external: [`${canonicalize(r1)}\n${canonicalize(rotA)}\n${canonicalize(rotB)}\n`],
		});
		expect(result.anchorState).toBe("ANCHOR_MISMATCH");
		expect(result.anchoring.reasons).toContain("fork");
	});
});

async function mintKeyFor(s: Awaited<ReturnType<typeof makeAnchoredVault>>): Promise<{
	nextKeyId: string;
	nextPublicKeySpki: string;
}> {
	const { readAnchorIdentity, mintSuccessorKey } = await import("../../../src/audit/anchor.js");
	const identity = readAnchorIdentity(s.root);
	if (identity === null) throw new Error("no identity");
	const k = mintSuccessorKey(identity.vaultId);
	return { nextKeyId: k.keyId, nextPublicKeySpki: k.publicKeySpki };
}

describe("HARDEN: anchoring corpus — strict gates + happy paths (rows 29-30)", () => {
	it("29. mirror-only + --require-external-anchor → exit 1 (state stays ANCHORED_VERIFIED)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const result = verify(s, { external: [] });
		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.anchorSource).toBe("vault-mirror");
		expect(exitCodeForAnchored(result, {})).toBe(0);
		expect(exitCodeForAnchored(result, { requireExternalAnchor: true })).toBe(1);
	});

	it("30. happy paths: single anchor / full history / grown chain / post-rotation keyring → ANCHORED_VERIFIED", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 3, 4);
		await anchorOnce(s);

		// Full history.
		const full = verify(s);
		expect(full.anchorState).toBe("ANCHORED_VERIFIED");
		expect(full.anchoring.anchorSource).toBe("external");
		expect(full.valid).toBe(true);
		expect(exitCodeForAnchored(full, { requireAnchor: true, requireExternalAnchor: true })).toBe(0);

		// Single latest checkpoint (mirror supplies linkage).
		const latest = storeRecords(s).at(-1) as NonNullable<ReturnType<typeof storeRecords>[0]>;
		const single = verify(s, { external: [canonicalize(latest)] });
		expect(single.anchorState).toBe("ANCHORED_VERIFIED");

		// Grown chain: unanchored tail reported, consistency binding holds.
		await appendEvents(s.root, 2, 7);
		const grown = verify(s);
		expect(grown.anchorState).toBe("ANCHORED_VERIFIED");
		expect(grown.anchoring.unanchoredTail.events).toBe(2);

		// Anchored --tx receipt renders the honest INCLUSION line.
		const tx = pkgVerifyTransaction(s.vaultPath, "tr_2", {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust,
			witness: { requested: false },
		});
		expect(tx.valid).toBe(true);
		expect(tx.receipt).toContain("INCLUSION VERIFIED (anchor #");

		// Tail event: honest label, never "verified".
		const tail = pkgVerifyTransaction(s.vaultPath, "tr_8", {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust,
			witness: { requested: false },
		});
		expect(tail.receipt).toContain("IN UNANCHORED TAIL");
		expect(tail.receipt).not.toContain("INCLUSION VERIFIED");
	});
});
