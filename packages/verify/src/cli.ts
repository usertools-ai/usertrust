#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * usertrust-verify CLI.
 *
 * Anchor contract (spec §7.5): the CALLER fetches anchor artifacts (aws s3
 * cp, git show, SIEM export) and passes them as files/stdin; trust material
 * (--pubkey = THE pinned genesis root, --successor-pin = rotation pins) is
 * pinned out-of-band and NEVER read from the vault under audit. --anchor-url
 * is an opt-in convenience (bare node:https GET); offline is the primary path.
 */

import { readFileSync } from "node:fs";
import { parseAnchorsContent } from "./anchor-verify.js";
import {
	type AnchoredVaultVerificationResult,
	type AnchorVerifyParams,
	exitCodeFor,
	exitCodeForAnchored,
	verifyTransaction,
	verifyVault,
	verifyVaultWithAnchors,
	type WitnessInput,
} from "./index.js";

const args = process.argv.slice(2);

function usage(): never {
	console.log(`Usage: npx usertrust-verify <path-to-.usertrust> [options]

Options:
  --tx <transferId>              Verify a single transaction (receipt)
  --anchor <file|->              Caller-fetched anchor artifact (repeatable; - = stdin)
  --anchors <file>               Anchor history file (JSONL; repeatable)
  --anchor-url <url>             Opt-in: fetch one anchor artifact over HTTPS
  --pubkey <pem-file>            PINNED genesis root public key (out-of-band)
  --successor-pin <pem-file>     Pinned rotation-successor key (repeatable)
  --vault-id <uuid>              Expected vaultId
  --require-anchor               Strict: UNANCHORED/UNVERIFIABLE/STALE exit 1
  --require-external-anchor      Strict: exit 0 only for externally anchored
  --max-anchor-age <dur>         Freshness policy, e.g. 1h, 30m (operator-claimed time)
  --max-unanchored-events <n>    Freshness policy (clock-independent; preferred)`);
	process.exit(1);
}

function parseDurationMs(raw: string): number {
	const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw);
	if (m === null) {
		console.error(`Invalid duration: ${raw} (use e.g. 500ms, 30s, 15m, 1h, 7d)`);
		process.exit(1);
	}
	const n = Number.parseInt(m[1] as string, 10);
	const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"] as number;
	return n * mult;
}

function readArtifact(pathOrDash: string): string {
	if (pathOrDash === "-") return readFileSync(0, "utf-8");
	return readFileSync(pathOrDash, "utf-8");
}

function fetchAnchorUrl(url: string): Promise<{ ok: boolean; body?: string; error?: string }> {
	return new Promise((resolve) => {
		import("node:https")
			.then((https) => {
				const req = https.get(url, { timeout: 15_000 }, (res) => {
					const code = res.statusCode ?? 0;
					if (code < 200 || code >= 300) {
						res.resume();
						resolve({ ok: false, error: `HTTP ${code}` });
						return;
					}
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => resolve({ ok: true, body: Buffer.concat(chunks).toString("utf-8") }));
				});
				req.on("timeout", () => req.destroy(new Error("timeout")));
				req.on("error", (err) => resolve({ ok: false, error: err.message }));
			})
			.catch((err: Error) => resolve({ ok: false, error: err.message }));
	});
}

// ── Parse flags ──

let vaultPath: string | undefined;
let txId: string | undefined;
const anchorFiles: string[] = [];
let anchorUrl: string | undefined;
let pubkeyFile: string | undefined;
const successorPinFiles: string[] = [];
let vaultId: string | undefined;
let requireAnchor = false;
let requireExternalAnchor = false;
let maxAnchorAgeMs: number | undefined;
let maxUnanchoredEvents: number | undefined;

for (let i = 0; i < args.length; i++) {
	const arg = args[i] as string;
	const next = (): string => {
		const v = args[i + 1];
		if (v === undefined) usage();
		i++;
		return v;
	};
	if (arg === "--tx") txId = next();
	else if (arg === "--anchor" || arg === "--anchors") anchorFiles.push(next());
	else if (arg === "--anchor-url") anchorUrl = next();
	else if (arg === "--pubkey") pubkeyFile = next();
	else if (arg === "--successor-pin") successorPinFiles.push(next());
	else if (arg === "--vault-id") vaultId = next();
	else if (arg === "--require-anchor") requireAnchor = true;
	else if (arg === "--require-external-anchor") requireExternalAnchor = true;
	else if (arg === "--max-anchor-age") maxAnchorAgeMs = parseDurationMs(next());
	else if (arg === "--max-unanchored-events") {
		const rawEvents = next();
		maxUnanchoredEvents = Number.parseInt(rawEvents, 10);
		// parseInt("1O0") === 1 (partial parse) and NaN comparisons are always
		// false — either typo would silently weaken the staleness gate.
		if (
			!/^\d+$/.test(rawEvents) ||
			!Number.isSafeInteger(maxUnanchoredEvents) ||
			maxUnanchoredEvents < 0
		) {
			console.error("Invalid --max-unanchored-events: must be a non-negative integer");
			process.exit(1);
		}
	} else if (arg === "--help" || arg === "-h") usage();
	else if (!arg.startsWith("--")) vaultPath = arg;
	else usage();
}

if (!vaultPath) usage();

const anchorMode =
	anchorFiles.length > 0 ||
	anchorUrl !== undefined ||
	pubkeyFile !== undefined ||
	requireAnchor ||
	requireExternalAnchor;

async function buildAnchorParams(): Promise<AnchorVerifyParams> {
	const externalAnchorsRaw: string[] = anchorFiles.map(readArtifact);
	let witness: WitnessInput = { requested: false };
	if (anchorUrl !== undefined) {
		const fetched = await fetchAnchorUrl(anchorUrl);
		// AC-2.4: a 2xx with an empty or fully-unparseable body is NOT a
		// consulted witness — treat it as unreachable (inconclusive) and never
		// let it launder mirror-only evidence into anchorSource "external".
		// But a body with ANY cleanly parsed records IS evidence: keep the
		// whole body (embedded parse errors fail closed downstream) — throwing
		// away 50 valid records over one truncated line would discard the very
		// rollback proof the witness exists to provide.
		const parsed =
			fetched.ok && fetched.body !== undefined ? parseAnchorsContent(fetched.body) : null;
		if (parsed !== null && parsed.records.length > 0) {
			externalAnchorsRaw.push(fetched.body as string);
			witness = { requested: true, ok: true };
		} else {
			witness = {
				requested: true,
				ok: false,
				error: fetched.ok
					? "witness returned an empty or unparseable body"
					: (fetched.error ?? "fetch failed"),
			};
		}
	}
	const trust =
		pubkeyFile !== undefined
			? {
					rootPem: readFileSync(pubkeyFile, "utf-8"),
					...(successorPinFiles.length > 0
						? { successorPinsPem: successorPinFiles.map((f) => readFileSync(f, "utf-8")) }
						: {}),
				}
			: undefined;
	return {
		externalAnchorsRaw,
		...(trust !== undefined ? { trust } : {}),
		witness,
		...(maxAnchorAgeMs !== undefined ? { maxAnchorAgeMs } : {}),
		...(maxUnanchoredEvents !== undefined ? { maxUnanchoredEvents } : {}),
		...(vaultId !== undefined ? { expectedVaultId: vaultId } : {}),
	};
}

function printAnchorSection(result: AnchoredVaultVerificationResult): void {
	const a = result.anchoring;
	if (result.anchorState === "UNANCHORED") {
		console.log(
			"Anchor state: UNANCHORED — internal consistency only; supply --anchor + --pubkey for independent verification",
		);
		return;
	}
	console.log(`Anchor state: ${result.anchorState} (source: ${a.anchorSource})`);
	if (a.latestAnchor) {
		console.log(
			`Latest anchor: #${a.latestAnchor.anchorSeq} treeSize ${a.latestAnchor.treeSize} keyId ${a.latestAnchor.keyId.slice(0, 19)}… (${a.latestAnchor.timestamp})`,
		);
	}
	console.log(`Unanchored tail: ${a.unanchoredTail.events} event(s)`);
	if (a.witness.requested) {
		console.log(`Witness: ${a.witness.status}${a.witness.error ? ` (${a.witness.error})` : ""}`);
	}
	if (a.anchorSource === "vault-mirror") {
		console.log(
			"WARNING: anchors verified from the VAULT-LOCAL mirror only — a vault-writing attacker can truncate mirror and events together. Supply an externally fetched copy.",
		);
	}
	for (const w of a.warnings) {
		console.log(`WARNING: ${w}`);
	}
}

// ── Single transaction mode ──
if (txId !== undefined) {
	const params = anchorMode ? await buildAnchorParams() : undefined;
	const result = verifyTransaction(vaultPath, txId, params);
	console.log(result.receipt);
	// Exit 0: verified, 1: tampered/corrupted, 2: not found
	if (!result.found) process.exit(2);
	if (!result.valid) process.exit(1);
	// Strict gates apply in --tx mode too — the flags turned anchorMode on,
	// so silently ignoring them here would let an UNANCHORED receipt pass a
	// --require-external-anchor pipeline.
	if (result.anchorState !== undefined && result.anchoring !== undefined) {
		process.exit(
			exitCodeForAnchored(
				{ valid: true, anchorState: result.anchorState, anchoring: result.anchoring },
				{ requireAnchor, requireExternalAnchor },
			),
		);
	}
	process.exit(0);
}

// ── Full vault verification ──
if (!anchorMode) {
	const result = verifyVault(vaultPath);
	if (result.valid) {
		console.log("Vault integrity: VERIFIED (UNANCHORED — internal consistency only)");
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
	process.exit(exitCodeFor(result));
}

const result = verifyVaultWithAnchors(vaultPath, await buildAnchorParams());
if (result.valid) {
	console.log(
		result.anchorState === "ANCHORED_VERIFIED"
			? `Vault integrity: VERIFIED (${result.anchoring.anchorSource === "external" ? "externally anchored" : "vault-mirror anchors only"})`
			: `Vault integrity: VERIFIED (${result.anchorState})`,
	);
} else {
	console.log(`Vault integrity: FAILED (${result.anchorState})`);
	for (const error of result.errors) {
		console.log(`  - ${error}`);
	}
}
printAnchorSection(result);
console.log(`Chain length: ${result.chainLength} events`);
console.log(`Merkle root: ${result.merkleRoot ?? "N/A"}`);
console.log("Hash algorithm: SHA-256");
if (result.chainLength > 0) {
	console.log(`All hashes: valid (${result.validHashes}/${result.chainLength})`);
}
process.exit(exitCodeForAnchored(result, { requireAnchor, requireExternalAnchor }));
