// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { createSnapshot, restoreSnapshot } from "../../src/snapshot/checkpoint.js";

test("restore rolls back audit and spend-ledger together (no money<->audit desync)", async () => {
	const root = await mkdtemp(join(tmpdir(), "ut-snap-"));
	// vaultPath the CLI uses is <root>/.usertrust; audit writer's vaultBase is <root>.
	const vaultPath = join(root, ".usertrust");
	await mkdir(vaultPath, { recursive: true });

	const audit = createAuditWriter(root); // writes <root>/.usertrust/audit/events.jsonl(+.meta)
	await audit.appendEvent({ kind: "spend", actor: "a", data: { n: 1 } });
	await audit.appendEvent({ kind: "spend", actor: "a", data: { n: 2 } });
	await writeFile(
		join(vaultPath, "spend-ledger.json"),
		JSON.stringify({ budgetSpent: 100, updatedAt: "t" }),
	);
	audit.release(); // drop the lock so snapshot/restore can take it

	const snap = await createSnapshot(vaultPath, "cp");
	expect(snap.files).toContain("spend-ledger.json");
	expect(snap.budgetSpent).toBe(100);

	// Post-snapshot money + audit movement.
	const audit2 = createAuditWriter(root);
	await audit2.appendEvent({ kind: "spend", actor: "a", data: { n: 3 } });
	await writeFile(
		join(vaultPath, "spend-ledger.json"),
		JSON.stringify({ budgetSpent: 300, updatedAt: "t2" }),
	);
	audit2.release();

	await restoreSnapshot(vaultPath, "cp"); // no tigerbeetle/ dir → guard 2 not triggered

	const ledger = JSON.parse(await readFile(join(vaultPath, "spend-ledger.json"), "utf-8"));
	const metaTail = JSON.parse(
		await readFile(join(vaultPath, "audit", "events.jsonl.meta"), "utf-8"),
	);
	// Money mirror and audit head must both be back at the snapshot instant.
	expect(ledger.budgetSpent).toBe(100);
	expect(metaTail.sequence).toBe(2);
});

test("restore refuses when audit rolls back but snapshot lacks spend-ledger", async () => {
	const root = await mkdtemp(join(tmpdir(), "ut-nodesync-"));
	const vaultPath = join(root, ".usertrust");
	await mkdir(join(vaultPath, "audit"), { recursive: true });
	await writeFile(join(vaultPath, "audit", "events.jsonl"), "");
	await writeFile(
		join(vaultPath, "audit", "events.jsonl.meta"),
		JSON.stringify({ lastHash: "x", sequence: 1 }),
	);

	// Snapshot captures audit but there is NO spend-ledger.json → guard 1 must fire on restore.
	await createSnapshot(vaultPath, "cp");
	await expect(restoreSnapshot(vaultPath, "cp")).rejects.toThrow(/spend-ledger|desync/i);
});

test("restore refuses audit rollback while a live TigerBeetle store is present", async () => {
	const root = await mkdtemp(join(tmpdir(), "ut-tb-"));
	const vaultPath = join(root, ".usertrust");
	await mkdir(join(vaultPath, "audit"), { recursive: true });
	await writeFile(join(vaultPath, "audit", "events.jsonl"), "");
	await writeFile(join(vaultPath, "spend-ledger.json"), JSON.stringify({ budgetSpent: 0 }));
	await createSnapshot(vaultPath, "cp");

	// Live TB store present → guard 2 refuses unless --force.
	await mkdir(join(vaultPath, "tigerbeetle"), { recursive: true });
	await writeFile(join(vaultPath, "tigerbeetle", "data.tb"), "binary");

	await expect(restoreSnapshot(vaultPath, "cp")).rejects.toThrow(/TigerBeetle|force/i);
	// With explicit acknowledgment it proceeds.
	await restoreSnapshot(vaultPath, "cp", { forceLedgerDesync: true });
});
