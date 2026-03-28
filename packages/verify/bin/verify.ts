#!/usr/bin/env node
import { verifyVault } from "../src/index.js";

const vaultPath = process.argv[2];

if (!vaultPath) {
	console.log("Usage: npx usertrust-verify <path-to-.usertrust>");
	process.exit(1);
}

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
