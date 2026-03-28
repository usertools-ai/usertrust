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
import { VAULT_DIR } from "../shared/constants.js";
import { createSnapshot, listSnapshots, restoreSnapshot } from "../snapshot/checkpoint.js";

export async function run(rootDir?: string): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);

	if (!existsSync(vaultPath)) {
		console.log("No governance vault found. Run `usertrust init` first.");
		return;
	}

	const subcommand = rootDir !== undefined ? process.argv[3] : process.argv[3];
	const name = process.argv[4];

	switch (subcommand) {
		case "create": {
			if (!name) {
				console.log("Usage: usertrust snapshot create <name>");
				return;
			}
			const meta = await createSnapshot(vaultPath, name);
			console.log(`Snapshot created: ${meta.name}`);
			console.log(`  Files: ${meta.files.length}`);
			console.log(`  Size: ${meta.size} bytes`);
			console.log(`  Timestamp: ${meta.timestamp}`);
			break;
		}

		case "restore": {
			if (!name) {
				console.log("Usage: usertrust snapshot restore <name>");
				return;
			}
			await restoreSnapshot(vaultPath, name);
			console.log(`Snapshot restored: ${name}`);
			break;
		}

		case "list": {
			const snapshots = await listSnapshots(vaultPath);
			if (snapshots.length === 0) {
				console.log("No snapshots found.");
				return;
			}
			console.log("Snapshots:");
			for (const s of snapshots) {
				console.log(`  ${s.name}  (${s.files.length} files, ${s.size} bytes, ${s.timestamp})`);
			}
			break;
		}

		default:
			console.log("Usage: usertrust snapshot <create|restore|list> [name]");
			break;
	}
}
