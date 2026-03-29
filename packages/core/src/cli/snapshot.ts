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
	const name = process.argv[4];

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
			const meta = await createSnapshot(vaultPath, name);
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
			await restoreSnapshot(vaultPath, name);
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
