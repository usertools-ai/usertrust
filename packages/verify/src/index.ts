// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust-verify — Standalone Audit Verification (zero dependencies)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	type ReceiptData,
	type TransactionEvent,
	renderNotFound,
	renderReceipt,
} from "./receipt.js";
import {
	buildMerkleTree,
	generateInclusionProof,
	verifyChain,
	verifyInclusionProof,
} from "./verify.js";

export { canonicalize } from "./canonical.js";
export { GENESIS_HASH } from "./constants.js";
export {
	type ReceiptData,
	type TransactionEvent,
	renderReceipt,
	renderNotFound,
} from "./receipt.js";
export {
	verifyChain,
	buildMerkleTree,
	hashLeaf,
	hashInternal,
	generateInclusionProof,
	verifyInclusionProof,
	generateConsistencyProof,
	verifyConsistencyProof,
	type ChainVerificationResult,
	type MerkleSibling,
	type MerkleInclusionProof,
	type MerkleConsistencyProof,
} from "./verify.js";

// ── Vault Verification ──

export interface VaultVerificationResult {
	valid: boolean;
	errors: string[];
	chainLength: number;
	validHashes: number;
	merkleRoot: string | null;
	firstEvent: string | null;
	lastEvent: string | null;
}

/**
 * Verify an entire `.usertrust` vault directory.
 *
 * Finds all `events.jsonl` files under `<vaultPath>/audit/`, verifies each
 * chain, computes a Merkle root over all event hashes, and returns a
 * consolidated report.
 */
export function verifyVault(vaultPath: string): VaultVerificationResult {
	const auditDir = join(vaultPath, "audit");
	const errors: string[] = [];
	let totalEvents = 0;
	let totalValid = 0;
	let firstEvent: string | null = null;
	let lastEvent: string | null = null;
	const allHashes: string[] = [];

	// Find all events.jsonl files
	const logPaths: string[] = [];
	const mainLog = join(auditDir, "events.jsonl");

	if (existsSync(mainLog)) {
		logPaths.push(mainLog);
	}

	// Also check for rotated segment files
	if (existsSync(auditDir)) {
		try {
			const entries = readdirSync(auditDir);
			for (const entry of entries) {
				if (entry.endsWith(".jsonl") && entry !== "events.jsonl") {
					logPaths.push(join(auditDir, entry));
				}
			}
		} catch {
			// Directory read failure — non-fatal
		}
	}

	if (logPaths.length === 0) {
		if (!existsSync(auditDir)) {
			errors.push(`Audit directory not found: ${auditDir}`);
		}
		return {
			valid: errors.length === 0,
			errors,
			chainLength: 0,
			validHashes: 0,
			merkleRoot: null,
			firstEvent: null,
			lastEvent: null,
		};
	}

	for (const logPath of logPaths) {
		const result = verifyChain(logPath);
		totalEvents += result.eventsVerified;

		if (result.errors.length > 0) {
			for (const err of result.errors) {
				errors.push(err);
			}
		} else {
			totalValid += result.eventsVerified;
		}

		// Extract event hashes and timestamps for the report
		if (existsSync(logPath)) {
			const content = readFileSync(logPath, "utf-8").trim();
			if (content) {
				const lines = content.split("\n").filter((l) => l.trim());
				for (const line of lines) {
					try {
						const event = JSON.parse(line) as {
							hash: string;
							timestamp?: string;
						};
						allHashes.push(event.hash);

						if (event.timestamp) {
							if (firstEvent === null) {
								firstEvent = event.timestamp;
							}
							lastEvent = event.timestamp;
						}
					} catch {
						// Already reported by verifyChain
					}
				}
			}
		}
	}

	// Compute Merkle root over all event hashes
	let merkleRoot: string | null = null;
	if (allHashes.length > 0) {
		const tree = buildMerkleTree(allHashes);
		merkleRoot = tree.root ?? null;
	}

	return {
		valid: errors.length === 0,
		errors,
		chainLength: totalEvents,
		validHashes: totalValid,
		merkleRoot,
		firstEvent,
		lastEvent,
	};
}

// ── Single Transaction Verification ──

export interface TransactionVerificationResult {
	readonly found: boolean;
	readonly valid: boolean;
	readonly receipt: string;
	readonly errors: string[];
}

/**
 * Verify a single transaction and return a formatted receipt.
 *
 * Finds the event matching `txId` (by `data.transferId`), verifies the
 * hash chain up to that event, generates a Merkle inclusion proof, and
 * returns a terminal-formatted receipt string.
 */
export function verifyTransaction(vaultPath: string, txId: string): TransactionVerificationResult {
	const auditDir = join(vaultPath, "audit");
	const mainLog = join(auditDir, "events.jsonl");

	if (!existsSync(mainLog)) {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: [`Audit log not found: ${mainLog}`],
		};
	}

	const content = readFileSync(mainLog, "utf-8").trim();
	if (!content) {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: ["Audit log is empty"],
		};
	}

	const lines = content.split("\n").filter((l) => l.trim());
	const events: TransactionEvent[] = [];
	const parseErrors: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		try {
			events.push(JSON.parse(lines[i] as string) as TransactionEvent);
		} catch {
			parseErrors.push(`Event ${i + 1}: malformed JSON`);
		}
	}

	// Find the target event
	const targetEvent = events.find((e) => e.data.transferId === txId);

	if (targetEvent === undefined) {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: [],
		};
	}

	// Verify the full chain
	const chainResult = verifyChain(mainLog);
	const chainVerified = chainResult.valid;

	// Build Merkle tree and generate inclusion proof
	const allHashes = events.map((e) => e.hash);
	const tree = buildMerkleTree(allHashes);
	const merkleRoot = tree.root ?? "";
	const leafIndex = events.indexOf(targetEvent);

	let merkleVerified = false;
	if (tree.root !== undefined && leafIndex >= 0) {
		const proof = generateInclusionProof(leafIndex, allHashes, "events.jsonl");
		merkleVerified = verifyInclusionProof(proof, tree.root, allHashes.length);
	}

	// Compute cumulative spend up to and including this event
	let cumulativeSpend = 0;
	for (const evt of events) {
		if (evt.data.cost !== undefined && evt.kind === "llm_call") {
			cumulativeSpend += evt.data.cost;
		}
		if (evt === targetEvent) break;
	}

	const receiptData: ReceiptData = {
		event: targetEvent,
		chainLength: events.length,
		merkleRoot,
		merkleVerified,
		chainVerified,
		cumulativeSpend,
		verifiedAt: new Date(),
	};

	const allErrors = [...parseErrors, ...chainResult.errors];

	return {
		found: true,
		valid: chainVerified && merkleVerified,
		receipt: renderReceipt(receiptData),
		errors: allErrors,
	};
}
