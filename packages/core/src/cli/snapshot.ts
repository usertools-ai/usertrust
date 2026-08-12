// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust snapshot — Create/restore/list vault snapshots
 *
 * Wraps checkpoint.ts for snapshot management:
 *   usertrust snapshot create <name>
 *   usertrust snapshot restore <name>
 *   usertrust snapshot list
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { VAULT_DIR } from "../shared/constants.js";
import { createSnapshot, listSnapshots, restoreSnapshot } from "../snapshot/checkpoint.js";
import type { CliOptions } from "./init.js";

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "snapshot",
					success: false,
					data: { message: "No trust vault found. Run `usertrust init` first." },
				}),
			);
		} else {
			console.log(`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`);
		}
		return;
	}

	const subcommand = process.argv[3];
	// Positional name = first arg after the subcommand that is not a flag.
	const name = process.argv.slice(4).find((a) => !a.startsWith("--"));
	const force = process.argv.includes("--force");

	switch (subcommand) {
		case "create": {
			if (!name) {
				if (json) {
					console.log(
						JSON.stringify({
							command: "snapshot",
							success: false,
							data: { message: "Missing snapshot name" },
						}),
					);
				} else {
					console.log("Usage: usertrust snapshot create <name>");
				}
				return;
			}
			// The enumeration failure this branch newly surfaces arrives as a THROW.
			// Left unguarded it propagated through the top-level CLI, so
			// `snapshot create --json` printed no JSON at all and Node emitted an
			// uncaught stack trace — breaking the every-command JSON contract for
			// exactly the failure path this change exists to expose. A fail-closed
			// error that a machine consumer cannot read is only half-surfaced.
			let meta: Awaited<ReturnType<typeof createSnapshot>>;
			try {
				meta = await createSnapshot(vaultPath, name);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (json) {
					console.log(
						JSON.stringify({
							command: "snapshot",
							success: false,
							data: { action: "create", message },
						}),
					);
				} else {
					console.log(pc.red(`Snapshot failed: ${message}`));
				}
				process.exitCode = 1;
				return;
			}
			if (json) {
				console.log(
					JSON.stringify({
						command: "snapshot",
						success: true,
						data: {
							action: "create",
							name: meta.name,
							files: meta.files.length,
							size: meta.size,
							timestamp: meta.timestamp,
						},
					}),
				);
			} else {
				console.log(pc.green(`Snapshot created: ${meta.name}`));
				console.log(pc.dim(`  Files: ${meta.files.length}`));
				console.log(pc.dim(`  Size: ${meta.size} bytes`));
				console.log(pc.dim(`  Timestamp: ${meta.timestamp}`));
			}
			break;
		}

		case "restore": {
			if (!name) {
				if (json) {
					console.log(
						JSON.stringify({
							command: "snapshot",
							success: false,
							data: { message: "Missing snapshot name" },
						}),
					);
				} else {
					console.log("Usage: usertrust snapshot restore <name>");
				}
				return;
			}
			try {
				await restoreSnapshot(vaultPath, name, { forceLedgerDesync: force });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (json) {
					console.log(
						JSON.stringify({
							command: "snapshot",
							success: false,
							data: { action: "restore", name, error: msg },
						}),
					);
				} else {
					console.log(`${pc.red("Restore refused:")} ${msg}`);
				}
				return;
			}
			if (json) {
				console.log(
					JSON.stringify({
						command: "snapshot",
						success: true,
						data: { action: "restore", name },
					}),
				);
			} else {
				console.log(pc.green(`Snapshot restored: ${name}`));
			}
			break;
		}

		case "list": {
			const snapshots = await listSnapshots(vaultPath);
			if (json) {
				console.log(
					JSON.stringify({
						command: "snapshot",
						success: true,
						data: {
							action: "list",
							snapshots: snapshots.map((s) => ({
								name: s.name,
								files: s.files.length,
								size: s.size,
								timestamp: s.timestamp,
							})),
						},
					}),
				);
			} else if (snapshots.length === 0) {
				console.log(pc.dim("No snapshots found."));
			} else {
				console.log("Snapshots:");
				for (const s of snapshots) {
					console.log(
						`  ${pc.bold(s.name)}  ${pc.dim(`(${s.files.length} files, ${s.size} bytes, ${s.timestamp})`)}`,
					);
				}
			}
			break;
		}

		default:
			if (json) {
				console.log(
					JSON.stringify({
						command: "snapshot",
						success: false,
						data: { message: "Unknown subcommand. Use: create, restore, list" },
					}),
				);
			} else {
				console.log("Usage: usertrust snapshot <create|restore|list> [name]");
			}
			break;
	}
}
