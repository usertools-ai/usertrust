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
	type WitnessLogReport,
} from "./index.js";
import {
	RECEIPT_DISPATCH_TOKEN,
	type ReceiptCliIo,
	runReceiptCli,
	writeAllSync,
} from "./receipt-cli.js";

/**
 * `receipt` dispatch (CLI spec §2). MUST run before a single byte of the
 * vault flag loop below: `argv[0] === "receipt"` is checked EXACTLY, every
 * flag receipt mode defines is unknown to the vault parser (which would call
 * `usage()` and exit 1 — FAILED, the wrong code for a usage mistake), and a
 * bare positional named `receipt` would otherwise be consumed as
 * `vaultPath`. `process.exit` below is synchronous, so nothing after this
 * block — including the `const args = …` vault path — ever executes on this
 * branch.
 *
 * The output goes out through `writeAllSync` rather than
 * `process.stdout.write`, and that is load-bearing rather than stylistic:
 * `process.stdout` is ASYNCHRONOUS on a POSIX pipe, and `process.exit` does not
 * drain it. `--json | jq` would then see a report truncated mid-object beside
 * an exit code that says the receipt verified. The exit codes are the CI
 * contract, so the fix is to make the bytes land BEFORE the exit, never to
 * soften the exit.
 */
if (process.argv[2] === RECEIPT_DISPATCH_TOKEN) {
	const realIo: ReceiptCliIo = {
		readFile: (path) => readFileSync(path),
		readStdin: () => readFileSync(0),
	};
	const result = runReceiptCli(process.argv.slice(3), realIo);
	writeAllSync(1, result.stdout);
	writeAllSync(2, result.stderr);
	process.exit(result.exitCode);
}

const args = process.argv.slice(2);

function usage(): never {
	console.log(`Usage: npx usertrust-verify <path-to-.usertrust> [options]
       npx usertrust-verify receipt <file> --trust <snapshot.json> [options]

Options:
  --tx <transferId>              Verify a single transaction (receipt)
  --anchor <file|->              Caller-fetched anchor artifact (repeatable; - = stdin)
  --anchors <file>               Anchor history file (JSONL; repeatable)
  --anchor-url <url>             Opt-in: fetch one anchor artifact over HTTPS
  --bundle <file|->              Auditor bundle {v,records,rekorReceipts} (usertrust anchor export-bundle)
  --rekor-receipts <file|->      Transparency-log receipt(s), JSON or JSONL (repeatable)
  --rekor-pubkey <pem-file>      PINNED transparency-log public key (repeatable)
  --pubkey <pem-file>            PINNED genesis root public key (out-of-band)
  --successor-pin <pem-file>     Pinned rotation-successor key (repeatable)
  --vault-id <uuid>              Expected vaultId
  --require-anchor               Strict: UNANCHORED/UNVERIFIABLE/STALE exit 1
  --require-external-anchor      Strict: exit 0 only for externally anchored
  --require-witness              Strict: exit 0 only when every anchor is
                                 covered by a verified transparency-log receipt
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

const MAX_PEM_BYTES = 16 * 1024;
const MAX_BUNDLE_ITEMS = 10_000;
const BUNDLE_KEYS = new Set(["v", "records", "rekorReceipts"]);

/**
 * Read one pinned log key. A file that carries no usable PEM is a usage error,
 * not an empty pin: the verifier discards unusable entries, so accepting one
 * here would leave the caller believing they pinned a key while the receipt was
 * checked against something else entirely.
 */
function readPinnedPem(path: string): string {
	const pem = readFileSync(path, "utf-8");
	if (Buffer.byteLength(pem, "utf8") > MAX_PEM_BYTES) {
		console.error(`--rekor-pubkey ${path}: PEM exceeds 16 KiB`);
		process.exit(1);
	}
	if (pem.trim().length === 0 || !pem.includes("-----BEGIN PUBLIC KEY-----")) {
		console.error(
			`--rekor-pubkey ${path}: not a PEM public key (-----BEGIN PUBLIC KEY----- missing)`,
		);
		process.exit(1);
	}
	return pem;
}

// Matching control characters is the entire point here — they are what gets
// removed from anything echoed back to a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the intent
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * An untrusted field NAME on its way into an error string. Control characters
 * are stripped before truncation: these strings are printed to a terminal, and
 * an escape sequence inside a key would let the party under audit repaint the
 * line its own verdict is printed on.
 */
function clipKey(key: string): string {
	const scrubbed = key.replace(CONTROL_CHARS, "");
	return scrubbed.length <= 80 ? scrubbed : `${scrubbed.slice(0, 80)}...`;
}

/**
 * Strict parse of an auditor bundle: `{v:1, records, rekorReceipts?}`. A bundle
 * is untrusted transport, so unknown top-level fields are rejected rather than
 * ignored — a field the CLI silently drops is one an exporter can use to carry
 * evidence the verifier never looks at. Element shapes are NOT validated here:
 * records and receipts are re-serialized and go through the same strict parsers
 * every other input does.
 */
function parseBundle(raw: string): { anchorsRaw: string; receiptsRaw: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("--bundle: not valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("--bundle: not an object");
	}
	const obj = parsed as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (!BUNDLE_KEYS.has(key)) throw new Error(`--bundle: unknown field "${clipKey(key)}"`);
	}
	if (obj.v !== 1) throw new Error("--bundle: unsupported version (expected 1)");
	if (!Array.isArray(obj.records)) throw new Error("--bundle: records must be an array");
	if (obj.records.length > MAX_BUNDLE_ITEMS) {
		throw new Error(`--bundle: records exceeds the ${MAX_BUNDLE_ITEMS} cap`);
	}
	const receipts = obj.rekorReceipts ?? [];
	if (!Array.isArray(receipts)) throw new Error("--bundle: rekorReceipts must be an array");
	if (receipts.length > MAX_BUNDLE_ITEMS) {
		throw new Error(`--bundle: rekorReceipts exceeds the ${MAX_BUNDLE_ITEMS} cap`);
	}
	return {
		anchorsRaw: obj.records.map((record) => JSON.stringify(record)).join("\n"),
		receiptsRaw: receipts.map((receipt) => JSON.stringify(receipt)),
	};
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
const rekorReceiptFiles: string[] = [];
const rekorPubkeyFiles: string[] = [];
let bundleFile: string | undefined;
let anchorUrl: string | undefined;
let pubkeyFile: string | undefined;
const successorPinFiles: string[] = [];
let vaultId: string | undefined;
let requireAnchor = false;
let requireExternalAnchor = false;
let requireWitness = false;
let maxAnchorAgeMs: number | undefined;
let maxUnanchoredEvents: number | undefined;

for (let i = 0; i < args.length; i++) {
	const raw = args[i] as string;
	// `--flag=value` so a value that legitimately begins with "-" is still
	// passable; the space-separated form refuses one.
	const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
	const arg = eq > 0 ? raw.slice(0, eq) : raw;
	const inlineValue = eq > 0 ? raw.slice(eq + 1) : undefined;
	// A FLAG IS NEVER A VALUE. `--vault-id --require-witness` previously consumed
	// the gate as the vault id, so the run verified unanchored, printed no
	// witness line, and exited 0 — a strict flag silently disarmed by an
	// adjacent flag, which leaves a CI pipeline green while checking nothing.
	const next = (): string => {
		if (inlineValue !== undefined) return inlineValue;
		const v = args[i + 1];
		if (v === undefined) usage();
		if (v.startsWith("-")) {
			console.error(`${arg} requires a value (write ${arg}=${v} to pass it literally)`);
			process.exit(2);
		}
		i++;
		return v;
	};
	if (arg === "--tx") txId = next();
	else if (arg === "--anchor" || arg === "--anchors") anchorFiles.push(next());
	else if (arg === "--anchor-url") anchorUrl = next();
	else if (arg === "--rekor-receipts") rekorReceiptFiles.push(next());
	else if (arg === "--rekor-pubkey") rekorPubkeyFiles.push(next());
	else if (arg === "--bundle") bundleFile = next();
	else if (arg === "--pubkey") pubkeyFile = next();
	else if (arg === "--successor-pin") successorPinFiles.push(next());
	else if (arg === "--vault-id") vaultId = next();
	else if (arg === "--require-anchor") requireAnchor = true;
	else if (arg === "--require-external-anchor") requireExternalAnchor = true;
	else if (arg === "--require-witness") requireWitness = true;
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
	bundleFile !== undefined ||
	rekorReceiptFiles.length > 0 ||
	requireAnchor ||
	requireExternalAnchor ||
	requireWitness;

async function buildAnchorParams(): Promise<AnchorVerifyParams> {
	const externalAnchorsRaw: string[] = anchorFiles.map(readArtifact);
	const rekorReceiptsRaw: string[] = rekorReceiptFiles.map(readArtifact);
	if (bundleFile !== undefined) {
		try {
			const bundle = parseBundle(readArtifact(bundleFile));
			externalAnchorsRaw.push(bundle.anchorsRaw);
			rekorReceiptsRaw.push(...bundle.receiptsRaw);
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	}
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
		rekorReceiptsRaw,
		rekorLogPubkeysPem: rekorPubkeyFiles.map(readPinnedPem),
		...(trust !== undefined ? { trust } : {}),
		witness,
		...(maxAnchorAgeMs !== undefined ? { maxAnchorAgeMs } : {}),
		...(maxUnanchoredEvents !== undefined ? { maxUnanchoredEvents } : {}),
		...(vaultId !== undefined ? { expectedVaultId: vaultId } : {}),
	};
}

/**
 * A witness-attested time on its way to a terminal. The receipt parser bounds
 * integratedTime, but this value also arrives from library callers, and
 * `toISOString()` throws RangeError outside ±8.64e15 ms — printing raw
 * milliseconds beats crashing the verifier over a number it already distrusts.
 */
function formatAttestedMs(ms: number): string {
	return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : `${ms} ms`;
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
	if (a.rekor !== undefined) {
		const attested =
			a.rekor.latestAttestedTimeMs === null
				? ""
				: `, attested ${formatAttestedMs(a.rekor.latestAttestedTimeMs)}`;
		const failed = a.rekor.receiptsFailed > 0 ? `, ${a.rekor.receiptsFailed} FAILED` : "";
		console.log(`Rekor: ${a.rekor.receiptsVerified} receipt(s) verified${failed}${attested}`);
	}
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

/**
 * Render the transparency-log witness state. Called on EVERY path that reports
 * an anchored verdict — full-vault and --tx alike. An affirmative verdict
 * printed without this line cannot be told apart from one whose witness leg
 * never ran, which is the absence this whole surface exists to make visible.
 */
function printWitnessLine(w: WitnessLogReport): void {
	const reasons = w.reasons.length > 0 ? ` [${w.reasons.join(", ")}]` : "";
	console.log(`Witness log: ${w.state} (${w.covered}/${w.anchors} anchors covered)${reasons}`);
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
		// The witness line belongs here TOO, and printing it before the exit is
		// the whole point: --tx previously printed an affirmative "* VERIFIED *"
		// receipt and left through the gate below with nothing on screen about
		// the transparency log. Under --require-witness that meant exit 1 beside
		// a receipt that still read as a pass — the operator sees the
		// affirmation, not the reason. An anchored transaction with no witness
		// evidence must say so on the same page as its verdict.
		printWitnessLine(result.anchoring.witnessLog);
		process.exit(
			exitCodeForAnchored(
				{ valid: true, anchorState: result.anchorState, anchoring: result.anchoring },
				{ requireAnchor, requireExternalAnchor, requireWitness },
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
// ALWAYS printed, including — especially — when nothing was witnessed. An
// auditor reading "VERIFIED (externally anchored)" with no witness line cannot
// tell a witnessed vault from one that never was.
printWitnessLine(result.anchoring.witnessLog);
process.exit(exitCodeForAnchored(result, { requireAnchor, requireExternalAnchor, requireWitness }));
