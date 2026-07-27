// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust anchor — external audit anchoring
 *
 * init    Mint the vault's anchor identity (Ed25519 key OUTSIDE the vault)
 * now     One snapshot → sign → mirror → publish cycle
 * status  Last anchor, unanchored tail, outbox depth
 * export  Print mirror records (JSONL) for pull-mode shipping
 * rotate  Cross-signed key rotation (spec §6)
 * resume  Re-seed a lost mirror from the store's newest record
 *
 * Spec: docs/superpowers/specs/2026-07-26-external-anchoring-design.md
 */

import { existsSync, readFileSync } from "node:fs";
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
import { parseAnchorsContent } from "../audit/anchor-verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

function sinksFromArgs(args: string[]): SinkConfig[] {
	const sinks: SinkConfig[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--sink-file" && args[i + 1] !== undefined) {
			sinks.push({ type: "file", path: args[i + 1] as string });
			i++;
		} else if (args[i] === "--sink-url" && args[i + 1] !== undefined) {
			sinks.push({ type: "https", url: args[i + 1] as string });
			i++;
		}
	}
	return sinks;
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
				console.log(`Usage: usertrust anchor <init|now|status|export|rotate|resume>

  init   [--key-file <path>]                 Mint identity + Ed25519 key (outside the vault)
  now    [--sink-file <p>] [--sink-url <u>]  Snapshot, sign, mirror, publish
  status                                     Last anchor, unanchored tail, outbox
  export [--since <anchorSeq>]               Print mirror records (pull-mode shipping)
  rotate [--key-file <path>]                 Cross-signed key rotation
  resume --latest <record.json|->            Re-seed a lost mirror from the store`);
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
