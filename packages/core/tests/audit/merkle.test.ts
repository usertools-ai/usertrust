import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildMerkleTree,
	generateConsistencyProof,
	generateInclusionProof,
	hashInternal,
	hashLeaf,
	type MerkleInclusionProof,
	type MerkleSibling,
	verifyConsistencyProof,
	verifyInclusionProof,
} from "../../src/audit/merkle.js";

// Helper: generate deterministic hex leaf data
function makeLeaf(n: number): string {
	return createHash("sha256").update(`leaf-${n}`).digest("hex");
}

describe("Merkle — hashLeaf / hashInternal", () => {
	it("hashLeaf produces a 64-char hex string", () => {
		const result = hashLeaf(makeLeaf(0));
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashLeaf is domain-separated (differs from raw SHA-256)", () => {
		const data = makeLeaf(0);
		const leafHash = hashLeaf(data);
		const rawHash = createHash("sha256").update(Buffer.from(data, "hex")).digest("hex");
		expect(leafHash).not.toBe(rawHash);
	});

	it("hashInternal is domain-separated from hashLeaf", () => {
		const a = makeLeaf(0);
		const b = makeLeaf(1);
		const internal = hashInternal(a, b);
		// A leaf hash of concatenated data should differ
		const concat = a + b;
		const leafOfConcat = hashLeaf(concat.slice(0, 64));
		expect(internal).not.toBe(leafOfConcat);
	});
});

describe("Merkle — buildMerkleTree", () => {
	it("returns undefined root for empty leaves", () => {
		const { root, layers } = buildMerkleTree([]);
		expect(root).toBeUndefined();
		expect(layers).toEqual([[]]);
	});

	it("single leaf: root = hashLeaf(leaf)", () => {
		const leaf = makeLeaf(0);
		const { root } = buildMerkleTree([leaf]);
		expect(root).toBe(hashLeaf(leaf));
	});

	it("two leaves: root = hashInternal(hashLeaf(a), hashLeaf(b))", () => {
		const a = makeLeaf(0);
		const b = makeLeaf(1);
		const { root } = buildMerkleTree([a, b]);
		expect(root).toBe(hashInternal(hashLeaf(a), hashLeaf(b)));
	});

	it("odd leaf count: last leaf is promoted, not duplicated", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2)];
		const { root, layers } = buildMerkleTree(leaves);

		// Layer 0 has 3 hashed leaves
		expect(layers[0]).toHaveLength(3);
		// Layer 1 has 2 nodes: internal(0,1) and promoted(2)
		expect(layers[1]).toHaveLength(2);
		// Layer 2 is the root
		expect(layers[2]).toHaveLength(1);
		expect(root).toBe(layers[2]?.[0]);
	});

	it("4 leaves: balanced tree", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2), makeLeaf(3)];
		const { root, layers } = buildMerkleTree(leaves);

		expect(layers[0]).toHaveLength(4);
		expect(layers[1]).toHaveLength(2);
		expect(layers[2]).toHaveLength(1);
		expect(root).toBeDefined();
	});

	it("deterministic — same leaves produce same root", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2)];
		const r1 = buildMerkleTree(leaves).root;
		const r2 = buildMerkleTree(leaves).root;
		expect(r1).toBe(r2);
	});
});

describe("Merkle — inclusion proofs", () => {
	it("generates and verifies proof for single leaf", () => {
		const leaves = [makeLeaf(0)];
		const proof = generateInclusionProof(0, leaves, "seg-1");
		expect(proof.leafIndex).toBe(0);
		expect(proof.treeSize).toBe(1);

		const valid = verifyInclusionProof(proof, proof.root, proof.treeSize);
		expect(valid).toBe(true);
	});

	it("generates and verifies proof for each leaf in a 4-leaf tree", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2), makeLeaf(3)];
		const { root } = buildMerkleTree(leaves);

		for (let i = 0; i < leaves.length; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-1");
			expect(proof.root).toBe(root);
			const valid = verifyInclusionProof(proof, root as string, leaves.length);
			expect(valid).toBe(true);
		}
	});

	it("generates and verifies proof for odd-count tree (5 leaves)", () => {
		const leaves = Array.from({ length: 5 }, (_, i) => makeLeaf(i));
		const { root } = buildMerkleTree(leaves);

		for (let i = 0; i < leaves.length; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-1");
			const valid = verifyInclusionProof(proof, root as string, leaves.length);
			expect(valid).toBe(true);
		}
	});

	it("rejects proof with wrong root", () => {
		const leaves = [makeLeaf(0), makeLeaf(1)];
		const proof = generateInclusionProof(0, leaves, "seg-1");
		const valid = verifyInclusionProof(proof, "0".repeat(64), proof.treeSize);
		expect(valid).toBe(false);
	});

	it("rejects proof with wrong tree size", () => {
		const leaves = [makeLeaf(0), makeLeaf(1)];
		const proof = generateInclusionProof(0, leaves, "seg-1");
		const valid = verifyInclusionProof(proof, proof.root, 999);
		expect(valid).toBe(false);
	});

	it("throws for out-of-bounds leaf index", () => {
		const leaves = [makeLeaf(0)];
		expect(() => generateInclusionProof(-1, leaves, "seg-1")).toThrow(RangeError);
		expect(() => generateInclusionProof(1, leaves, "seg-1")).toThrow(RangeError);
	});
});

describe("Merkle — consistency proofs", () => {
	it("same-size proof: empty proof, roots match", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2)];
		const proof = generateConsistencyProof(3, 3, leaves);
		expect(proof.proof).toHaveLength(0);
		expect(proof.firstRoot).toBe(proof.secondRoot);

		const valid = verifyConsistencyProof(proof);
		expect(valid).toBe(true);
	});

	it("1 → 2 leaves: proves append-only", () => {
		const leaves = [makeLeaf(0), makeLeaf(1)];
		const proof = generateConsistencyProof(1, 2, leaves);
		const valid = verifyConsistencyProof(proof);
		expect(valid).toBe(true);
	});

	it("2 → 4 leaves: proves append-only", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2), makeLeaf(3)];
		const proof = generateConsistencyProof(2, 4, leaves);
		const valid = verifyConsistencyProof(proof);
		expect(valid).toBe(true);
	});

	it("3 → 7 leaves: proves append-only (odd sizes)", () => {
		const leaves = Array.from({ length: 7 }, (_, i) => makeLeaf(i));
		const proof = generateConsistencyProof(3, 7, leaves);
		const valid = verifyConsistencyProof(proof);
		expect(valid).toBe(true);
	});

	it("various sizes from 1 to 10", () => {
		const leaves = Array.from({ length: 10 }, (_, i) => makeLeaf(i));
		for (let first = 1; first <= 10; first++) {
			for (let second = first; second <= 10; second++) {
				const proof = generateConsistencyProof(first, second, leaves);
				const valid = verifyConsistencyProof(proof);
				expect(valid).toBe(true);
			}
		}
	});

	it("rejects tampered consistency proof", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2), makeLeaf(3)];
		const proof = generateConsistencyProof(2, 4, leaves);
		const tamperedProof = {
			...proof,
			proof: ["0".repeat(64), ...proof.proof.slice(1)],
		};
		const valid = verifyConsistencyProof(tamperedProof);
		expect(valid).toBe(false);
	});

	it("throws for invalid sizes", () => {
		const leaves = [makeLeaf(0)];
		expect(() => generateConsistencyProof(0, 1, leaves)).toThrow(RangeError);
		expect(() => generateConsistencyProof(2, 1, leaves)).toThrow(RangeError);
		expect(() => generateConsistencyProof(1, 5, leaves)).toThrow(RangeError);
	});
});

describe("Merkle — verifyConsistencyProof edge cases", () => {
	it("rejects proof with firstSize < 1", () => {
		const valid = verifyConsistencyProof({
			firstSize: 0,
			secondSize: 2,
			firstRoot: "a".repeat(64),
			secondRoot: "b".repeat(64),
			proof: ["c".repeat(64)],
		});
		expect(valid).toBe(false);
	});

	it("rejects proof with firstSize > secondSize", () => {
		const valid = verifyConsistencyProof({
			firstSize: 5,
			secondSize: 3,
			firstRoot: "a".repeat(64),
			secondRoot: "b".repeat(64),
			proof: ["c".repeat(64)],
		});
		expect(valid).toBe(false);
	});

	it("rejects proof with different sizes but empty proof array", () => {
		const valid = verifyConsistencyProof({
			firstSize: 1,
			secondSize: 3,
			firstRoot: "a".repeat(64),
			secondRoot: "b".repeat(64),
			proof: [],
		});
		expect(valid).toBe(false);
	});
});

describe("Merkle — inclusion proof for promoted odd leaf", () => {
	it("verifies proof for the last leaf in a 3-leaf tree (promoted node)", () => {
		const leaves = [makeLeaf(0), makeLeaf(1), makeLeaf(2)];
		const { root } = buildMerkleTree(leaves);

		// Leaf at index 2 is the promoted odd leaf
		const proof = generateInclusionProof(2, leaves, "seg-odd");
		const valid = verifyInclusionProof(proof, root as string, leaves.length);
		expect(valid).toBe(true);
	});

	it("generates valid proofs for larger odd-count trees (7 leaves)", () => {
		const leaves = Array.from({ length: 7 }, (_, i) => makeLeaf(i));
		const { root } = buildMerkleTree(leaves);

		// Test the last (promoted) leaf specifically
		const proof = generateInclusionProof(6, leaves, "seg-7");
		const valid = verifyInclusionProof(proof, root as string, leaves.length);
		expect(valid).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════
// Inclusion-proof PATH TOPOLOGY validation
//
// Before this suite existed, verifyInclusionProof folded whatever
// siblings it was handed and compared the result to proof.root. It
// never derived what the path SHOULD look like for (leafIndex,
// treeSize), so a proof could claim any position it liked and still
// verify. These are the attacks that buys.
// ═══════════════════════════════════════════════════════════════

function leaves(n: number): string[] {
	return Array.from({ length: n }, (_, i) => makeLeaf(i));
}

function rootOf(n: number): string {
	return buildMerkleTree(leaves(n)).root as string;
}

/** Cast an intentionally malformed proof to the declared shape. */
function malformed(value: unknown): MerkleInclusionProof {
	return value as MerkleInclusionProof;
}

describe("Merkle — inclusion proof topology (attack matrix)", () => {
	it("rejects a forged leafIndex riding an otherwise-valid fold", () => {
		const eight = leaves(8);
		const proof = generateInclusionProof(3, eight, "seg-test");
		const forged = { ...proof, leafIndex: 5 };

		expect(verifyInclusionProof(forged, rootOf(8), 8)).toBe(false);
	});

	it("rejects padded siblings", () => {
		const proof = generateInclusionProof(3, leaves(8), "seg-pad");
		const padded = {
			...proof,
			siblings: [...proof.siblings, { hash: "0".repeat(64), position: "right" as const }],
		};

		expect(verifyInclusionProof(padded, rootOf(8), 8)).toBe(false);
	});

	it("rejects truncated siblings", () => {
		const proof = generateInclusionProof(3, leaves(8), "seg-trunc");
		const truncated = { ...proof, siblings: proof.siblings.slice(0, 2) };

		expect(verifyInclusionProof(truncated, rootOf(8), 8)).toBe(false);
	});

	it("rejects a flipped position on one level of an otherwise-valid proof", () => {
		const proof = generateInclusionProof(3, leaves(8), "seg-flip");
		const flipped = {
			...proof,
			siblings: proof.siblings.map((s, i) =>
				i === 1
					? { ...s, position: s.position === "left" ? ("right" as const) : ("left" as const) }
					: s,
			),
		};

		expect(verifyInclusionProof(flipped, rootOf(8), 8)).toBe(false);
	});

	it("rejects a non-'left'/'right' position rather than treating it as right", () => {
		const proof = generateInclusionProof(1, leaves(8), "seg-bogus");
		// The pre-fix fold read every non-"left" value as "right", so "bogus" on
		// a level whose real orientation is right verified cleanly.
		const bogus = malformed({
			...proof,
			siblings: proof.siblings.map((s, i) => (i === 1 ? { ...s, position: "bogus" } : s)),
		});

		expect(verifyInclusionProof(bogus, rootOf(8), 8)).toBe(false);
	});

	it("rejects the equal-hash flip: identical leaves refold to the same root", () => {
		// Two IDENTICAL leaves. hashInternal(sibling, self) === hashInternal(self, sibling)
		// here, so flipping the orientation still lands on the published root — only
		// topology validation can catch this one.
		const twin = makeLeaf(0);
		const pair = [twin, twin];
		const root = buildMerkleTree(pair).root as string;
		const proof = generateInclusionProof(0, pair, "seg-twin");
		expect(proof.siblings[0]?.position).toBe("right");

		const flipped = {
			...proof,
			siblings: [{ hash: proof.siblings[0]?.hash as string, position: "left" as const }],
		};
		expect(verifyInclusionProof(flipped, root, 2)).toBe(false);

		// Same fold, relabelled as the other leaf: also rejected.
		const relabelled = { ...proof, leafIndex: 1 };
		expect(verifyInclusionProof(relabelled, root, 2)).toBe(false);
	});

	it("rejects out-of-range and non-integral leafIndex values", () => {
		const proof = generateInclusionProof(3, leaves(8), "seg-idx");
		for (const leafIndex of [-1, 8, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(verifyInclusionProof({ ...proof, leafIndex }, rootOf(8), 8)).toBe(false);
		}
	});

	it("rejects non-safe-integer tree sizes even when proof and published agree", () => {
		const proof = generateInclusionProof(3, leaves(8), "seg-size");
		// 2**53 passes Number.isInteger; Number.isSafeInteger is what refuses it.
		// Infinity must be refused BEFORE the derivation loop — ceil(Infinity/2)
		// is Infinity, so the loop would never terminate.
		for (const treeSize of [0, -1, 8.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
			expect(verifyInclusionProof({ ...proof, treeSize }, rootOf(8), treeSize)).toBe(false);
		}
	});

	it("returns false — never throws — for structurally malformed proofs", () => {
		const proof = generateInclusionProof(3, leaves(8), "seg-malformed");
		const root = rootOf(8);

		const cases: MerkleInclusionProof[] = [
			malformed({ ...proof, siblings: null }),
			malformed({ ...proof, siblings: "not-an-array" }),
			malformed({ ...proof, siblings: [proof.siblings[0], undefined, proof.siblings[2]] }),
			malformed({ ...proof, siblings: [proof.siblings[0], null, proof.siblings[2]] }),
			malformed({ ...proof, siblings: proof.siblings.map(({ hash }) => ({ hash })) }),
			malformed({
				...proof,
				siblings: proof.siblings.map((s) => ({ ...s, hash: Buffer.from(s.hash, "hex") })),
			}),
			malformed({ ...proof, leafHash: undefined }),
			malformed({ ...proof, leafHash: 42 }),
		];

		for (const bad of cases) {
			expect(() => verifyInclusionProof(bad, root, 8)).not.toThrow();
			expect(verifyInclusionProof(bad, root, 8)).toBe(false);
		}
	});

	it("still verifies the final leaf of promotion-shaped trees", () => {
		// Odd leaf counts promote at level 0; 6 and 10 are EVEN yet still promote
		// at an internal level, which a ceil(log2(n)) path length gets wrong.
		for (const size of [3, 5, 6, 7, 9, 10, 11, 17]) {
			const proof = generateInclusionProof(size - 1, leaves(size), `seg-${size}`);
			expect(verifyInclusionProof(proof, rootOf(size), size)).toBe(true);
		}
	});

	it("pins the promotion-shortened orientation sequences", () => {
		const finalLeafPath = (size: number): string[] =>
			generateInclusionProof(size - 1, leaves(size), `seg-${size}`).siblings.map((s) => s.position);

		expect(finalLeafPath(6)).toEqual(["left", "left"]);
		expect(finalLeafPath(7)).toEqual(["left", "left"]);
		expect(finalLeafPath(10)).toEqual(["left", "left"]);
		expect(finalLeafPath(17)).toEqual(["left"]);
	});
});

describe("Merkle — inclusion proof read discipline (hostile objects)", () => {
	// These defend the EXPORTED function's "untrusted input" contract against
	// objects a caller built by hand. No vault ingestion path can reach them —
	// a JSON-parsed proof carries plain data properties — but verifyInclusionProof
	// is a public export and its contract makes no such assumption.
	//
	// A valid leaf-0 proof in a 4-leaf tree has orientations [right, right];
	// leafIndex 2 derives [right, left]. Each fixture below shows one face to
	// the validation pass and the other to a fold that re-reads.

	function fourLeaf(): { root: string; proof: MerkleInclusionProof } {
		return { root: rootOf(4), proof: generateInclusionProof(0, leaves(4), "seg-hostile") };
	}

	it("rejects a `position` getter that flips between validation and the fold", () => {
		const { root, proof } = fourLeaf();
		let reads = 0;
		const hostile = {
			hash: (proof.siblings[1] as MerkleSibling).hash,
			get position(): string {
				reads += 1;
				return reads === 1 ? "left" : "right";
			},
		};
		const forged = malformed({
			...proof,
			leafIndex: 2,
			siblings: [proof.siblings[0], hostile],
		});

		expect(verifyInclusionProof(forged, root, 4)).toBe(false);
		// One read per property, total — the fold must never come back for more.
		expect(reads).toBe(1);
	});

	it("rejects an array whose Symbol.iterator yields a different path", () => {
		const { root, proof } = fourLeaf();
		const real = proof.siblings[1] as MerkleSibling;
		const indexed: unknown[] = [proof.siblings[0], { ...real, position: "left" }];
		Object.defineProperty(indexed, Symbol.iterator, {
			value: function* () {
				yield proof.siblings[0];
				yield real;
			},
		});
		const forged = malformed({ ...proof, leafIndex: 2, siblings: indexed });

		expect(verifyInclusionProof(forged, root, 4)).toBe(false);
	});

	it("returns false for a proof that is not an object at all", () => {
		const root = rootOf(4);
		for (const bad of [null, undefined, 42, "proof", true, Symbol("p")]) {
			expect(() => verifyInclusionProof(malformed(bad), root, 4)).not.toThrow();
			expect(verifyInclusionProof(malformed(bad), root, 4)).toBe(false);
		}
	});

	it("returns false when any field accessor throws", () => {
		const { root, proof } = fourLeaf();
		for (const field of ["treeSize", "root", "leafIndex", "leafHash", "siblings"]) {
			const hostile = { ...proof };
			Object.defineProperty(hostile, field, {
				get(): never {
					throw new Error(`hostile ${field}`);
				},
			});
			expect(() => verifyInclusionProof(malformed(hostile), root, 4)).not.toThrow();
			expect(verifyInclusionProof(malformed(hostile), root, 4)).toBe(false);
		}
	});

	it("returns false when a sibling's index or accessor throws", () => {
		const { root, proof } = fourLeaf();

		const throwingIndex: unknown[] = [proof.siblings[0], proof.siblings[1]];
		Object.defineProperty(throwingIndex, "1", {
			get(): never {
				throw new Error("hostile index");
			},
			configurable: true,
		});
		const byIndex = malformed({ ...proof, siblings: throwingIndex });
		expect(() => verifyInclusionProof(byIndex, root, 4)).not.toThrow();
		expect(verifyInclusionProof(byIndex, root, 4)).toBe(false);

		for (const field of ["hash", "position"]) {
			const sibling = { ...(proof.siblings[1] as MerkleSibling) };
			Object.defineProperty(sibling, field, {
				get(): never {
					throw new Error(`hostile ${field}`);
				},
			});
			const forged = malformed({ ...proof, siblings: [proof.siblings[0], sibling] });
			expect(() => verifyInclusionProof(forged, root, 4)).not.toThrow();
			expect(verifyInclusionProof(forged, root, 4)).toBe(false);
		}
	});

	it("returns false for a revoked proxy", () => {
		const { root, proof } = fourLeaf();
		const { proxy, revoke } = Proxy.revocable({ ...proof }, {});
		revoke();

		expect(() => verifyInclusionProof(malformed(proxy), root, 4)).not.toThrow();
		expect(verifyInclusionProof(malformed(proxy), root, 4)).toBe(false);
	});
});

describe("Merkle — inclusion proof round-trip and position uniqueness", () => {
	it("every generated proof verifies, for every leaf of trees sized 1..33", () => {
		for (let size = 1; size <= 33; size++) {
			const set = leaves(size);
			const root = buildMerkleTree(set).root as string;
			for (let i = 0; i < size; i++) {
				const proof = generateInclusionProof(i, set, `seg-${size}`);
				expect(verifyInclusionProof(proof, root, size)).toBe(true);
			}
		}
	});

	it("no valid proof verifies at any other leaf index, for trees sized 2..17", () => {
		// The theorem the fix establishes: within one tree the orientation
		// sequence uniquely identifies the leaf position. A pair of distinct
		// indices sharing a sequence AND folding to the root would be a real
		// hole — investigate rather than weakening this.
		for (let size = 2; size <= 17; size++) {
			const set = leaves(size);
			const root = buildMerkleTree(set).root as string;
			for (let i = 0; i < size; i++) {
				const proof = generateInclusionProof(i, set, `seg-${size}`);
				for (let claimed = 0; claimed < size; claimed++) {
					if (claimed === i) continue;
					expect(verifyInclusionProof({ ...proof, leafIndex: claimed }, root, size)).toBe(false);
				}
			}
		}
	});
});
