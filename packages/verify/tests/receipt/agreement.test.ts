// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * AGREEMENT IS NOT CONFORMANCE.
 *
 * A third Codex Tier-0 round found three P1s in the offline receipt verifier
 * and they were one defect three times. The verifier checked that the RECEIPT
 * AGREES WITH THE SNAPSHOT and stopped there — but in this threat model both
 * documents are inputs, and two inputs agreeing proves only that one party
 * wrote both. Where the spec fixes a LITERAL, the literal has to be checked
 * against the SPEC, independently, before agreement is worth anything:
 *
 *  · §4a fixes proxy-v1's `event.actor` to exactly
 *    `{type:"system", id:"receipt-minter", name:"receipt-minter"}`. A receipt
 *    carrying a string, a `null`, or an object with an extra member verified,
 *    provided the pinned chain's `mintActor` was malformed in the same way.
 *  · §4a/§8 give ut1 v1 no SDK mint keys at all — `minter.kind` is the literal
 *    `proxy`. A snapshot registering `minterKind: "sdk"` and a receipt saying
 *    `"sdk"` agreed, and verified.
 *  · §8 makes a keyId globally unique and hangs every rule it has — role,
 *    state, rotation boundary, lineage, vault ownership — off that ID. Two
 *    keyIds over IDENTICAL key material gave every one of those rules two
 *    answers for one signing capability, and the ID-keyed
 *    one-lineage-one-vault check could not see it.
 *
 * Each vector below makes BOTH documents say the same wrong thing, which is
 * what separates this file from the equality tests in `steps.test.ts`: those
 * mutate one side and watch the comparison fail, and every one of them stayed
 * green while these verified. And each block ends with the clean case, because
 * a verifier that rejects good receipts is exactly as broken as one that
 * accepts bad ones.
 */

import { describe, expect, it } from "vitest";
import {
	loadTrustSnapshot,
	type TrustSnapshotLoad,
	verifyReceiptBase,
} from "../../src/receipt-verify.js";
import {
	CHECKPOINT_KEY,
	FOREIGN_KEY,
	type HarnessKey,
	MINT_ACTOR,
	MINT_KEY,
	type MintedBundle,
	type MintOptions,
	mint,
	PROFILE,
	type TrustSnapshot,
	VAULT_ID,
} from "./harness.js";

type Run = ReturnType<typeof verifyReceiptBase>;

/** The run, or the load refusal that stopped it from happening. */
type Outcome = { readonly loaded: true; readonly run: Run } | { readonly loaded: false };

function outcomeOf(bundle: MintedBundle): Outcome {
	const load: TrustSnapshotLoad = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) return { loaded: false };
	return {
		loaded: true,
		run: verifyReceiptBase({ receiptBytes: bundle.receiptBytes, snapshot: load.snapshot }),
	};
}

function verifyMinted(options: MintOptions = {}): Run {
	const outcome = outcomeOf(mint(options));
	if (!outcome.loaded) throw new Error("fixture snapshot did not load");
	return outcome.run;
}

function expectFailure(actual: Run, step: string, code: string, what: string): void {
	expect(actual.failure, what).toMatchObject({ step, code });
}

// ─────────────────────────────────────────────────────────────────────────────
// §4a — proxy-v1's mint actor is a CLOSED form, not whatever the pair agrees on.
// ─────────────────────────────────────────────────────────────────────────────

describe("AGREEMENT IS NOT CONFORMANCE — §4a fixes proxy-v1's event.actor", () => {
	/** The vector shape: the receipt AND the registered `mintActor` say the same
	 * malformed thing, so equality 2 holds and only the literal separates them. */
	function bothSay(actor: unknown): MintOptions {
		return {
			// BEFORE the hash, so `event.hash` recomputes and the mint signature
			// verifies — this receipt is otherwise perfect.
			event: (e) => ({ ...e, actor: structuredClone(actor) }),
			snapshot: (s) => {
				(s.chains[0] as { mintActor: unknown }).mintActor = structuredClone(actor);
				return s;
			},
		};
	}

	const NOT_THE_CLOSED_FORM: ReadonlyArray<readonly [string, unknown]> = [
		["the string form", "receipt-minter"],
		["null", null],
		["an array", ["system", "receipt-minter", "receipt-minter"]],
		["a number", 7],
		["an extra member", { ...MINT_ACTOR, tenant: "acme" }],
		["a missing name", { type: "system", id: "receipt-minter" }],
		["a missing id", { type: "system", name: "receipt-minter" }],
		["a missing type", { id: "receipt-minter", name: "receipt-minter" }],
		["type `human`", { ...MINT_ACTOR, type: "human" }],
		["a different id", { ...MINT_ACTOR, id: "attacker" }],
		["a different name", { ...MINT_ACTOR, name: "attacker" }],
		["a non-string member", { ...MINT_ACTOR, name: 7 }],
		["an empty object", {}],
	];

	it.each(NOT_THE_CLOSED_FORM)(
		"refuses %s even when the pinned chain registers exactly it",
		(_label, actor) => {
			expectFailure(verifyMinted(bothSay(actor)), "event", "EVENT_MISMATCH", JSON.stringify(actor));
		},
	);

	it("still refuses a receipt whose actor alone diverges — agreement is still required", () => {
		// The other direction, unchanged: the closed-form check is ADDED to
		// equality 2, it does not replace it.
		expectFailure(
			verifyMinted({
				snapshot: (s) => {
					(s.chains[0] as { mintActor: unknown }).mintActor = "receipt-minter";
					return s;
				},
			}),
			"event",
			"EVENT_MISMATCH",
			"registered mintActor in the string form",
		);
	});

	it("verifies the closed form — and does not care about member ORDER", () => {
		expect(verifyMinted().verdict).toBe("VERIFIED_CHECKPOINT");
		// §4a fixes the MEMBERS, and the bytes are canonicalized before either
		// signature or comparison. A minter that emits them in a different order
		// is conformant, and a check written as a string compare would not be.
		expect(
			verifyMinted(bothSay({ name: "receipt-minter", type: "system", id: "receipt-minter" }))
				.verdict,
		).toBe("VERIFIED_CHECKPOINT");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §4a/§8 — ut1 v1 has no SDK mint keys, so `minter.kind` is a literal.
// ─────────────────────────────────────────────────────────────────────────────

describe("AGREEMENT IS NOT CONFORMANCE — ut1 v1's minter.kind is the literal `proxy`", () => {
	function bothSay(kind: string): MintOptions {
		return {
			receiptBeforeSign: (r) => ({ ...r, minter: { ...r.minter, kind } }),
			snapshot: (s) => {
				const key = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (key !== undefined) key.minterKind = kind;
				return s;
			},
		};
	}

	// `sdk` is the one that matters — §8 gives v1 no SDK mint keys at all, so a
	// receipt claiming one is claiming an authority the trust document cannot
	// confer. The rest are the near-misses a case- or whitespace-tolerant check
	// would wave through.
	it.each(["sdk", "SDK", "Proxy", "proxy-v1", "proxy ", "vault"])(
		"refuses minter.kind %j even when the registered key agrees",
		(kind) => {
			expectFailure(verifyMinted(bothSay(kind)), "signature", "SIG_INVALID", kind);
		},
	);

	it("still refuses a receipt whose kind alone diverges — agreement is still required", () => {
		expectFailure(
			verifyMinted({
				snapshot: (s) => {
					const key = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
					if (key !== undefined) key.minterKind = "sdk";
					return s;
				},
			}),
			"signature",
			"SIG_INVALID",
			"registered minterKind sdk against a conformant receipt",
		);
	});

	it("verifies the literal", () => {
		expect(verifyMinted(bothSay("proxy")).verdict).toBe("VERIFIED_CHECKPOINT");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — one key material, one keyId. Every rule the loader has is ID-keyed.
// ─────────────────────────────────────────────────────────────────────────────

describe("AGREEMENT IS NOT CONFORMANCE — §8's keyId is an identity, not a label", () => {
	function alias(keyId: string, of: HarnessKey, extra: Record<string, unknown>) {
		return {
			keyId,
			alg: "ed25519",
			publicKey: of.publicKeyPem,
			state: "active",
			...extra,
		} as unknown as TrustSnapshot["keys"][number];
	}

	it("refuses two CHECKPOINT keyIds over one material, pinned by two vaults", () => {
		// §8: "a lineage trusted by two vaults makes the document invalid" —
		// because `proof.chain` is receipt-signed only and could not settle which
		// vault a statement belonged to. The rule is enforced over lineage
		// MEMBERSHIP, which is a set of keyIds, so registering the identical SPKI
		// under a second keyId produced two disjoint lineages over one signing
		// capability and walked straight past it.
		const bundle = mint({
			snapshot: (s) => {
				s.keys.push(alias("utk_ckpt_alias", CHECKPOINT_KEY, { role: "checkpoint" }));
				s.chains.push({
					vaultId: "vlt_ut_proxy_prod_2",
					profile: PROFILE,
					genesisSegmentId: "seg_000001",
					genesisChoice: "newVault",
					headSegmentId: "seg_000003",
					headSegmentFirstSequence: 11,
					mintActor: { ...MINT_ACTOR },
					checkpointRootKeyId: "utk_ckpt_alias",
					mintKeyIds: [],
				});
				return s;
			},
		});
		expect(loadTrustSnapshot(bundle.snapshotBytes).ok).toBe(false);
	});

	it("refuses a REVOKED key re-registered as active under a second keyId", () => {
		// The instance the review did not name, and the one that pays best: the
		// loader's state rules are per-ENTRY, so revoking `utk_mint_2026_08` and
		// re-registering its material as `utk_mint_alias`/`active` leaves the
		// revoked key signing freshly-minted receipts. The receipt names the
		// alias; the crypto is the revoked key's.
		const bundle = mint({
			receiptBeforeSign: (r) => ({ ...r, minter: { ...r.minter, keyId: "utk_mint_alias" } }),
			// `signature` is excluded from the §5 preimage, so renaming the key here
			// keeps the mint signature valid — which is the whole trick.
			receiptAfterSign: (r) => ({
				...r,
				signature: { ...(r.signature as Record<string, unknown>), keyId: "utk_mint_alias" },
			}),
			snapshot: (s) => {
				const revoked = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (revoked !== undefined) revoked.state = "revoked";
				s.keys.push(alias("utk_mint_alias", MINT_KEY, { role: "mint", minterKind: "proxy" }));
				(s.chains[0] as { mintKeyIds: string[] }).mintKeyIds.push("utk_mint_alias");
				return s;
			},
		});
		const outcome = outcomeOf(bundle);
		// UNVERIFIABLE by way of the snapshot, never VERIFIED_CHECKPOINT: §8 makes
		// ambiguity a refusal, and this document is ambiguous about whether one
		// key is revoked.
		expect(outcome.loaded).toBe(false);
	});

	it("refuses two same-role keyIds over one material even inside one vault", () => {
		const bundle = mint({
			snapshot: (s) => {
				s.keys.push(alias("utk_mint_twin", MINT_KEY, { role: "mint", minterKind: "proxy" }));
				return s;
			},
		});
		expect(loadTrustSnapshot(bundle.snapshotBytes).ok).toBe(false);
	});

	it("keeps the MORE SPECIFIC diagnostic for the role collision §8 names", () => {
		// Material shared across the mint/checkpoint roles is already refused, and
		// the general rule must not swallow the message that says WHICH separation
		// broke — an operator acts on the reason, not the redness.
		const bundle = mint({
			snapshot: (s) => {
				const checkpoint = s.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
				if (checkpoint !== undefined) checkpoint.publicKey = MINT_KEY.publicKeyPem;
				return s;
			},
		});
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		expect(load.ok).toBe(false);
		expect(load.ok === false && load.detail).toContain("mint/checkpoint roles");
	});

	it("proves the premise: the aliases really do carry identical SPKI material", () => {
		// Otherwise the vectors above could be passing for some unrelated reason.
		expect(MINT_KEY.publicKeySpkiBase64).toBe(MINT_KEY.publicKeySpkiBase64);
		expect(MINT_KEY.publicKeySpkiBase64).not.toBe(CHECKPOINT_KEY.publicKeySpkiBase64);
	});

	it("still loads the clean snapshot, and a real rotation, and a second vault", () => {
		expect(loadTrustSnapshot(mint().snapshotBytes).ok).toBe(true);
		// A DISTINCT-material second vault is legitimate and must keep loading —
		// the rule is one material one ID, not one vault per snapshot.
		const twoVaults = mint({
			snapshot: (s) => {
				s.keys.push(alias("utk_ckpt_other", FOREIGN_KEY, { role: "checkpoint" }));
				s.chains.push({
					vaultId: "vlt_ut_proxy_prod_2",
					profile: PROFILE,
					genesisSegmentId: "seg_000001",
					genesisChoice: "newVault",
					headSegmentId: "seg_000003",
					headSegmentFirstSequence: 11,
					mintActor: { ...MINT_ACTOR },
					checkpointRootKeyId: "utk_ckpt_other",
					mintKeyIds: [],
				});
				return s;
			},
		});
		expect(loadTrustSnapshot(twoVaults.snapshotBytes).ok).toBe(true);
		expect(VAULT_ID).toBe("vlt_ut_proxy_prod_1");
	});
});
