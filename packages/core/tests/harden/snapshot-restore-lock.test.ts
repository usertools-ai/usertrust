// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSnapshot, restoreSnapshot } from "../../src/snapshot/checkpoint.js";

test("restore refuses while another live process holds the audit-writer lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "ut-lock-"));
	const vaultPath = join(root, ".usertrust");
	const auditDir = join(vaultPath, "audit");
	await mkdir(auditDir, { recursive: true });
	await writeFile(join(auditDir, "events.jsonl"), "");
	await writeFile(join(vaultPath, "spend-ledger.json"), JSON.stringify({ budgetSpent: 0 }));
	await createSnapshot(vaultPath, "cp");

	// A real, still-running process whose PID is alive.
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
	await new Promise((r) => setTimeout(r, 50));
	await writeFile(
		join(auditDir, ".audit-writer.lock"),
		JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
	);
	try {
		await expect(restoreSnapshot(vaultPath, "cp")).rejects.toThrow(/lock/i);
	} finally {
		child.kill();
	}
});
