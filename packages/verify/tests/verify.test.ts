import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMerkleTree,
	canonicalize,
	GENESIS_HASH,
	generateConsistencyProof,
	generateInclusionProof,
	hashInternal,
	hashLeaf,
	type MerkleInclusionProof,
	type MerkleSibling,
	verifyChain,
	verifyConsistencyProof,
	verifyInclusionProof,
	verifyVault,
} from "../src/index.js";

// ── Helpers ──

function makeTempVault(): string {
	const dir = join(tmpdir(), `verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "audit"), { recursive: true });
	return dir;
}

interface EventData {
	kind: string;
	actor: string;
	data: Record<string, unknown>;
}

function buildChain(events: EventData[]): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];

	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (!ev) continue;
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			timestamp: new Date(Date.now() + i * 1000).toISOString(),
			previousHash,
			kind: ev.kind,
			actor: ev.actor,
			data: ev.data,
			sequence: i + 1,
		};

		const canonical = canonicalize(event);
		const hash = createHash("sha256").update(canonical).digest("hex");
		const fullEvent = { ...event, hash };

		previousHash = hash;
		lines.push(JSON.stringify(fullEvent));
	}

	return lines;
}

function writeChainToVault(vaultPath: string, lines: string[]): void {
	const logPath = join(vaultPath, "audit", "events.jsonl");
	writeFileSync(logPath, `${lines.join("\n")}\n`);
}

/** Generate N distinct hex hashes for Merkle tree tests */
function makeLeaves(n: number): string[] {
	const leaves: string[] = [];
	for (let i = 0; i < n; i++) {
		leaves.push(createHash("sha256").update(`leaf-${i}`).digest("hex"));
	}
	return leaves;
}

/** Safe array access — throws if index is out of bounds (avoids ! assertions) */
function at<T>(arr: readonly T[], index: number): T {
	const val = arr[index];
	if (val === undefined) throw new Error(`Index ${index} out of bounds (length ${arr.length})`);
	return val;
}

/** Safe root access — throws if tree root is undefined */
function rootOf(tree: { root: string | undefined }): string {
	if (tree.root === undefined) throw new Error("Tree root is undefined");
	return tree.root;
}

// ── Tests ──

// ═══════════════════════════════════════════════════════════════
// verifyChain
// ═══════════════════════════════════════════════════════════════

describe("verifyChain", () => {
	let vaultPath: string;

	beforeEach(() => {
		vaultPath = makeTempVault();
	});

	afterEach(() => {
		if (existsSync(vaultPath)) {
			rmSync(vaultPath, { recursive: true, force: true });
		}
	});

	it("returns valid for an empty chain (no file)", () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
		expect(result.latestHash).toBe(GENESIS_HASH);
	});

	it("returns valid for a file that exists but is empty", () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, "");
		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
		expect(result.latestHash).toBe(GENESIS_HASH);
	});

	it("returns valid for a file with only whitespace", () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, "   \n  \n  ");
		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
		expect(result.latestHash).toBe(GENESIS_HASH);
	});

	it("returns valid for a correctly chained log", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { model: "gpt-4o" } },
			{ kind: "llm_call", actor: "local", data: { model: "gemini-2.0-flash" } },
		]);
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(3);
		expect(result.errors).toEqual([]);
	});

	it("detects tampered event hash", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { cost: 100 } },
		]);
		const secondLine = at(lines, 1);
		const tampered = JSON.parse(secondLine) as Record<string, unknown>;
		tampered.data = { cost: 999 };
		lines[1] = JSON.stringify(tampered);

		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("hash mismatch");
	});

	it("detects broken previousHash linkage", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { model: "gpt-4o" } },
		]);
		const secondLine = at(lines, 1);
		const parsed = JSON.parse(secondLine) as Record<string, unknown>;
		parsed.previousHash = "deadbeef".repeat(8);
		const { hash: _, ...withoutHash } = parsed;
		const canonical = canonicalize(withoutHash);
		parsed.hash = createHash("sha256").update(canonical).digest("hex");
		lines[1] = JSON.stringify(parsed);

		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("previousHash mismatch"))).toBe(true);
	});

	it("reports malformed JSON lines as errors", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
		]);
		lines.push("NOT VALID JSON {{{");

		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("malformed JSON"))).toBe(true);
		expect(result.eventsVerified).toBe(2);
	});

	it("continues verification after malformed JSON line", () => {
		const valid = buildChain([{ kind: "llm_call", actor: "local", data: { a: 1 } }]);
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `{broken json\n${valid[0]}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(1);
		expect(result.errors[0]).toContain("malformed JSON");
	});
});

// ═══════════════════════════════════════════════════════════════
// canonicalize
// ═══════════════════════════════════════════════════════════════

describe("canonicalize", () => {
	it("sorts object keys alphabetically", () => {
		expect(canonicalize({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
	});

	it("handles nested objects", () => {
		expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
	});

	it("preserves null", () => {
		expect(canonicalize(null)).toBe("null");
	});

	// INVERTED (was: `expect(canonicalize(undefined)).toBe(undefined)`). That green
	// assertion PINNED the defect: canonicalize is typed `=> string` and returned a
	// non-string, which is exactly how `{"f":undefined}` reached the audit log.
	// `undefined` has no JSON representation, so it throws — same rule as NaN.
	// Mirrors core/tests/audit/canonical.test.ts.
	it("serializes a top-level undefined to null (ut1 §13 clause 1)", () => {
		expect(canonicalize(undefined)).toBe("null");
	});

	it("writes an in-array undefined as null", () => {
		const result = canonicalize([null, undefined, 1]);
		expect(result).toBe("[null,null,1]");
		expect(() => JSON.parse(result)).not.toThrow();
	});

	it("writes an array HOLE as null — Array.map skips holes, an index loop does not", () => {
		const holey: number[] = [];
		holey[0] = 1;
		holey[2] = 2;
		expect(1 in holey).toBe(false);
		expect(canonicalize({ arr: holey })).toBe('{"arr":[1,null,2]}');
	});

	it("throws on a function value — never omits it", () => {
		expect(() => canonicalize({ f: () => 1 })).toThrow(/not representable in audit data/);
		expect(() => canonicalize(() => 1)).toThrow(/not representable in audit data/);
		expect(() => canonicalize([() => 1])).toThrow(/not representable in audit data/);
	});

	it("throws on a symbol value — never omits it", () => {
		expect(() => canonicalize({ s: Symbol("x") })).toThrow(/not representable in audit data/);
		expect(() => canonicalize(Symbol("x"))).toThrow(/not representable in audit data/);
		expect(() => canonicalize([Symbol("x")])).toThrow(/not representable in audit data/);
	});

	it("strips undefined values from objects", () => {
		const result = canonicalize({ a: 1, b: undefined, c: 3 });
		expect(result).toBe('{"a":1,"c":3}');
	});

	it("handles arrays — preserves order", () => {
		expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
	});

	it("handles empty array", () => {
		expect(canonicalize([])).toBe("[]");
	});

	it("handles arrays with mixed types", () => {
		expect(canonicalize([1, "two", null, { a: 1 }])).toBe('[1,"two",null,{"a":1}]');
	});

	it("handles nested arrays", () => {
		expect(canonicalize([[1, 2], [3]])).toBe("[[1,2],[3]]");
	});

	it("handles string primitives", () => {
		expect(canonicalize("hello")).toBe('"hello"');
	});

	it("handles number primitives", () => {
		expect(canonicalize(42)).toBe("42");
	});

	it("handles boolean primitives", () => {
		expect(canonicalize(true)).toBe("true");
		expect(canonicalize(false)).toBe("false");
	});

	it("handles empty object", () => {
		expect(canonicalize({})).toBe("{}");
	});

	it("handles deeply nested structures", () => {
		const val = { a: [{ b: { c: [1, { d: 2 }] } }] };
		const result = canonicalize(val);
		expect(result).toBe('{"a":[{"b":{"c":[1,{"d":2}]}}]}');
	});
});

// ═══════════════════════════════════════════════════════════════
// hashLeaf / hashInternal
// ═══════════════════════════════════════════════════════════════

describe("hashLeaf", () => {
	it("returns a deterministic 64-char hex string", () => {
		const hash = hashLeaf("abcd".repeat(16));
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("returns the same hash for the same input", () => {
		const input = createHash("sha256").update("test").digest("hex");
		expect(hashLeaf(input)).toBe(hashLeaf(input));
	});

	it("returns different hashes for different inputs", () => {
		const a = createHash("sha256").update("a").digest("hex");
		const b = createHash("sha256").update("b").digest("hex");
		expect(hashLeaf(a)).not.toBe(hashLeaf(b));
	});

	it("uses 0x00 prefix (domain separation from internal)", () => {
		const data = createHash("sha256").update("x").digest("hex");
		const expected = createHash("sha256")
			.update(Buffer.from([0x00]))
			.update(Buffer.from(data, "hex"))
			.digest("hex");
		expect(hashLeaf(data)).toBe(expected);
	});
});

describe("hashInternal", () => {
	it("returns a deterministic 64-char hex string", () => {
		const left = createHash("sha256").update("left").digest("hex");
		const right = createHash("sha256").update("right").digest("hex");
		const hash = hashInternal(left, right);
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic", () => {
		const left = createHash("sha256").update("l").digest("hex");
		const right = createHash("sha256").update("r").digest("hex");
		expect(hashInternal(left, right)).toBe(hashInternal(left, right));
	});

	it("is NOT commutative — order matters", () => {
		const a = createHash("sha256").update("a").digest("hex");
		const b = createHash("sha256").update("b").digest("hex");
		expect(hashInternal(a, b)).not.toBe(hashInternal(b, a));
	});

	it("uses 0x01 prefix (domain separation from leaf)", () => {
		const left = createHash("sha256").update("left").digest("hex");
		const right = createHash("sha256").update("right").digest("hex");
		const expected = createHash("sha256")
			.update(Buffer.from([0x01]))
			.update(Buffer.from(left, "hex"))
			.update(Buffer.from(right, "hex"))
			.digest("hex");
		expect(hashInternal(left, right)).toBe(expected);
	});

	it("leaf and internal hashes differ for same data", () => {
		const data = createHash("sha256").update("same").digest("hex");
		expect(hashLeaf(data)).not.toBe(hashInternal(data, data));
	});
});

// ═══════════════════════════════════════════════════════════════
// buildMerkleTree
// ═══════════════════════════════════════════════════════════════

describe("buildMerkleTree", () => {
	it("returns undefined root for empty input", () => {
		const { root, layers } = buildMerkleTree([]);
		expect(root).toBeUndefined();
		expect(layers).toEqual([[]]);
	});

	it("returns hashLeaf as root for single leaf", () => {
		const leaves = makeLeaves(1);
		const { root, layers } = buildMerkleTree(leaves);
		expect(root).toBe(hashLeaf(at(leaves, 0)));
		expect(layers).toHaveLength(1);
		expect(layers[0]).toHaveLength(1);
	});

	it("builds correct tree for 2 leaves (even)", () => {
		const leaves = makeLeaves(2);
		const { root, layers } = buildMerkleTree(leaves);
		const expectedRoot = hashInternal(hashLeaf(at(leaves, 0)), hashLeaf(at(leaves, 1)));
		expect(root).toBe(expectedRoot);
		expect(layers).toHaveLength(2);
		expect(layers[0]).toHaveLength(2);
		expect(layers[1]).toHaveLength(1);
	});

	it("builds correct tree for 3 leaves (odd — promotes unpaired)", () => {
		const leaves = makeLeaves(3);
		const { root, layers } = buildMerkleTree(leaves);
		const h0 = hashLeaf(at(leaves, 0));
		const h1 = hashLeaf(at(leaves, 1));
		const h2 = hashLeaf(at(leaves, 2));
		const int01 = hashInternal(h0, h1);
		const expectedRoot = hashInternal(int01, h2);
		expect(root).toBe(expectedRoot);
		expect(layers).toHaveLength(3);
	});

	it("builds correct tree for 4 leaves (power of 2)", () => {
		const leaves = makeLeaves(4);
		const { root, layers } = buildMerkleTree(leaves);
		const h0 = hashLeaf(at(leaves, 0));
		const h1 = hashLeaf(at(leaves, 1));
		const h2 = hashLeaf(at(leaves, 2));
		const h3 = hashLeaf(at(leaves, 3));
		const expectedRoot = hashInternal(hashInternal(h0, h1), hashInternal(h2, h3));
		expect(root).toBe(expectedRoot);
		expect(layers).toHaveLength(3);
	});

	it("builds correct tree for 5 leaves (odd count, two levels of promotion)", () => {
		const leaves = makeLeaves(5);
		const { root, layers } = buildMerkleTree(leaves);
		expect(root).toBeDefined();
		expect(layers.length).toBeGreaterThan(1);
		expect(layers[0]).toHaveLength(5);
		expect(layers[1]).toHaveLength(3);
		expect(layers[2]).toHaveLength(2);
		expect(layers[3]).toHaveLength(1);
	});

	it("builds tree for large input (16 leaves)", () => {
		const leaves = makeLeaves(16);
		const { root, layers } = buildMerkleTree(leaves);
		expect(root).toBeDefined();
		expect(layers).toHaveLength(5);
	});

	it("different leaves produce different roots", () => {
		const a = makeLeaves(3);
		const b = makeLeaves(3).map((_, i) =>
			createHash("sha256").update(`different-${i}`).digest("hex"),
		);
		expect(buildMerkleTree(a).root).not.toBe(buildMerkleTree(b).root);
	});
});

// ═══════════════════════════════════════════════════════════════
// generateInclusionProof / verifyInclusionProof
// ═══════════════════════════════════════════════════════════════

describe("generateInclusionProof", () => {
	it("throws RangeError for negative index", () => {
		const leaves = makeLeaves(3);
		expect(() => generateInclusionProof(-1, leaves, "seg-1")).toThrow(RangeError);
	});

	it("throws RangeError for index >= leaves.length", () => {
		const leaves = makeLeaves(3);
		expect(() => generateInclusionProof(3, leaves, "seg-1")).toThrow(RangeError);
		expect(() => generateInclusionProof(100, leaves, "seg-1")).toThrow(RangeError);
	});

	it("throws RangeError for index 0 on empty leaves", () => {
		expect(() => generateInclusionProof(0, [], "seg-1")).toThrow(RangeError);
	});

	it("generates valid proof for single-leaf tree", () => {
		const leaves = makeLeaves(1);
		const proof = generateInclusionProof(0, leaves, "seg-1");
		expect(proof.version).toBe(1);
		expect(proof.leafHash).toBe(at(leaves, 0));
		expect(proof.leafIndex).toBe(0);
		expect(proof.treeSize).toBe(1);
		expect(proof.segmentId).toBe("seg-1");
		expect(proof.siblings).toHaveLength(0);
		expect(proof.root).toBeDefined();
	});

	it("generates valid proof for 2-leaf tree — both positions", () => {
		const leaves = makeLeaves(2);
		const tree = buildMerkleTree(leaves);

		const proof0 = generateInclusionProof(0, leaves, "seg-a");
		expect(proof0.leafIndex).toBe(0);
		expect(proof0.root).toBe(tree.root);
		expect(proof0.siblings).toHaveLength(1);
		expect(at(proof0.siblings, 0).position).toBe("right");

		const proof1 = generateInclusionProof(1, leaves, "seg-a");
		expect(proof1.leafIndex).toBe(1);
		expect(proof1.root).toBe(tree.root);
		expect(proof1.siblings).toHaveLength(1);
		expect(at(proof1.siblings, 0).position).toBe("left");
	});

	it("generates valid proof for 3-leaf tree — all positions", () => {
		const leaves = makeLeaves(3);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 3; i++) {
			const proof = generateInclusionProof(i, leaves, `seg-${i}`);
			expect(proof.root).toBe(tree.root);
			expect(proof.leafHash).toBe(at(leaves, i));
		}
	});

	it("generates valid proof for 4-leaf tree — all positions", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 4; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-4");
			expect(proof.root).toBe(tree.root);
			expect(proof.treeSize).toBe(4);
		}
	});

	it("generates valid proof for 5-leaf tree (odd) — all positions", () => {
		const leaves = makeLeaves(5);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 5; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-5");
			expect(proof.root).toBe(tree.root);
		}
	});

	it("generates valid proof for 7-leaf tree (odd, multiple promotions)", () => {
		const leaves = makeLeaves(7);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 7; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-7");
			expect(proof.root).toBe(tree.root);
		}
	});

	it("generates valid proof for 8-leaf tree (power of 2)", () => {
		const leaves = makeLeaves(8);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 8; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-8");
			expect(proof.root).toBe(tree.root);
		}
	});
});

describe("verifyInclusionProof", () => {
	it("returns true for valid proof — 2 leaves", () => {
		const leaves = makeLeaves(2);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(0, leaves, "seg-v");

		expect(verifyInclusionProof(proof, rootOf(tree), leaves.length)).toBe(true);
	});

	it("returns true for valid proof — every position in 4-leaf tree", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 4; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-v4");
			expect(verifyInclusionProof(proof, rootOf(tree), 4)).toBe(true);
		}
	});

	it("returns true for valid proof — every position in 5-leaf tree (odd)", () => {
		const leaves = makeLeaves(5);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 5; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-v5");
			expect(verifyInclusionProof(proof, rootOf(tree), 5)).toBe(true);
		}
	});

	it("returns true for valid proof — single-leaf tree", () => {
		const leaves = makeLeaves(1);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(0, leaves, "seg-v1");
		expect(verifyInclusionProof(proof, rootOf(tree), 1)).toBe(true);
	});

	it("returns false for wrong published root", () => {
		const leaves = makeLeaves(4);
		const proof = generateInclusionProof(0, leaves, "seg-bad");
		expect(verifyInclusionProof(proof, "deadbeef".repeat(8), 4)).toBe(false);
	});

	it("returns false for wrong published tree size", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(0, leaves, "seg-bad");
		expect(verifyInclusionProof(proof, rootOf(tree), 999)).toBe(false);
	});

	it("returns false for tampered sibling hash", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(0, leaves, "seg-tamper");

		const tampered = {
			...proof,
			siblings: proof.siblings.map((s, idx) => (idx === 0 ? { ...s, hash: "ff".repeat(32) } : s)),
		};
		expect(verifyInclusionProof(tampered, rootOf(tree), 4)).toBe(false);
	});

	it("returns false when leafHash is tampered", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(0, leaves, "seg-tamper2");

		const tampered = {
			...proof,
			leafHash: "aa".repeat(32),
		};
		expect(verifyInclusionProof(tampered, rootOf(tree), 4)).toBe(false);
	});

	it("verifies all positions in a 16-leaf tree", () => {
		const leaves = makeLeaves(16);
		const tree = buildMerkleTree(leaves);

		for (let i = 0; i < 16; i++) {
			const proof = generateInclusionProof(i, leaves, "seg-16");
			expect(verifyInclusionProof(proof, rootOf(tree), 16)).toBe(true);
		}
	});
});

// ═══════════════════════════════════════════════════════════════
// Path topology. Mirrors packages/core/tests/audit/merkle.test.ts —
// the fold alone proves a path exists, never that the leaf sits
// where the proof claims it does.
// ═══════════════════════════════════════════════════════════════

describe("verifyInclusionProof — path topology", () => {
	/** Cast an intentionally malformed proof to the declared shape. */
	function malformed(value: unknown): MerkleInclusionProof {
		return value as MerkleInclusionProof;
	}

	it("rejects a forged leafIndex riding an otherwise-valid fold", () => {
		const leaves = makeLeaves(8);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(3, leaves, "seg-forged");

		expect(verifyInclusionProof({ ...proof, leafIndex: 5 }, rootOf(tree), 8)).toBe(false);
	});

	it("rejects padded, truncated and flipped sibling paths", () => {
		const leaves = makeLeaves(8);
		const tree = buildMerkleTree(leaves);
		const root = rootOf(tree);
		const proof = generateInclusionProof(3, leaves, "seg-path");

		const padded = { ...proof, siblings: [...proof.siblings, at(proof.siblings, 0)] };
		expect(verifyInclusionProof(padded, root, 8)).toBe(false);

		const truncated = { ...proof, siblings: proof.siblings.slice(0, 2) };
		expect(verifyInclusionProof(truncated, root, 8)).toBe(false);

		const flipped = {
			...proof,
			siblings: proof.siblings.map((s, i) =>
				i === 1 ? { ...s, position: s.position === "left" ? "right" : "left" } : s,
			),
		};
		expect(verifyInclusionProof(malformed(flipped), root, 8)).toBe(false);
	});

	it("rejects a non-'left'/'right' position rather than treating it as right", () => {
		const leaves = makeLeaves(8);
		const tree = buildMerkleTree(leaves);
		const proof = generateInclusionProof(1, leaves, "seg-bogus");
		const bogus = malformed({
			...proof,
			siblings: proof.siblings.map((s, i) => (i === 1 ? { ...s, position: "bogus" } : s)),
		});

		expect(verifyInclusionProof(bogus, rootOf(tree), 8)).toBe(false);
	});

	it("rejects the equal-hash flip: identical leaves refold to the same root", () => {
		const twin = createHash("sha256").update("twin").digest("hex");
		const pair = [twin, twin];
		const root = rootOf(buildMerkleTree(pair));
		const proof = generateInclusionProof(0, pair, "seg-twin");
		expect(at(proof.siblings, 0).position).toBe("right");

		const flipped: MerkleSibling[] = [{ hash: at(proof.siblings, 0).hash, position: "left" }];
		expect(verifyInclusionProof({ ...proof, siblings: flipped }, root, 2)).toBe(false);
		expect(verifyInclusionProof({ ...proof, leafIndex: 1 }, root, 2)).toBe(false);
	});

	it("rejects out-of-range leafIndex and non-safe-integer sizes", () => {
		const leaves = makeLeaves(8);
		const tree = buildMerkleTree(leaves);
		const root = rootOf(tree);
		const proof = generateInclusionProof(3, leaves, "seg-bounds");

		for (const leafIndex of [-1, 8, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(verifyInclusionProof({ ...proof, leafIndex }, root, 8)).toBe(false);
		}
		// Number.isInteger(2**53) is true — Number.isSafeInteger is what refuses it.
		for (const treeSize of [0, -1, 8.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
			expect(verifyInclusionProof({ ...proof, treeSize }, root, treeSize)).toBe(false);
		}
	});

	it("returns false — never throws — for structurally malformed proofs", () => {
		const leaves = makeLeaves(8);
		const root = rootOf(buildMerkleTree(leaves));
		const proof = generateInclusionProof(3, leaves, "seg-malformed");

		const cases: MerkleInclusionProof[] = [
			malformed({ ...proof, siblings: null }),
			malformed({ ...proof, siblings: "not-an-array" }),
			malformed({ ...proof, siblings: [proof.siblings[0], undefined, proof.siblings[2]] }),
			malformed({ ...proof, siblings: [proof.siblings[0], null, proof.siblings[2]] }),
			malformed({ ...proof, siblings: proof.siblings.map(({ hash }) => ({ hash })) }),
			malformed({ ...proof, leafHash: undefined }),
		];

		for (const bad of cases) {
			expect(() => verifyInclusionProof(bad, root, 8)).not.toThrow();
			expect(verifyInclusionProof(bad, root, 8)).toBe(false);
		}
	});

	// Hostile in-memory objects. These defend the EXPORTED function's
	// "untrusted input" contract, not any vault ingestion path — a JSON-parsed
	// proof carries plain data properties. A valid leaf-0 proof in a 4-leaf
	// tree has orientations [right, right]; leafIndex 2 derives [right, left],
	// so each fixture shows one face to validation and the other to a fold
	// that re-reads.

	it("rejects a `position` getter that flips between validation and the fold", () => {
		const leaves = makeLeaves(4);
		const root = rootOf(buildMerkleTree(leaves));
		const proof = generateInclusionProof(0, leaves, "seg-hostile");
		let reads = 0;
		const hostile = {
			hash: at(proof.siblings, 1).hash,
			get position(): string {
				reads += 1;
				return reads === 1 ? "left" : "right";
			},
		};
		const forged = malformed({
			...proof,
			leafIndex: 2,
			siblings: [at(proof.siblings, 0), hostile],
		});

		expect(verifyInclusionProof(forged, root, 4)).toBe(false);
		// One read per property, total — the fold must never come back for more.
		expect(reads).toBe(1);
	});

	it("rejects an array whose Symbol.iterator yields a different path", () => {
		const leaves = makeLeaves(4);
		const root = rootOf(buildMerkleTree(leaves));
		const proof = generateInclusionProof(0, leaves, "seg-hostile-iter");
		const real = at(proof.siblings, 1);
		const indexed: unknown[] = [at(proof.siblings, 0), { ...real, position: "left" }];
		Object.defineProperty(indexed, Symbol.iterator, {
			value: function* () {
				yield at(proof.siblings, 0);
				yield real;
			},
		});
		const forged = malformed({ ...proof, leafIndex: 2, siblings: indexed });

		expect(verifyInclusionProof(forged, root, 4)).toBe(false);
	});

	it("returns false for a proof that is not an object at all", () => {
		const root = rootOf(buildMerkleTree(makeLeaves(4)));
		for (const bad of [null, undefined, 42, "proof", true, Symbol("p")]) {
			expect(() => verifyInclusionProof(malformed(bad), root, 4)).not.toThrow();
			expect(verifyInclusionProof(malformed(bad), root, 4)).toBe(false);
		}
	});

	it("returns false when any field accessor throws", () => {
		const leaves = makeLeaves(4);
		const root = rootOf(buildMerkleTree(leaves));
		const proof = generateInclusionProof(0, leaves, "seg-throwing");

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
		const leaves = makeLeaves(4);
		const root = rootOf(buildMerkleTree(leaves));
		const proof = generateInclusionProof(0, leaves, "seg-throwing-sib");

		const throwingIndex: unknown[] = [at(proof.siblings, 0), at(proof.siblings, 1)];
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
			const sibling = { ...at(proof.siblings, 1) };
			Object.defineProperty(sibling, field, {
				get(): never {
					throw new Error(`hostile ${field}`);
				},
			});
			const forged = malformed({ ...proof, siblings: [at(proof.siblings, 0), sibling] });
			expect(() => verifyInclusionProof(forged, root, 4)).not.toThrow();
			expect(verifyInclusionProof(forged, root, 4)).toBe(false);
		}
	});

	it("returns false for a revoked proxy", () => {
		const leaves = makeLeaves(4);
		const root = rootOf(buildMerkleTree(leaves));
		const proof = generateInclusionProof(0, leaves, "seg-revoked");
		const { proxy, revoke } = Proxy.revocable({ ...proof }, {});
		revoke();

		expect(() => verifyInclusionProof(malformed(proxy), root, 4)).not.toThrow();
		expect(verifyInclusionProof(malformed(proxy), root, 4)).toBe(false);
	});

	it("round-trips every leaf of trees sized 1..33, including promotion shapes", () => {
		for (let size = 1; size <= 33; size++) {
			const leaves = makeLeaves(size);
			const root = rootOf(buildMerkleTree(leaves));
			for (let i = 0; i < size; i++) {
				const proof = generateInclusionProof(i, leaves, `seg-${size}`);
				expect(verifyInclusionProof(proof, root, size)).toBe(true);
			}
		}
	});

	it("no valid proof verifies at any other leaf index, for trees sized 2..17", () => {
		for (let size = 2; size <= 17; size++) {
			const leaves = makeLeaves(size);
			const root = rootOf(buildMerkleTree(leaves));
			for (let i = 0; i < size; i++) {
				const proof = generateInclusionProof(i, leaves, `seg-${size}`);
				for (let claimed = 0; claimed < size; claimed++) {
					if (claimed === i) continue;
					expect(verifyInclusionProof({ ...proof, leafIndex: claimed }, root, size)).toBe(false);
				}
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════
// generateConsistencyProof / verifyConsistencyProof
// ═══════════════════════════════════════════════════════════════

describe("generateConsistencyProof", () => {
	it("throws RangeError for firstSize < 1", () => {
		const leaves = makeLeaves(4);
		expect(() => generateConsistencyProof(0, 4, leaves)).toThrow(RangeError);
	});

	it("throws RangeError for firstSize > secondSize", () => {
		const leaves = makeLeaves(4);
		expect(() => generateConsistencyProof(5, 4, leaves)).toThrow(RangeError);
	});

	it("throws RangeError for secondSize > leaves.length", () => {
		const leaves = makeLeaves(4);
		expect(() => generateConsistencyProof(2, 10, leaves)).toThrow(RangeError);
	});

	it("returns empty proof when firstSize === secondSize", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(4, 4, leaves);
		expect(proof.proof).toEqual([]);
		expect(proof.firstSize).toBe(4);
		expect(proof.secondSize).toBe(4);
		expect(proof.firstRoot).toBe(proof.secondRoot);
	});

	it("generates proof for 1->2 (smallest growth)", () => {
		const leaves = makeLeaves(2);
		const proof = generateConsistencyProof(1, 2, leaves);
		expect(proof.firstSize).toBe(1);
		expect(proof.secondSize).toBe(2);
		expect(proof.proof.length).toBeGreaterThan(0);
	});

	it("generates proof for 2->4 (power-of-2 sizes)", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(2, 4, leaves);
		expect(proof.firstSize).toBe(2);
		expect(proof.secondSize).toBe(4);
		expect(proof.firstRoot).toBe(buildMerkleTree(leaves.slice(0, 2)).root);
		expect(proof.secondRoot).toBe(buildMerkleTree(leaves).root);
	});

	it("generates proof for 3->5 (non-power-of-2 sizes)", () => {
		const leaves = makeLeaves(5);
		const proof = generateConsistencyProof(3, 5, leaves);
		expect(proof.firstSize).toBe(3);
		expect(proof.secondSize).toBe(5);
		expect(proof.firstRoot).toBe(buildMerkleTree(leaves.slice(0, 3)).root);
		expect(proof.secondRoot).toBe(buildMerkleTree(leaves.slice(0, 5)).root);
	});

	it("generates proof for 1->1 (same size, single leaf)", () => {
		const leaves = makeLeaves(1);
		const proof = generateConsistencyProof(1, 1, leaves);
		expect(proof.proof).toEqual([]);
		expect(proof.firstRoot).toBe(proof.secondRoot);
	});

	it("generates proof for m > k split (firstSize > largest power of 2)", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(5, 8, leaves);
		expect(proof.firstSize).toBe(5);
		expect(proof.secondSize).toBe(8);
		expect(proof.firstRoot).toBe(buildMerkleTree(leaves.slice(0, 5)).root);
		expect(proof.secondRoot).toBe(buildMerkleTree(leaves.slice(0, 8)).root);
	});

	it("generates proof for 4->8 (power-of-2 both)", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(4, 8, leaves);
		expect(proof.firstRoot).toBe(buildMerkleTree(leaves.slice(0, 4)).root);
		expect(proof.secondRoot).toBe(buildMerkleTree(leaves.slice(0, 8)).root);
	});

	it("generates proof for 2->3 (even to odd)", () => {
		const leaves = makeLeaves(3);
		const proof = generateConsistencyProof(2, 3, leaves);
		expect(proof.firstRoot).toBe(buildMerkleTree(leaves.slice(0, 2)).root);
		expect(proof.secondRoot).toBe(buildMerkleTree(leaves.slice(0, 3)).root);
	});
});

describe("verifyConsistencyProof", () => {
	it("returns false for firstSize < 1", () => {
		expect(
			verifyConsistencyProof({
				firstSize: 0,
				secondSize: 4,
				firstRoot: "a",
				secondRoot: "b",
				proof: [],
			}),
		).toBe(false);
	});

	it("returns false for firstSize > secondSize", () => {
		expect(
			verifyConsistencyProof({
				firstSize: 5,
				secondSize: 4,
				firstRoot: "a",
				secondRoot: "b",
				proof: [],
			}),
		).toBe(false);
	});

	it("returns true when firstSize === secondSize and roots match with empty proof", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);
		expect(
			verifyConsistencyProof({
				firstSize: 4,
				secondSize: 4,
				firstRoot: rootOf(tree),
				secondRoot: rootOf(tree),
				proof: [],
			}),
		).toBe(true);
	});

	it("returns false when firstSize === secondSize but roots differ", () => {
		expect(
			verifyConsistencyProof({
				firstSize: 4,
				secondSize: 4,
				firstRoot: "aa".repeat(32),
				secondRoot: "bb".repeat(32),
				proof: [],
			}),
		).toBe(false);
	});

	it("returns false when firstSize === secondSize but proof is non-empty", () => {
		const leaves = makeLeaves(4);
		const tree = buildMerkleTree(leaves);
		expect(
			verifyConsistencyProof({
				firstSize: 4,
				secondSize: 4,
				firstRoot: rootOf(tree),
				secondRoot: rootOf(tree),
				proof: ["extra"],
			}),
		).toBe(false);
	});

	it("returns false when firstSize !== secondSize but proof is empty", () => {
		expect(
			verifyConsistencyProof({
				firstSize: 2,
				secondSize: 4,
				firstRoot: "aa".repeat(32),
				secondRoot: "bb".repeat(32),
				proof: [],
			}),
		).toBe(false);
	});

	it("verifies valid consistency proof for 1->2", () => {
		const leaves = makeLeaves(2);
		const proof = generateConsistencyProof(1, 2, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 2->4", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(2, 4, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 3->5 (non-power-of-2)", () => {
		const leaves = makeLeaves(5);
		const proof = generateConsistencyProof(3, 5, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 5->8 (m > k branch)", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(5, 8, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 4->8 (both power-of-2)", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(4, 8, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 1->4", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(1, 4, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 2->3 (even to odd)", () => {
		const leaves = makeLeaves(3);
		const proof = generateConsistencyProof(2, 3, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 1->8", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(1, 8, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("rejects consistency proof with tampered firstRoot", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(2, 4, leaves);
		const tampered = { ...proof, firstRoot: "ff".repeat(32) };
		expect(verifyConsistencyProof(tampered)).toBe(false);
	});

	it("rejects consistency proof with tampered secondRoot", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(2, 4, leaves);
		const tampered = { ...proof, secondRoot: "ff".repeat(32) };
		expect(verifyConsistencyProof(tampered)).toBe(false);
	});

	it("rejects consistency proof with tampered proof nodes", () => {
		const leaves = makeLeaves(4);
		const proof = generateConsistencyProof(2, 4, leaves);
		const tampered = {
			...proof,
			proof: proof.proof.map(() => "00".repeat(32)),
		};
		expect(verifyConsistencyProof(tampered)).toBe(false);
	});

	it("verifies valid consistency proof for 3->7 (deeply odd)", () => {
		const leaves = makeLeaves(7);
		const proof = generateConsistencyProof(3, 7, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 6->8 (m > k, non-power-of-2 first)", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(6, 8, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 7->8 (m > k, both near power-of-2)", () => {
		const leaves = makeLeaves(8);
		const proof = generateConsistencyProof(7, 8, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 1->16", () => {
		const leaves = makeLeaves(16);
		const proof = generateConsistencyProof(1, 16, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});

	it("verifies valid consistency proof for 8->16 (power-of-2 to power-of-2)", () => {
		const leaves = makeLeaves(16);
		const proof = generateConsistencyProof(8, 16, leaves);
		expect(verifyConsistencyProof(proof)).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════
// verifyVault
// ═══════════════════════════════════════════════════════════════

describe("verifyVault", () => {
	let vaultPath: string;

	beforeEach(() => {
		vaultPath = makeTempVault();
	});

	afterEach(() => {
		if (existsSync(vaultPath)) {
			rmSync(vaultPath, { recursive: true, force: true });
		}
	});

	it("returns VERIFIED for a valid vault", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { model: "gpt-4o" } },
		]);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(2);
		expect(result.validHashes).toBe(2);
		expect(result.errors).toEqual([]);
	});

	it("reports chain length and Merkle root", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { a: 1 } },
			{ kind: "llm_call", actor: "local", data: { a: 2 } },
			{ kind: "llm_call", actor: "local", data: { a: 3 } },
		]);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.chainLength).toBe(3);
		expect(result.merkleRoot).not.toBeNull();
		expect(typeof result.merkleRoot).toBe("string");
		expect(result.merkleRoot?.length).toBe(64);
	});

	it("reports first and last event timestamps", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: {} },
			{ kind: "llm_call", actor: "local", data: {} },
		]);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.firstEvent).not.toBeNull();
		expect(result.lastEvent).not.toBeNull();
	});

	it("detects tampered chain in vault", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { cost: 50 } },
			{ kind: "llm_call", actor: "local", data: { cost: 100 } },
		]);
		const secondLine = at(lines, 1);
		const tampered = JSON.parse(secondLine) as Record<string, unknown>;
		tampered.data = { cost: 0 };
		lines[1] = JSON.stringify(tampered);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("handles missing audit directory", () => {
		const emptyVault = join(
			tmpdir(),
			`verify-test-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(emptyVault, { recursive: true });

		try {
			const result = verifyVault(emptyVault);
			expect(result.valid).toBe(false);
			expect(result.chainLength).toBe(0);
			expect(result.merkleRoot).toBeNull();
			expect(result.errors.length).toBeGreaterThan(0);
		} finally {
			rmSync(emptyVault, { recursive: true, force: true });
		}
	});

	it("handles empty vault with audit directory but no logs", () => {
		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
		expect(result.merkleRoot).toBeNull();
	});

	it("returns deterministic Merkle root for same data", () => {
		const events: EventData[] = [
			{ kind: "llm_call", actor: "local", data: { x: 1 } },
			{ kind: "llm_call", actor: "local", data: { x: 2 } },
		];
		const lines = buildChain(events);
		writeChainToVault(vaultPath, lines);

		const result1 = verifyVault(vaultPath);

		const vaultPath2 = makeTempVault();
		try {
			writeChainToVault(vaultPath2, lines);
			const result2 = verifyVault(vaultPath2);
			expect(result1.merkleRoot).toBe(result2.merkleRoot);
		} finally {
			rmSync(vaultPath2, { recursive: true, force: true });
		}
	});

	it("picks up rotated segment files as ONE continuous chain (not independent segments)", () => {
		// A legitimately rotated vault is a single continuous chain split across
		// files: the older event lives in a rotated segment, the newer event in
		// the live log, chained from it (sequences 1..2). The anchor records the
		// global tail. (Two independently GENESIS-rooted segments — the old, weak
		// fixture — must NOT verify; that vulnerability is what this replaces.)
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { segment: "rotated" } },
			{ kind: "llm_call", actor: "local", data: { segment: "main" } },
		]);
		const auditDir = join(vaultPath, "audit");
		writeFileSync(join(auditDir, "events-2026-03-15.jsonl"), `${at(lines, 0)}\n`);
		writeFileSync(join(auditDir, "events.jsonl"), `${at(lines, 1)}\n`);
		const last = JSON.parse(at(lines, 1)) as { hash: string };
		writeFileSync(
			join(auditDir, "events.jsonl.meta"),
			JSON.stringify({ lastHash: last.hash, sequence: 2 }),
		);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(2);
	});

	it("handles events without timestamps (no firstEvent/lastEvent set)", () => {
		const event: Record<string, unknown> = {
			id: "evt-no-ts",
			previousHash: GENESIS_HASH,
			kind: "test",
			actor: "local",
			data: {},
		};
		const canonical = canonicalize(event);
		const hash = createHash("sha256").update(canonical).digest("hex");
		const fullEvent = { ...event, hash };

		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${JSON.stringify(fullEvent)}\n`);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.firstEvent).toBeNull();
		expect(result.lastEvent).toBeNull();
	});

	it("handles vault with only rotated segment files (no events.jsonl)", () => {
		const rotatedLines = buildChain([
			{ kind: "llm_call", actor: "local", data: { segment: "only-rotated" } },
		]);
		const rotatedPath = join(vaultPath, "audit", "segment-001.jsonl");
		writeFileSync(rotatedPath, `${rotatedLines.join("\n")}\n`);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(1);
		expect(result.merkleRoot).not.toBeNull();
	});

	it("ignores non-.jsonl files in audit directory", () => {
		const mainLines = buildChain([{ kind: "llm_call", actor: "local", data: {} }]);
		writeChainToVault(vaultPath, mainLines);

		writeFileSync(join(vaultPath, "audit", "notes.txt"), "not a log file");

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(1);
	});

	it("handles events.jsonl that exists but is empty (no content after trim)", () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, "  \n  \n  ");

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
		expect(result.merkleRoot).toBeNull();
	});

	it("handles vault with all-malformed JSON (no hashes collected, no merkle root)", () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, "NOT JSON\nALSO NOT JSON\n");

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.merkleRoot).toBeNull();
	});

	it("skips reading a rotated segment file that was deleted (broken symlink)", () => {
		const mainLines = buildChain([{ kind: "llm_call", actor: "local", data: { stable: true } }]);
		writeChainToVault(vaultPath, mainLines);

		const brokenLink = join(vaultPath, "audit", "deleted-segment.jsonl");
		symlinkSync("/nonexistent/path/file.jsonl", brokenLink);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(1);
	});
});
