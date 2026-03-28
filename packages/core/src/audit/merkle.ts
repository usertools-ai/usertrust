// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Merkle Tree — RFC 6962 domain-separated hashing
 *
 * Pure functions for building, proving, and verifying Merkle trees.
 * No I/O, no side effects. All hash fields are hex-encoded strings.
 *
 * Domain-separated hashing (RFC 6962 Section 2.1):
 *   - Leaves:    SHA-256(0x00 || data)
 *   - Internal:  SHA-256(0x01 || left || right)
 *
 * Odd leaves are promoted to the next layer (NOT duplicated),
 * avoiding CVE-2012-2459.
 */

import { createHash } from "node:crypto";

// ── Constants ──

const LEAF_PREFIX = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

// ── Types ──

export interface MerkleSibling {
	readonly hash: string;
	readonly position: "left" | "right";
}

export interface MerkleInclusionProof {
	readonly version: 1;
	readonly leafHash: string;
	readonly leafIndex: number;
	readonly treeSize: number;
	readonly root: string;
	readonly siblings: readonly MerkleSibling[];
	readonly segmentId: string;
}

export interface MerkleConsistencyProof {
	readonly firstSize: number;
	readonly secondSize: number;
	readonly firstRoot: string;
	readonly secondRoot: string;
	readonly proof: readonly string[];
}

// ── Core hash functions ──

/**
 * Hash a leaf node with domain separation.
 * Input: hex-encoded data string.
 * Output: hex-encoded SHA-256 hash.
 */
export function hashLeaf(data: string): string {
	const dataBuffer = Buffer.from(data, "hex");
	return createHash("sha256").update(LEAF_PREFIX).update(dataBuffer).digest("hex");
}

/**
 * Hash an internal node with domain separation.
 * Inputs: two hex-encoded child hashes.
 * Output: hex-encoded SHA-256 hash.
 */
export function hashInternal(left: string, right: string): string {
	const leftBuffer = Buffer.from(left, "hex");
	const rightBuffer = Buffer.from(right, "hex");
	return createHash("sha256")
		.update(INTERNAL_PREFIX)
		.update(leftBuffer)
		.update(rightBuffer)
		.digest("hex");
}

// ── Tree building ──

/**
 * Build a complete Merkle tree from an array of leaf hashes.
 *
 * Returns all layers (layer 0 = hashed leaves, last layer = [root]).
 * Empty input returns { root: undefined, layers: [[]] }.
 *
 * Odd-count layers: the last node is promoted (not duplicated).
 */
export function buildMerkleTree(leaves: string[]): {
	root: string | undefined;
	layers: string[][];
} {
	if (leaves.length === 0) {
		return { root: undefined, layers: [[]] };
	}

	let currentLayer: string[] = leaves.map((leaf) => hashLeaf(leaf));
	const layers: string[][] = [currentLayer];

	while (currentLayer.length > 1) {
		const nextLayer: string[] = [];
		for (let i = 0; i < currentLayer.length; i += 2) {
			const left = currentLayer[i] as string;
			if (i + 1 < currentLayer.length) {
				const right = currentLayer[i + 1] as string;
				nextLayer.push(hashInternal(left, right));
			} else {
				nextLayer.push(left);
			}
		}
		currentLayer = nextLayer;
		layers.push(currentLayer);
	}

	return { root: currentLayer[0], layers };
}

// ── Inclusion proofs ──

/**
 * Generate an inclusion proof for a specific leaf in a Merkle tree.
 *
 * Builds the tree from the provided leaves, then walks from the target leaf
 * up to the root, collecting sibling hashes at each level.
 */
export function generateInclusionProof(
	leafIndex: number,
	leaves: string[],
	segmentId: string,
): MerkleInclusionProof {
	if (leafIndex < 0 || leafIndex >= leaves.length) {
		throw new RangeError(`leafIndex ${leafIndex} out of bounds for ${leaves.length} leaves`);
	}

	const { root, layers } = buildMerkleTree(leaves);

	if (root === undefined) {
		throw new Error("Cannot generate proof for empty tree");
	}

	const siblings: MerkleSibling[] = [];
	let currentIndex = leafIndex;

	for (let level = 0; level < layers.length - 1; level++) {
		const layer = layers[level] as string[];
		const layerSize = layer.length;

		if (currentIndex === layerSize - 1 && layerSize % 2 === 1) {
			currentIndex = Math.floor(currentIndex / 2);
			continue;
		}

		if (currentIndex % 2 === 0) {
			siblings.push({
				hash: layer[currentIndex + 1] as string,
				position: "right",
			});
		} else {
			siblings.push({
				hash: layer[currentIndex - 1] as string,
				position: "left",
			});
		}

		currentIndex = Math.floor(currentIndex / 2);
	}

	const leafHash = leaves[leafIndex] as string;

	return {
		version: 1,
		leafHash,
		leafIndex,
		treeSize: leaves.length,
		root,
		segmentId,
		siblings,
	};
}

/**
 * Verify an inclusion proof against a published root and tree size.
 *
 * Pure function — no I/O, only crypto.createHash.
 */
export function verifyInclusionProof(
	proof: MerkleInclusionProof,
	publishedRoot: string,
	publishedTreeSize: number,
): boolean {
	if (proof.treeSize !== publishedTreeSize) {
		return false;
	}

	if (proof.root !== publishedRoot) {
		return false;
	}

	let currentHash = hashLeaf(proof.leafHash);

	for (const sibling of proof.siblings) {
		if (sibling.position === "left") {
			currentHash = hashInternal(sibling.hash, currentHash);
		} else {
			currentHash = hashInternal(currentHash, sibling.hash);
		}
	}

	return currentHash === proof.root;
}

// ── Consistency proofs ──

/**
 * Find the largest power of 2 strictly less than n.
 */
function largestPowerOf2LessThan(n: number): number {
	if (n <= 1) return 0;
	let k = 1;
	while (k * 2 < n) {
		k *= 2;
	}
	return k;
}

/**
 * Check if n is a power of 2.
 */
function isPowerOf2(n: number): boolean {
	return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Recursive consistency proof generation.
 */
function subproof(
	m: number,
	n: number,
	leaves: string[],
	proof: string[],
	startFromOld: boolean,
): void {
	if (m === n) {
		if (!startFromOld) {
			const { root } = buildMerkleTree(leaves.slice(0, n));
			if (root !== undefined) {
				proof.push(root);
			}
		}
		return;
	}

	const k = largestPowerOf2LessThan(n);

	if (m <= k) {
		subproof(m, k, leaves, proof, startFromOld);
		const { root } = buildMerkleTree(leaves.slice(k, n));
		if (root !== undefined) {
			proof.push(root);
		}
	} else {
		subproof(m - k, n - k, leaves.slice(k), proof, false);
		const { root } = buildMerkleTree(leaves.slice(0, k));
		if (root !== undefined) {
			proof.push(root);
		}
	}
}

/**
 * Generate a consistency proof between two tree sizes.
 *
 * Proves that tree(firstSize) is a prefix of tree(secondSize) — i.e.,
 * the tree is append-only.
 */
export function generateConsistencyProof(
	firstSize: number,
	secondSize: number,
	leaves: string[],
): MerkleConsistencyProof {
	if (firstSize < 1 || firstSize > secondSize) {
		throw new RangeError(`Invalid sizes: firstSize=${firstSize}, secondSize=${secondSize}`);
	}
	if (secondSize > leaves.length) {
		throw new RangeError(`secondSize ${secondSize} exceeds available leaves ${leaves.length}`);
	}

	const firstTree = buildMerkleTree(leaves.slice(0, firstSize));
	const secondTree = buildMerkleTree(leaves.slice(0, secondSize));

	if (firstSize === secondSize) {
		return {
			firstSize,
			secondSize,
			firstRoot: firstTree.root as string,
			secondRoot: secondTree.root as string,
			proof: [],
		};
	}

	const proof: string[] = [];
	const secondLeaves = leaves.slice(0, secondSize);
	subproof(firstSize, secondSize, secondLeaves, proof, true);

	return {
		firstSize,
		secondSize,
		firstRoot: firstTree.root as string,
		secondRoot: secondTree.root as string,
		proof,
	};
}

/**
 * Recompute both roots from the consistency proof path.
 */
function recomputeRoots(
	firstSize: number,
	secondSize: number,
	proofNodes: readonly string[],
	claimedFirstRoot: string,
): { firstRoot: string; secondRoot: string } {
	let idx = 0;

	function consume(): string | undefined {
		if (idx >= proofNodes.length) return undefined;
		return proofNodes[idx++];
	}

	type StackEntry = { hash: string; side: "left" | "right" | "both" };
	const stack: StackEntry[] = [];

	function collect(m: number, n: number, isOld: boolean): void {
		if (m === n) {
			if (!isOld) {
				const node = consume();
				if (node !== undefined) {
					stack.push({ hash: node, side: "both" });
				}
			}
			return;
		}

		const k = largestPowerOf2LessThan(n);

		if (m <= k) {
			collect(m, k, isOld);
			const node = consume();
			if (node !== undefined) {
				stack.push({ hash: node, side: "right" });
			}
		} else {
			collect(m - k, n - k, false);
			const node = consume();
			if (node !== undefined) {
				stack.push({ hash: node, side: "left" });
			}
		}
	}

	collect(firstSize, secondSize, true);

	if (stack.length === 0) return { firstRoot: "", secondRoot: "" };

	let fr: string;
	let sr: string;
	let startIdx: number;

	if (isPowerOf2(firstSize)) {
		fr = claimedFirstRoot;
		sr = claimedFirstRoot;
		startIdx = 0;
	} else {
		fr = (stack[0] as StackEntry).hash;
		sr = (stack[0] as StackEntry).hash;
		startIdx = 1;
	}

	for (let i = startIdx; i < stack.length; i++) {
		const entry = stack[i] as StackEntry;
		if (entry.side === "right") {
			sr = hashInternal(sr, entry.hash);
		} else {
			fr = hashInternal(entry.hash, fr);
			sr = hashInternal(entry.hash, sr);
		}
	}

	return { firstRoot: fr, secondRoot: sr };
}

/**
 * Verify a consistency proof.
 *
 * Recomputes the second root from the first root and proof nodes,
 * verifying that tree(firstSize) is a prefix of tree(secondSize).
 */
export function verifyConsistencyProof(proof: MerkleConsistencyProof): boolean {
	if (proof.firstSize < 1 || proof.firstSize > proof.secondSize) {
		return false;
	}

	if (proof.firstSize === proof.secondSize) {
		return proof.proof.length === 0 && proof.firstRoot === proof.secondRoot;
	}

	if (proof.proof.length === 0) {
		return false;
	}

	const { firstRoot, secondRoot } = recomputeRoots(
		proof.firstSize,
		proof.secondSize,
		proof.proof,
		proof.firstRoot,
	);

	return firstRoot === proof.firstRoot && secondRoot === proof.secondRoot;
}
