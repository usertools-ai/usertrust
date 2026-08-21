// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust verify — Verify audit chain integrity
 *
 * Calls verifyVault() on the local vault (anchored to the `.meta` head, spans
 * rotated segments) and displays the result. Sets a nonzero process exit code
 * on a FAILED verdict so CI gates fail on a tampered vault.
 *
 * External-anchor flags (spec §7.5) mirror the standalone usertrust-verify
 * CLI: the caller fetches anchor artifacts and pins the public key
 * out-of-band; trust is never read from the vault under audit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { parseAnchorsContent } from "../audit/anchor-verify.js";
import {
	type AnchorVerifyParams,
	exitCodeForAnchored,
	verifyVault,
	verifyVaultWithAnchors,
	type WitnessInput,
	type WitnessLogReport,
} from "../audit/verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

function parseDurationMs(raw: string): number {
	const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw);
	if (m === null) {
		// Silently dropping the policy would quietly disable the staleness
		// gate — the exact fail-open the unknown-flag rejection exists to stop.
		throw new Error(`Invalid --max-anchor-age: ${raw} (use e.g. 500ms, 30s, 15m, 1h, 7d)`);
	}
	const n = Number.parseInt(m[1] as string, 10);
	const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"] as number;
	return n * mult;
}

interface AnchorFlags {
	anchorMode: boolean;
	params: AnchorVerifyParams;
	requireAnchor: boolean;
	requireExternalAnchor: boolean;
	requireWitness: boolean;
}

const KNOWN_VERIFY_FLAGS = new Set([
	// Global flags main.ts accepts for every subcommand — rejecting them here
	// would break existing `usertrust verify --skip-verify`-style invocations.
	"--json",
	"--skip-verify",
	"--reconfigure",
	// Anchor flags.
	"--anchor",
	"--anchors",
	"--anchor-url",
	"--bundle",
	"--rekor-receipts",
	"--rekor-pubkey",
	"--pubkey",
	"--successor-pin",
	"--require-anchor",
	"--require-external-anchor",
	"--require-witness",
	"--max-anchor-age",
	"--max-unanchored-events",
	"--vault-id",
]);

const MAX_PEM_BYTES = 16 * 1024;
const MAX_BUNDLE_ITEMS = 10_000;
const BUNDLE_KEYS = new Set(["v", "records", "rekorReceipts"]);

function readArtifact(pathOrDash: string): string {
	return pathOrDash === "-" ? readFileSync(0, "utf-8") : readFileSync(pathOrDash, "utf-8");
}

/**
 * Read one pinned log key. A file that carries no usable PEM is a usage error,
 * not an empty pin: the verifier discards unusable entries, so accepting one
 * here would leave the caller believing they pinned a key while the receipt was
 * checked against something else entirely.
 */
function readPinnedPem(path: string): string {
	const pem = readFileSync(path, "utf-8");
	if (Buffer.byteLength(pem, "utf8") > MAX_PEM_BYTES) {
		throw new Error(`--rekor-pubkey ${path}: PEM exceeds 16 KiB`);
	}
	if (pem.trim().length === 0 || !pem.includes("-----BEGIN PUBLIC KEY-----")) {
		throw new Error(
			`--rekor-pubkey ${path}: not a PEM public key (-----BEGIN PUBLIC KEY----- missing)`,
		);
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

async function parseAnchorFlags(argv: string[]): Promise<AnchorFlags> {
	const anchorFiles: string[] = [];
	const rekorReceiptFiles: string[] = [];
	const rekorPubkeyFiles: string[] = [];
	let bundleFile: string | undefined;
	let anchorUrl: string | undefined;
	let pubkeyFile: string | undefined;
	const successorPinFiles: string[] = [];
	let requireAnchor = false;
	let requireExternalAnchor = false;
	let requireWitness = false;
	let maxAnchorAgeMs: number | undefined;
	let maxUnanchoredEvents: number | undefined;
	let vaultId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i] as string;
		// `--flag=value` is parsed here so a value that legitimately begins with
		// "-" can still be passed; the space-separated form refuses one.
		const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
		const arg = eq > 0 ? raw.slice(0, eq) : raw;
		const inlineValue = eq > 0 ? raw.slice(eq + 1) : undefined;
		/**
		 * A FLAG IS NEVER A VALUE.
		 *
		 * This previously took the next token unconditionally, so
		 * `--vault-id --require-witness` consumed the GATE as the vault id: the
		 * run then verified unanchored, printed no witness line, and exited 0.
		 * A strict flag silently disarmed by an adjacent flag is the worst shape
		 * available for a CI gate — the pipeline stays green while checking
		 * nothing. Mirrors `requireValue` in cli/budget.ts, including the
		 * `--flag=value` escape it names.
		 */
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				// `--pubkey=` is a typo, not an empty path. Accepting it handed ""
				// to readFileSync and produced an uncaught stack trace.
				if (inlineValue === "") throw new Error(`${arg} requires a value`);
				return inlineValue;
			}
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`${arg} requires a value`);
			// A BARE "-" IS A VALUE, NOT A FLAG — it means stdin, it is documented
			// (packages/verify/README.md), and `readArtifact` special-cases it.
			// The first cut of this guard rejected every leading dash and broke
			// `--anchor -`, `--bundle -` and `--rekor-receipts -`: a security fix
			// that silently removed a working, documented feature. Reject flags,
			// not dashes.
			if (v !== "-" && v.startsWith("-")) {
				throw new Error(`${arg} requires a value (write ${arg}=${v} to pass it literally)`);
			}
			i++;
			return v;
		};
		if (arg === "--anchor" || arg === "--anchors") {
			const v = next();
			if (v !== undefined) anchorFiles.push(v);
		} else if (arg === "--rekor-receipts") {
			const v = next();
			if (v !== undefined) rekorReceiptFiles.push(v);
		} else if (arg === "--rekor-pubkey") {
			const v = next();
			if (v !== undefined) rekorPubkeyFiles.push(v);
		} else if (arg === "--bundle") bundleFile = next();
		else if (arg === "--anchor-url") anchorUrl = next();
		else if (arg === "--pubkey") pubkeyFile = next();
		else if (arg === "--successor-pin") {
			const v = next();
			if (v !== undefined) successorPinFiles.push(v);
		} else if (arg === "--require-anchor") requireAnchor = true;
		else if (arg === "--require-external-anchor") requireExternalAnchor = true;
		else if (arg === "--require-witness") requireWitness = true;
		else if (arg === "--max-anchor-age") {
			const v = next();
			if (v === undefined) throw new Error("--max-anchor-age requires a value");
			maxAnchorAgeMs = parseDurationMs(v);
		} else if (arg === "--max-unanchored-events") {
			const v = next();
			maxUnanchoredEvents = Number.parseInt(v ?? "", 10);
			// parseInt("1O0") === 1 (partial parse) and NaN comparisons are always
			// false — either typo would silently weaken the staleness gate.
			// Require the WHOLE value to be a non-negative integer.
			if (
				!/^\d+$/.test(v ?? "") ||
				!Number.isSafeInteger(maxUnanchoredEvents) ||
				maxUnanchoredEvents < 0
			) {
				throw new Error(`Invalid --max-unanchored-events: ${v} (non-negative integer required)`);
			}
		} else if (arg === "--vault-id") vaultId = next();
		else if (arg.startsWith("--") && !KNOWN_VERIFY_FLAGS.has(arg)) {
			// Reject unknown flags rather than silently ignoring them — a typoed
			// --require-anchro must not quietly weaken a CI gate.
			throw new Error(`Unknown flag: ${arg}`);
		}
	}
	const externalAnchorsRaw = anchorFiles.map(readArtifact);
	const rekorReceiptsRaw = rekorReceiptFiles.map(readArtifact);
	const rekorLogPubkeysPem = rekorPubkeyFiles.map(readPinnedPem);
	if (bundleFile !== undefined) {
		const bundle = parseBundle(readArtifact(bundleFile));
		externalAnchorsRaw.push(bundle.anchorsRaw);
		rekorReceiptsRaw.push(...bundle.receiptsRaw);
	}
	let witness: WitnessInput = { requested: false };
	if (anchorUrl !== undefined) {
		const fetched = await fetchAnchorUrl(anchorUrl);
		// Empty/fully-unparseable body = witness unreachable (inconclusive).
		// A body with ANY cleanly parsed records IS evidence — keep it whole;
		// embedded parse errors fail closed downstream instead of discarding
		// the rollback proof the valid records carry.
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
	const anchorMode =
		anchorFiles.length > 0 ||
		anchorUrl !== undefined ||
		pubkeyFile !== undefined ||
		bundleFile !== undefined ||
		rekorReceiptFiles.length > 0 ||
		requireAnchor ||
		requireExternalAnchor ||
		requireWitness;
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
		anchorMode,
		requireAnchor,
		requireExternalAnchor,
		requireWitness,
		params: {
			externalAnchorsRaw,
			rekorReceiptsRaw,
			rekorLogPubkeysPem,
			...(trust !== undefined ? { trust } : {}),
			witness,
			...(maxAnchorAgeMs !== undefined ? { maxAnchorAgeMs } : {}),
			...(maxUnanchoredEvents !== undefined ? { maxUnanchoredEvents } : {}),
			...(vaultId !== undefined ? { expectedVaultId: vaultId } : {}),
		},
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

/**
 * Render the transparency-log witness state. ALWAYS called on the anchored
 * path, including — especially — when nothing was witnessed.
 *
 * An operator reading "Vault integrity: VERIFIED (externally anchored)" with no
 * witness line cannot tell a witnessed vault from one that never was, which is
 * exactly how this repo's Rekor sink stayed non-functional for six months. The
 * library reports the state; printing it is what makes the absence visible to
 * the person who has to act on it.
 */
function printWitnessLine(w: WitnessLogReport): void {
	const detail = `${w.covered}/${w.anchors} anchors covered`;
	if (w.state === "WITNESS_VERIFIED") {
		console.log(pc.green(`Witness log: ${w.state} (${detail})`));
		return;
	}
	const reasons = w.reasons.length > 0 ? ` [${w.reasons.join(", ")}]` : "";
	console.log(pc.yellow(`Witness log: ${w.state} (${detail})${reasons}`));
}

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	let flags: AnchorFlags;
	try {
		flags = await parseAnchorFlags(process.argv.slice(2));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (json) {
			console.log(JSON.stringify({ command: "verify", success: false, data: { message } }));
		} else {
			console.log(pc.red(message));
		}
		process.exitCode = 1;
		return;
	}

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "verify",
					success: false,
					data: { message: "No trust vault found. Run `usertrust init` first." },
				}),
			);
		} else {
			console.log(`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`);
		}
		// A missing vault is a failed verification for CI purposes.
		process.exitCode = 1;
		return;
	}

	const verifiedAt = new Date().toISOString();

	if (flags.anchorMode) {
		const result = verifyVaultWithAnchors(vaultPath, flags.params);
		const exitCode = exitCodeForAnchored(result, {
			requireAnchor: flags.requireAnchor,
			requireExternalAnchor: flags.requireExternalAnchor,
			requireWitness: flags.requireWitness,
		});
		if (json) {
			console.log(
				JSON.stringify({
					command: "verify",
					// NOT `result.valid` alone. A witness gate can exit 1 while the
					// chain itself is valid, and a consumer reading the body rather
					// than $? would have been told the run succeeded — the exact
					// silent success this surface exists to remove.
					success: result.valid && exitCode === 0,
					data: {
						valid: result.valid,
						chainLength: result.chainLength,
						errors: result.errors,
						merkleRoot: result.merkleRoot,
						anchorState: result.anchorState,
						anchoring: result.anchoring,
						verifiedAt,
					},
				}),
			);
			if (exitCode !== 0) process.exitCode = exitCode;
			return;
		}
		if (result.valid) {
			console.log(pc.green(`Chain verified: ${result.chainLength} events, all hashes valid.`));
		} else {
			console.log(pc.red(`Chain verification FAILED: ${result.errors.length} error(s) found.`));
			for (const err of result.errors) {
				console.log(pc.red(`  - ${err}`));
			}
		}
		console.log(`Anchor state: ${result.anchorState} (source: ${result.anchoring.anchorSource})`);
		// ALWAYS printed, including — especially — when nothing was witnessed.
		// An operator seeing "VERIFIED (externally anchored)" with no witness line
		// cannot tell a witnessed vault from one that never was.
		printWitnessLine(result.anchoring.witnessLog);
		if (result.anchoring.latestAnchor) {
			const la = result.anchoring.latestAnchor;
			console.log(`Latest anchor: #${la.anchorSeq} treeSize ${la.treeSize} (${la.timestamp})`);
		}
		console.log(`Unanchored tail: ${result.anchoring.unanchoredTail.events} event(s)`);
		const rekor = result.anchoring.rekor;
		if (rekor !== undefined) {
			const attested =
				rekor.latestAttestedTimeMs === null
					? ""
					: `, attested ${formatAttestedMs(rekor.latestAttestedTimeMs)}`;
			const failed = rekor.receiptsFailed > 0 ? `, ${rekor.receiptsFailed} FAILED` : "";
			console.log(`Rekor: ${rekor.receiptsVerified} receipt(s) verified${failed}${attested}`);
		}
		if (result.anchoring.anchorSource === "vault-mirror") {
			console.log(
				pc.yellow(
					"WARNING: anchors verified from the vault-local mirror only — supply an externally fetched copy for deletion protection.",
				),
			);
		}
		for (const w of result.anchoring.warnings) {
			console.log(pc.yellow(`WARNING: ${w}`));
		}
		console.log(pc.dim(`Verified at: ${verifiedAt}`));
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	const result = verifyVault(vaultPath);

	if (json) {
		console.log(
			JSON.stringify({
				command: "verify",
				success: result.valid,
				data: {
					valid: result.valid,
					chainLength: result.chainLength,
					errors: result.errors,
					merkleRoot: result.merkleRoot,
					anchorState: "UNANCHORED",
					verifiedAt,
				},
			}),
		);
		if (!result.valid) process.exitCode = 1;
		return;
	}

	if (result.valid) {
		console.log(pc.green(`Chain verified: ${result.chainLength} events, all hashes valid.`));
		if (result.merkleRoot) console.log(`Merkle root: ${pc.dim(result.merkleRoot)}`);
		console.log(
			pc.dim(
				"Anchor state: UNANCHORED — internal consistency only; supply --anchor + --pubkey for independent verification.",
			),
		);
	} else {
		console.log(pc.red(`Chain verification FAILED: ${result.errors.length} error(s) found.`));
		console.log(`Events checked: ${result.chainLength}`);
		for (const err of result.errors) {
			console.log(pc.red(`  - ${err}`));
		}
		// Use process.exitCode (not process.exit) so buffered stdout flushes.
		process.exitCode = 1;
	}

	console.log(pc.dim(`Verified at: ${verifiedAt}`));
}
