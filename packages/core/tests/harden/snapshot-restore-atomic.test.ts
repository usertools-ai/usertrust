// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { restoreSnapshot } from "../../src/snapshot/checkpoint.js";

test("a failing restore leaves existing files untouched and no temp files behind", async () => {
	const root = await mkdtemp(join(tmpdir(), "ut-atom-"));
	const vaultPath = join(root, ".usertrust");
	await mkdir(vaultPath, { recursive: true });
	await writeFile(join(vaultPath, "usertrust.config.json"), '{"version":1}');

	// Hand-craft a snapshot whose entries include a valid file then a traversal.
	const snapDir = join(vaultPath, "snapshots");
	await mkdir(snapDir, { recursive: true });
	const payload = {
		meta: { name: "bad", timestamp: "t", files: [], size: 0 },
		entries: {
			"usertrust.config.json": Buffer.from('{"version":99}').toString("base64"),
			"../escape.txt": Buffer.from("pwned").toString("base64"),
		},
	};
	await writeFile(join(snapDir, "bad.json"), JSON.stringify(payload));

	await expect(restoreSnapshot(vaultPath, "bad")).rejects.toThrow(/traversal/i);

	// Original untouched (NOT rewritten to version 99), no leftover temp, no escape file.
	const cfg = await readFile(join(vaultPath, "usertrust.config.json"), "utf-8");
	expect(cfg).toBe('{"version":1}');
	expect(existsSync(join(vaultPath, "usertrust.config.json.restore-tmp"))).toBe(false);
	expect(existsSync(join(root, "escape.txt"))).toBe(false);
});
