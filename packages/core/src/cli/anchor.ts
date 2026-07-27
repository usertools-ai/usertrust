// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust anchor — external audit anchoring
 *
 * init           Mint the vault's anchor identity (Ed25519 key OUTSIDE the vault)
 * now            One snapshot → sign → mirror → publish cycle
 * status         Last anchor, unanchored tail, outbox depth
 * export         Print mirror records (JSONL) for pull-mode shipping
 * export-bundle  Records + transparency-log receipts as one auditor artifact
 * doctor         Probe what this identity can delete/overwrite in the store
 * rotate         Cross-signed key rotation (spec §6)
 * resume         Re-seed a lost mirror from the store's newest record
 *
 * Spec: docs/superpowers/specs/2026-07-26-external-anchoring-design.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
	type AnchoringConfig,
	anchorsDir,
	createAnchorEmitter,
	initAnchorIdentity,
	mintSuccessorKey,
	readAnchorIdentity,
	recordRotatedIdentity,
	resumeAnchorMirror,
	type SinkConfig,
} from "../audit/anchor.js";
import { type DoctorReport, doctorFileSink, doctorS3Sink } from "../audit/anchor-doctor.js";
import { parseAnchorsContent } from "../audit/anchor-verify.js";
import { DEFAULT_REKOR_URL } from "../audit/rekor.js";
import { parseRekorReceipt, type RekorReceipt } from "../audit/rekor-verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

const REKOR_FLAG = "--sink-rekor";
const S3_KEYS = new Set(["bucket", "region", "prefix", "endpoint"]);
/** Same cap the verify CLI enforces on `--bundle` — never export what it refuses. */
const MAX_BUNDLE_ITEMS = 10_000;

function sinksFromArgs(args: string[]): SinkConfig[] {
	const sinks: SinkConfig[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--sink-file" && args[i + 1] !== undefined) {
			sinks.push({ type: "file", path: args[i + 1] as string });
			i++;
		} else if (arg === "--sink-url" && args[i + 1] !== undefined) {
			sinks.push({ type: "https", url: args[i + 1] as string });
			i++;
		} else if (arg === "--sink-s3" && args[i + 1] !== undefined) {
			sinks.push(s3SinkFromSpec(args[i + 1] as string));
			i++;
		} else if (arg === REKOR_FLAG) {
			// Delta D8: this flag never consumes the token after it, so
			// `--sink-rekor --sink-file /mnt/worm/a.jsonl` keeps its file sink. A
			// URL parked there was meant as the log address, and defaulting to
			// the public log instead would publish somewhere the operator never
			// named — refuse rather than reinterpret.
			const stray = args[i + 1];
			if (stray !== undefined && /^https?:\/\//.test(stray)) {
				throw new Error(`${REKOR_FLAG} takes no separate value — use ${REKOR_FLAG}=<url>`);
			}
			sinks.push({ type: "rekor" });
		} else if (arg.startsWith(`${REKOR_FLAG}=`)) {
			const url = arg.slice(REKOR_FLAG.length + 1);
			if (url === "") throw new Error(`${REKOR_FLAG}=<url> requires a URL`);
			sinks.push({ type: "rekor", url });
		}
	}
	return sinks;
}

/** `bucket=B,region=R[,prefix=P][,endpoint=E]` — every key is explicit, none inferred. */
function s3SinkFromSpec(spec: string): SinkConfig {
	const fields: Record<string, string> = {};
	for (const part of spec.split(",")) {
		if (part.trim() === "") continue;
		const eq = part.indexOf("=");
		if (eq <= 0) {
			throw new Error(`--sink-s3: expected key=value, got "${part.slice(0, 60)}"`);
		}
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!S3_KEYS.has(key)) {
			throw new Error(
				`--sink-s3: unknown key "${key.slice(0, 40)}" (bucket, region, prefix, endpoint)`,
			);
		}
		if (value === "") throw new Error(`--sink-s3: ${key} requires a value`);
		fields[key] = value;
	}
	const { bucket, region, prefix, endpoint } = fields;
	if (bucket === undefined || region === undefined) {
		throw new Error("--sink-s3 requires bucket=<name>,region=<region>");
	}
	return {
		type: "s3",
		bucket,
		region,
		...(prefix !== undefined ? { prefix } : {}),
		...(endpoint !== undefined ? { endpoint } : {}),
	};
}

function flagValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || args[idx + 1] === undefined) return undefined;
	return args[idx + 1];
}

function emitterConfig(args: string[]): AnchoringConfig {
	const keyFile = flagValue(args, "--key-file");
	const retriesRaw = flagValue(args, "--publish-retries");
	const retries = retriesRaw !== undefined ? Number.parseInt(retriesRaw, 10) : undefined;
	if (retriesRaw !== undefined && (!Number.isSafeInteger(retries) || (retries as number) < 1)) {
		// Silently ignoring a bad value would fall back to the default and
		// mask the operator's intent — fail loudly instead.
		throw new Error(`Invalid --publish-retries: ${retriesRaw} (integer >= 1 required)`);
	}
	return {
		signer: { type: "pem", ...(keyFile !== undefined ? { file: keyFile } : {}) },
		sinks: sinksFromArgs(args),
		...(retries !== undefined ? { publishRetries: retries } : {}),
	};
}

// ── doctor ──

/** A sink the doctor cannot probe without writing to someone else's store. */
function notProbed(sink: string, detail: string): DoctorReport {
	return { sink, checks: [{ name: "probe", status: "info", detail }], failed: false };
}

async function doctorReports(args: string[]): Promise<DoctorReport[]> {
	const sinks = sinksFromArgs(args);
	if (sinks.length === 0) {
		throw new Error(
			"anchor doctor: no sink configured — pass --sink-file, --sink-s3, --sink-url or --sink-rekor",
		);
	}
	const reports: DoctorReport[] = [];
	for (const sink of sinks) {
		switch (sink.type) {
			case "file":
				reports.push(doctorFileSink(sink.path));
				break;
			case "s3":
				reports.push(
					await doctorS3Sink({
						bucket: sink.bucket,
						region: sink.region,
						...(sink.prefix !== undefined ? { prefix: sink.prefix } : {}),
						...(sink.endpoint !== undefined ? { endpoint: sink.endpoint } : {}),
					}),
				);
				break;
			case "https":
				reports.push(
					notProbed(
						`https:${sink.url}`,
						"not probed: an ingest endpoint is append-only for this credential by " +
							"construction — probe the store BEHIND it with its own credentials",
					),
				);
				break;
			case "rekor":
				reports.push(
					notProbed(
						`rekor:${sink.url ?? DEFAULT_REKOR_URL}`,
						"not probed: a transparency log is append-only by construction — its " +
							"inclusion receipts under audit/anchors/rekor/ are the evidence",
					),
				);
				break;
			case "command":
				reports.push(
					notProbed(
						`command:${sink.argv[0] ?? ""}`,
						"not probed: the store behind a command " +
							"sink is opaque from here — probe it with its own tooling",
					),
				);
				break;
		}
	}
	return reports;
}

function printDoctor(reports: DoctorReport[]): void {
	const paint = { pass: pc.green, fail: pc.red, info: pc.yellow } as const;
	console.log(pc.bold("anchor doctor — permission probe (NOT proof of immutability)"));
	for (const report of reports) {
		console.log("");
		console.log(report.sink);
		for (const check of report.checks) {
			console.log(
				`  ${paint[check.status](check.status.toUpperCase())} ${check.name}: ${check.detail}`,
			);
		}
	}
	console.log("");
	console.log("Each verdict describes what these credentials could do at this location right now.");
	console.log("Durable immutability comes from the store's own configuration (S3 Object Lock");
	console.log("retention, POSIX directory permissions, an appliance's WORM mode).");
}

// ── export-bundle ──

interface BundleResult {
	/** The one line stdout gets, or null when nothing may be emitted (delta D9). */
	bundle: string | null;
	errors: string[];
}

/**
 * Build the auditor bundle `{v:1, records, rekorReceipts}` consumed by
 * `usertrust verify --bundle`.
 *
 * Fail-closed by construction (delta D9): a bundle is what an auditor receives
 * INSTEAD of the vault, so a partial one — records present, a receipt quietly
 * dropped because its file did not parse — is worse than no bundle at all. Every
 * failure path returns `bundle: null`, and callers print diagnostics to stderr
 * so stdout is either one complete bundle or empty.
 */
function buildBundle(root: string, args: string[]): BundleResult {
	const errors: string[] = [];
	try {
		const sinceRaw = flagValue(args, "--since") ?? "0";
		if (!/^(0|[1-9][0-9]*)$/.test(sinceRaw)) {
			return { bundle: null, errors: [`export-bundle: --since must be an integer >= 0`] };
		}
		const since = Number.parseInt(sinceRaw, 10);

		const mirrorPath = join(anchorsDir(root), "anchors.jsonl");
		if (!existsSync(mirrorPath)) {
			return { bundle: null, errors: ["export-bundle: no anchor mirror found"] };
		}
		const mirror = parseAnchorsContent(readFileSync(mirrorPath, "utf-8"));
		for (const err of mirror.errors) errors.push(`export-bundle: mirror: ${err}`);

		const records = mirror.records
			.filter((r) => r.anchorSeq > since)
			.sort((a, b) => a.anchorSeq - b.anchorSeq);
		const receipts = readReceipts(root, errors)
			.filter((r) => r.anchorSeq > since)
			.sort((a, b) => a.anchorSeq - b.anchorSeq);
		for (const [what, count] of [
			["records", records.length],
			["rekorReceipts", receipts.length],
		] as const) {
			if (count > MAX_BUNDLE_ITEMS) {
				errors.push(
					`export-bundle: ${count} ${what} exceeds the ${MAX_BUNDLE_ITEMS} cap the verifier ` +
						"accepts — export in slices with --since",
				);
			}
		}
		if (errors.length > 0) return { bundle: null, errors };
		return { bundle: JSON.stringify({ v: 1, records, rekorReceipts: receipts }), errors };
	} catch (err) {
		errors.push(`export-bundle: ${err instanceof Error ? err.message : String(err)}`);
		return { bundle: null, errors };
	}
}

/** Every receipt the Rekor sink persisted; unparseable ones become errors, never gaps. */
function readReceipts(root: string, errors: string[]): RekorReceipt[] {
	const dir = join(anchorsDir(root), "rekor");
	if (!existsSync(dir)) return [];
	const receipts: RekorReceipt[] = [];
	for (const name of readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, name), "utf-8");
		} catch (err) {
			errors.push(
				`export-bundle: ${name}: unreadable (${err instanceof Error ? err.message : String(err)})`,
			);
			continue;
		}
		const { receipt, error } = parseRekorReceipt(raw);
		if (receipt === null) {
			errors.push(`export-bundle: ${name}: ${error}`);
			continue;
		}
		receipts.push(receipt);
	}
	return receipts;
}

export async function run(args: string[] = [], opts?: CliOptions): Promise<void> {
	const json = opts?.json === true;
	const root = process.cwd();
	const action = args[0];

	try {
		switch (action) {
			case "init": {
				const keyFile = flagValue(args, "--key-file");
				const {
					identity,
					publicKeyPem,
					keyFile: writtenKeyFile,
				} = initAnchorIdentity(root, keyFile !== undefined ? { keyFile } : undefined);
				if (json) {
					console.log(
						JSON.stringify({
							command: "anchor init",
							success: true,
							data: { vaultId: identity.vaultId, keyId: identity.keyId, keyFile: writtenKeyFile },
						}),
					);
					return;
				}
				console.log(pc.green("Anchor identity created."));
				console.log(`  vaultId: ${identity.vaultId}`);
				console.log(`  keyId:   ${identity.keyId}`);
				console.log(`  private key: ${writtenKeyFile} (mode 0600 — NEVER inside the vault)`);
				console.log("");
				console.log("Public key (PEM) — PIN THIS OUT-OF-BAND:");
				console.log(publicKeyPem.trim());
				console.log("");
				console.log(pc.bold("Next steps:"));
				console.log("  1. Give the PEM + keyId to whoever will audit this vault (their records,");
				console.log(
					"     not the vault). Verification: usertrust-verify <vault> --anchor <file> --pubkey pub.pem",
				);
				console.log("  2. Configure an APPEND-ONLY store and publish anchors to it:");
				console.log("     usertrust anchor now --sink-file /mnt/worm/anchors.jsonl");
				console.log("     Deployment invariant: the identity that writes the vault has");
				console.log("     append-only (no delete/overwrite) access to the store.");
				return;
			}
			case "now": {
				const emitter = createAnchorEmitter(root, emitterConfig(args));
				const result = await emitter.anchorNow();
				await emitter.stop();
				const status = emitter.status();
				if (json) {
					// Delivery-gated: emitted-but-undelivered (all sinks failed,
					// outbox retained) is a FAILURE in the mode cron/CI consumes —
					// mirror the non-JSON contract exactly (spec §5.3).
					const delivered = status.outboxDepth === 0;
					console.log(
						JSON.stringify({
							command: "anchor now",
							success: result.emitted && delivered,
							data: { ...result, outboxDepth: status.outboxDepth, delivered },
						}),
					);
					if (
						(!result.emitted && result.reason !== "no-new-events") ||
						(result.emitted && !delivered)
					) {
						process.exitCode = 1;
					}
					return;
				}
				if (result.emitted && result.record) {
					console.log(
						pc.green(
							`Anchored: #${result.record.anchorSeq} treeSize ${result.record.treeSize} root ${result.record.merkleRoot.slice(0, 16)}…`,
						),
					);
					if (status.outboxDepth > 0) {
						console.log(
							pc.yellow(`Outbox: ${status.outboxDepth} record(s) not yet acknowledged by sinks.`),
						);
						process.exitCode = 1;
					}
				} else if (result.reason === "no-new-events") {
					console.log("Nothing to anchor (no new events since the last anchor).");
				} else {
					console.log(pc.red(`Anchor skipped: ${result.reason}`));
					process.exitCode = 1;
				}
				return;
			}
			case "status": {
				const identity = readAnchorIdentity(root);
				if (identity === null) {
					console.log(
						json
							? JSON.stringify({
									command: "anchor status",
									success: false,
									data: { message: "no anchor identity" },
								})
							: "No anchor identity. Run `usertrust anchor init` first.",
					);
					process.exitCode = 1;
					return;
				}
				const mirrorPath = join(anchorsDir(root), "anchors.jsonl");
				const mirror = existsSync(mirrorPath)
					? parseAnchorsContent(readFileSync(mirrorPath, "utf-8"))
					: { records: [], errors: [] };
				const tail = mirror.records.sort((a, b) => a.anchorSeq - b.anchorSeq).at(-1) ?? null;
				const metaPath = join(root, VAULT_DIR, "audit", "events.jsonl.meta");
				let headSeq = 0;
				try {
					headSeq = (JSON.parse(readFileSync(metaPath, "utf-8")) as { sequence: number }).sequence;
				} catch {
					/* legacy / empty vault */
				}
				const tailEvents = Math.max(0, headSeq - (tail?.treeSize ?? 0));
				const outboxDir = join(anchorsDir(root), "outbox");
				let outboxDepth = 0;
				try {
					outboxDepth = existsSync(outboxDir)
						? (await import("node:fs")).readdirSync(outboxDir).filter((f) => f.endsWith(".json"))
								.length
						: 0;
				} catch {
					/* ignore */
				}
				if (json) {
					console.log(
						JSON.stringify({
							command: "anchor status",
							success: true,
							data: {
								vaultId: identity.vaultId,
								keyId: identity.keyId,
								lastAnchor: tail,
								eventsSinceLastAnchor: tailEvents,
								outboxDepth,
								mirrorErrors: mirror.errors,
							},
						}),
					);
					return;
				}
				console.log(`vaultId: ${identity.vaultId}`);
				console.log(`keyId:   ${identity.keyId}`);
				if (tail) {
					console.log(
						`Last anchor: #${tail.anchorSeq} treeSize ${tail.treeSize} (${tail.timestamp})`,
					);
				} else {
					console.log("Last anchor: none");
				}
				console.log(`Unanchored tail: ${tailEvents} event(s)`);
				console.log(`Outbox: ${outboxDepth} pending`);
				if (mirror.errors.length > 0) {
					console.log(pc.red(`Mirror parse errors: ${mirror.errors.length}`));
					process.exitCode = 1;
				}
				return;
			}
			case "export": {
				const since = Number.parseInt(flagValue(args, "--since") ?? "0", 10);
				const mirrorPath = join(anchorsDir(root), "anchors.jsonl");
				if (!existsSync(mirrorPath)) {
					console.error("No anchor mirror found.");
					process.exitCode = 1;
					return;
				}
				const { records, errors } = parseAnchorsContent(readFileSync(mirrorPath, "utf-8"));
				for (const err of errors) {
					console.error(`# ${err}`);
				}
				for (const r of records.filter((r) => r.anchorSeq > since)) {
					// Records were persisted canonically; re-serialize the parsed
					// object canonically for byte-stable output.
					console.log(JSON.stringify(r));
				}
				if (errors.length > 0) process.exitCode = 1;
				return;
			}
			case "export-bundle": {
				const { bundle, errors } = buildBundle(root, args);
				if (bundle === null) {
					for (const err of errors) {
						console.error(err);
					}
					console.error("export-bundle: refusing to emit a partial bundle");
					process.exitCode = 1;
					return;
				}
				// Deliberately NOT wrapped in the {command, success, data} envelope
				// under --json: a bundle is an interchange artifact fed straight to
				// `usertrust verify --bundle -`, not a status report.
				console.log(bundle);
				return;
			}
			case "doctor": {
				const reports = await doctorReports(args);
				const failed = reports.some((r) => r.failed);
				if (json) {
					console.log(
						JSON.stringify({
							command: "anchor doctor",
							success: !failed,
							data: { failed, reports },
						}),
					);
				} else {
					printDoctor(reports);
				}
				if (failed) process.exitCode = 1;
				return;
			}
			case "rotate": {
				const identity = readAnchorIdentity(root);
				if (identity === null) {
					console.log("No anchor identity. Run `usertrust anchor init` first.");
					process.exitCode = 1;
					return;
				}
				const successor = mintSuccessorKey(identity.vaultId);
				const emitter = createAnchorEmitter(root, emitterConfig(args));
				const result = await emitter.rotate({
					keyId: successor.keyId,
					publicKeySpki: successor.publicKeySpki,
				});
				await emitter.stop();
				const rotateStatus = emitter.status();
				if (!result.emitted) {
					if (json) {
						console.log(
							JSON.stringify({
								command: "anchor rotate",
								success: false,
								data: { reason: result.reason },
							}),
						);
					} else {
						console.log(pc.red(`Rotation not emitted: ${result.reason}`));
					}
					process.exitCode = 1;
					return;
				}
				// The cross-signed record is already fsync'd into the local mirror,
				// so identity.json MUST advance in lockstep — rolling it back would
				// desync mirror vs identity. Undelivered-to-sink is surfaced loudly
				// (exit 1 + recovery path) instead.
				recordRotatedIdentity(root, {
					keyId: successor.keyId,
					publicKeySpki: successor.publicKeySpki,
				});
				const rotateDelivered = rotateStatus.outboxDepth === 0;
				if (json) {
					console.log(
						JSON.stringify({
							command: "anchor rotate",
							success: rotateDelivered,
							data: {
								newKeyId: successor.keyId,
								keyFile: successor.keyFile,
								outboxDepth: rotateStatus.outboxDepth,
								delivered: rotateDelivered,
							},
						}),
					);
					if (!rotateDelivered) process.exitCode = 1;
					return;
				}
				console.log(pc.green(`Rotation anchored (#${result.record?.anchorSeq}).`));
				console.log(`  new keyId: ${successor.keyId}`);
				console.log(`  new private key: ${successor.keyFile}`);
				console.log("");
				console.log("New public key (PEM) — distribute the fingerprint OUT-OF-BAND:");
				console.log(successor.publicKeyPem.trim());
				console.log("");
				console.log(pc.bold("IMPORTANT:"));
				console.log("  - Point USERTRUST_ANCHOR_KEY (or --key-file) at the NEW private key.");
				console.log("  - Auditors keep pinning the ORIGINAL root key; give them this new");
				console.log("    fingerprint as a --successor-pin so a hijacked rotation cannot pass.");
				if (!rotateDelivered) {
					console.log("");
					console.log(
						pc.yellow(
							`WARNING: the rotation record was NOT delivered to any sink (outbox: ${rotateStatus.outboxDepth} pending).`,
						),
					);
					console.log(
						pc.yellow(
							"  The store lacks the trust-chain handoff — anchors signed by the new key will not verify until it ships.",
						),
					);
					console.log(
						pc.yellow(
							`  Ship it: usertrust anchor export --since ${(result.record?.anchorSeq ?? 1) - 1}  (then re-run with a reachable sink)`,
						),
					);
					process.exitCode = 1;
				}
				return;
			}
			case "resume": {
				const latest = flagValue(args, "--latest");
				if (latest === undefined) {
					console.log("Usage: usertrust anchor resume --latest <record.json|->");
					process.exitCode = 1;
					return;
				}
				const raw = latest === "-" ? readFileSync(0, "utf-8") : readFileSync(latest, "utf-8");
				const record = resumeAnchorMirror(root, raw);
				console.log(
					json
						? JSON.stringify({
								command: "anchor resume",
								success: true,
								data: { anchorSeq: record.anchorSeq },
							})
						: pc.green(`Mirror re-seeded at anchorSeq ${record.anchorSeq}.`),
				);
				return;
			}
			default: {
				console.log(`Usage: usertrust anchor <init|now|status|export|export-bundle|doctor|rotate|resume>

  init          [--key-file <path>]     Mint identity + Ed25519 key (outside the vault)
  now           [sink flags]            Snapshot, sign, mirror, publish
  status                                Last anchor, unanchored tail, outbox
  export        [--since <anchorSeq>]   Print mirror records (pull-mode shipping)
  export-bundle [--since <anchorSeq>]   Records + Rekor receipts for \`verify --bundle\`
  doctor        [sink flags]            What can this identity delete/overwrite in the store?
  rotate        [--key-file <path>]     Cross-signed key rotation
  resume        --latest <record|->     Re-seed a lost mirror from the store

Sink flags:
  --sink-file <path>                    Append-only file store
  --sink-url <url>                      Ingest endpoint (POST per record)
  --sink-s3 bucket=B,region=R[,prefix=P][,endpoint=E]
  --sink-rekor[=<url>]                  Rekor transparency log (default ${DEFAULT_REKOR_URL})`);
				if (action !== undefined) process.exitCode = 1;
				return;
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (json) {
			console.log(
				JSON.stringify({ command: `anchor ${action ?? ""}`, success: false, data: { message } }),
			);
		} else {
			console.log(pc.red(message));
		}
		process.exitCode = 1;
	}
}
