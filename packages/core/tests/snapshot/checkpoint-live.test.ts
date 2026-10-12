// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A snapshot of a vault that is being written. The chain's log and its anchor are captured from ONE
 * consistent read: read file by file, an append landing between the two captured an anchor AHEAD of
 * its log, and that snapshot restored into a vault every writer refuses (FEWER_THAN_ANCHOR: events
 * "deleted"). The seam appends one event, log and anchor, right as the snapshot reads the log.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Runs once, at the snapshot's first read of the log, whichever way it reads it. */
const seam = vi.hoisted(() => ({
	logPath: "",
	hook: undefined as (() => void) | undefined,
	/** Reads of the log through `fs/promises`, outside the bracketed snapshot. */
	unbracketedReads: 0,
}));
function fireOnce(): void {
	const hook = seam.hook;
	seam.hook = undefined;
	hook?.();
}
vi.mock("node:fs/promises", async (importOriginal) => {
	const fsp = await importOriginal<typeof import("node:fs/promises")>();
	const readFile = (async (p: unknown, ...rest: unknown[]) => {
		const out = await (fsp.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
		if (String(p) === seam.logPath) {
			seam.unbracketedReads++;
			fireOnce();
		}
		return out;
	}) as typeof fsp.readFile;
	return { ...fsp, readFile, default: { ...fsp, readFile } };
});
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const openSync = ((p: unknown, ...rest: unknown[]) => {
		const fd = (fs.openSync as (...a: unknown[]) => number)(p, ...rest);
		const flags = rest[0];
		const forWriting =
			typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
		if (String(p) === seam.logPath && !forWriting) fireOnce();
		return fd;
	}) as typeof fs.openSync;
	return { ...fs, openSync, default: { ...fs, openSync } };
});

const { canonicalize } = await import("../../src/audit/canonical.js");
const { createAuditWriter } = await import("../../src/audit/chain.js");
const { verifyVault } = await import("../../src/audit/verify.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");
const { createSnapshot, restoreSnapshot } = await import("../../src/snapshot/checkpoint.js");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "snapshot-live-"));
	seam.hook = undefined;
	seam.unbracketedReads = 0;
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const vaultDir = () => join(root, VAULT_DIR);
const logPath = () => join(vaultDir(), "audit", "events.jsonl");

/** What a live writer does: the next event's line, then the anchor that records it. */
function appendNextEvent(): void {
	const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
	const head = JSON.parse(lines[lines.length - 1] as string) as { hash: string; sequence: number };
	const body = {
		id: "appended-while-snapshotting",
		timestamp: "2026-10-12T00:00:00.000Z",
		previousHash: head.hash,
		kind: "llm_call",
		actor: "local",
		data: { transferId: "tx_live" },
		sequence: head.sequence + 1,
	};
	const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
	appendFileSync(logPath(), `${canonicalize({ ...body, hash })}\n`);
	writeFileSync(
		`${logPath()}.meta`,
		JSON.stringify({ lastHash: hash, sequence: head.sequence + 1 }),
	);
}

describe("a snapshot of a vault being written captures one consistent chain", () => {
	it("an append landing while the log is read: the snapshot restores into a vault the writer goes on from", async () => {
		const w = createAuditWriter(root);
		try {
			for (let i = 1; i <= 5; i++) {
				await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_${i}` } });
			}
		} finally {
			w.release();
		}
		// A restore that rolls the chain back must carry the money mirror too.
		writeFileSync(join(vaultDir(), "spend-ledger.json"), JSON.stringify({ budgetSpent: 0 }));
		seam.logPath = logPath();
		seam.hook = appendNextEvent;
		await createSnapshot(vaultDir(), "live");
		expect(seam.hook, "the append landed during the snapshot").toBeUndefined();
		expect(seam.unbracketedReads, "the log is read only by the bracketed snapshot").toBe(0);

		await restoreSnapshot(vaultDir(), "live");
		const after = createAuditWriter(root);
		let appended: unknown;
		try {
			appended = await after
				.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_after" } })
				.then(
					() => "appended",
					(e: unknown) => e,
				);
		} finally {
			after.release();
		}
		expect(appended).toBe("appended");
		expect(verifyVault(vaultDir())).toMatchObject({ valid: true });
	});

	it("CONTROL: a vault at rest snapshots and restores as it is", async () => {
		const w = createAuditWriter(root);
		try {
			for (let i = 1; i <= 3; i++) {
				await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_${i}` } });
			}
		} finally {
			w.release();
		}
		writeFileSync(join(vaultDir(), "spend-ledger.json"), JSON.stringify({ budgetSpent: 0 }));
		const before = readFileSync(logPath());
		await createSnapshot(vaultDir(), "rest");
		await restoreSnapshot(vaultDir(), "rest");
		expect(readFileSync(logPath())).toEqual(before);
		expect(verifyVault(vaultDir())).toMatchObject({ valid: true, chainLength: 3 });
	});
});
