#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { verifyTransaction, verifyVault } from "./index.js";

const args = process.argv.slice(2);

// Parse --tx flag
let vaultPath: string | undefined;
let txId: string | undefined;

for (let i = 0; i < args.length; i++) {
	const arg = args[i] as string;
	if (arg === "--tx" && i + 1 < args.length) {
		txId = args[i + 1] as string;
		i++; // skip next arg
	} else if (!arg.startsWith("--")) {
		vaultPath = arg;
	}
}

if (!vaultPath) {
	console.log("Usage: npx usertrust-verify <path-to-.usertrust> [--tx <transferId>]");
	process.exit(1);
}

// ── Single transaction mode ──
if (txId !== undefined) {
	const result = verifyTransaction(vaultPath, txId);
	console.log(result.receipt);
	// Exit 0: verified, 1: tampered/corrupted, 2: not found
	if (!result.found) process.exit(2);
	process.exit(result.valid ? 0 : 1);
}

// ── Full vault verification ──
const result = verifyVault(vaultPath);

if (result.valid) {
	console.log("Vault integrity: VERIFIED");
} else {
	console.log("Vault integrity: FAILED");
	for (const error of result.errors) {
		console.log(`  - ${error}`);
	}
}
console.log(`Chain length: ${result.chainLength} events`);
console.log(`Merkle root: ${result.merkleRoot ?? "N/A"}`);
console.log("Hash algorithm: SHA-256");
if (result.firstEvent) console.log(`First event: ${result.firstEvent}`);
if (result.lastEvent) console.log(`Last event: ${result.lastEvent}`);
if (result.chainLength > 0) {
	console.log(`All hashes: valid (${result.validHashes}/${result.chainLength})`);
}
