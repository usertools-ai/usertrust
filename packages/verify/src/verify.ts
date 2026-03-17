/**
 * Audit Chain Verifier + Merkle Proofs — Zero-dependency standalone
 *
 * INTENTIONAL DUPLICATION: This is a zero-dep copy for the @usertools/verify
 * package. Do NOT import from @usertools/govern. Only uses Node built-ins.
 *
 * Provides:
 * - verifyChain() — linear hash chain verification
 * - Merkle tree building, inclusion proofs, consistency proofs
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import { GENESIS_HASH } from "./constants.js";

// ── Chain Verification ──

export interface ChainVerificationResult {
	valid: boolean;
	eventsVerified: number;
	errors: string[];
	latestHash: string;
	verifiedAt: string;
}

interface AuditEvent {
	id: string;
	hash: string;
	previousHash: string;
	[key: string]: unknown;
}

export function verifyChain(logPath: string): ChainVerificationResult {
	const errors: string[] = [];

	if (!existsSync(logPath)) {
		return {
			valid: true,
			eventsVerified: 0,
			errors: [],
			latestHash: GENESIS_HASH,
			verifiedAt: new Date().toISOString(),
		};
	}

	const content = readFileSync(logPath, "utf-8").trim();
	if (!content) {
		return {
			valid: true,
			eventsVerified: 0,
			errors: [],
			latestHash: GENESIS_HASH,
			verifiedAt: new Date().toISOString(),
		};
	}

	const lines = content.split("\n").filter((l) => l.trim());
	let expectedPreviousHash = GENESIS_HASH;
	let latestHash = GENESIS_HASH;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;

		let event: AuditEvent;
		try {
			event = JSON.parse(line) as AuditEvent;
		} catch (parseErr) {
			errors.push(
				`Event ${i + 1}: malformed JSON — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
			);
			expectedPreviousHash = "";
			continue;
		}

		if (event.previousHash !== expectedPreviousHash) {
			errors.push(
				`Event ${i + 1} (${event.id}): previousHash mismatch. ` +
					`Expected ${expectedPreviousHash}, got ${event.previousHash}`,
			);
		}

		const { hash: storedHash, ...eventWithoutHash } = event;
		const canonical = canonicalize(eventWithoutHash);
		const computedHash = createHash("sha256").update(canonical).digest("hex");

		if (storedHash !== computedHash) {
			errors.push(
				`Event ${i + 1} (${event.id}): hash mismatch. ` +
					`Expected ${computedHash}, got ${storedHash}`,
			);
		}

		expectedPreviousHash = storedHash;
		latestHash = storedHash;
	}

	return {
		valid: errors.length === 0,
		eventsVerified: lines.length,
		errors,
		latestHash,
		verifiedAt: new Date().toISOString(),
	};
}

// ── Merkle Tree ──

const LEAF_PREFIX = Buffer.from([0x00]);
const INTERNAL_PREFIX = Buffer.from([0x01]);

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

export function hashLeaf(data: string): string {
	const dataBuffer = Buffer.from(data, "hex");
	return createHash("sha256").update(LEAF_PREFIX).update(dataBuffer).digest("hex");
}

export function hashInternal(left: string, right: string): string {
	const leftBuffer = Buffer.from(left, "hex");
	const rightBuffer = Buffer.from(right, "hex");
	return createHash("sha256")
		.update(INTERNAL_PREFIX)
		.update(leftBuffer)
		.update(rightBuffer)
		.digest("hex");
}

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

function largestPowerOf2LessThan(n: number): number {
	if (n <= 1) return 0;
	let k = 1;
	while (k * 2 < n) {
		k *= 2;
	}
	return k;
}

function isPowerOf2(n: number): boolean {
	return n > 0 && (n & (n - 1)) === 0;
}

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
