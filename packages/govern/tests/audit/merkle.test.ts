import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildMerkleTree,
	generateConsistencyProof,
	generateInclusionProof,
	hashInternal,
	hashLeaf,
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
