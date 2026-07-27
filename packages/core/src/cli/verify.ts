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
	"--pubkey",
	"--successor-pin",
	"--require-anchor",
	"--require-external-anchor",
	"--max-anchor-age",
	"--max-unanchored-events",
	"--vault-id",
]);

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
	let anchorUrl: string | undefined;
	let pubkeyFile: string | undefined;
	const successorPinFiles: string[] = [];
	let requireAnchor = false;
	let requireExternalAnchor = false;
	let maxAnchorAgeMs: number | undefined;
	let maxUnanchoredEvents: number | undefined;
	let vaultId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const next = (): string | undefined => argv[++i];
		if (arg === "--anchor" || arg === "--anchors") {
			const v = next();
			if (v !== undefined) anchorFiles.push(v);
		} else if (arg === "--anchor-url") anchorUrl = next();
		else if (arg === "--pubkey") pubkeyFile = next();
		else if (arg === "--successor-pin") {
			const v = next();
			if (v !== undefined) successorPinFiles.push(v);
		} else if (arg === "--require-anchor") requireAnchor = true;
		else if (arg === "--require-external-anchor") requireExternalAnchor = true;
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
	const externalAnchorsRaw = anchorFiles.map((f) =>
		f === "-" ? readFileSync(0, "utf-8") : readFileSync(f, "utf-8"),
	);
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
		requireAnchor ||
		requireExternalAnchor;
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
		params: {
			externalAnchorsRaw,
			...(trust !== undefined ? { trust } : {}),
			witness,
			...(maxAnchorAgeMs !== undefined ? { maxAnchorAgeMs } : {}),
			...(maxUnanchoredEvents !== undefined ? { maxUnanchoredEvents } : {}),
			...(vaultId !== undefined ? { expectedVaultId: vaultId } : {}),
		},
	};
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
		});
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
		if (result.anchoring.latestAnchor) {
			const la = result.anchoring.latestAnchor;
			console.log(`Latest anchor: #${la.anchorSeq} treeSize ${la.treeSize} (${la.timestamp})`);
		}
		console.log(`Unanchored tail: ${result.anchoring.unanchoredTail.events} event(s)`);
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
