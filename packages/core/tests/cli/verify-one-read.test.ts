// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ONE READ PER VERDICT. `usertrust verify` and `usertrust health` judge the caller's receipts, the
 * dead letters and the anchors' coverage against the events their integrity walk read, never against
 * the log read again. Each row here changes the log at a seam the verdict must not see: right after
 * the verified read returns (receipts and dead letters), right after the walk inside the anchored
 * verification (the anchors' hashes), or right before the walk (health, whose earlier read feeds its
 * other signals). Read twice, each of these was a verdict about two different logs: a false clean.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run as healthRun } from "../../src/cli/health.js";
import { run as verifyRun } from "../../src/cli/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
} from "../harden/anchoring/fixtures.js";

/** Where a row changes the log: each hook runs at most once per verdict, and counts that it ran. */
const seam = vi.hoisted(() => ({
	afterVerify: undefined as (() => void) | undefined,
	beforeVerify: undefined as (() => void) | undefined,
	beforeMirror: undefined as (() => void) | undefined,
	fired: 0,
}));

function fire(hook: (() => void) | undefined): void {
	if (hook === undefined) return;
	seam.fired++;
	hook();
}

// Every verdict function the CLIs call, wrapped where they call it (calls inside the module are not:
// the anchored verification's own walk runs unwrapped, and its seam is the anchor mirror's read).
vi.mock("../../src/audit/verify.js", async (importOriginal) => {
	const orig = await importOriginal<Record<string, unknown>>();
	const wrapped: Record<string, unknown> = { ...orig };
	for (const name of [
		"verifyVault",
		"verifyVaultReading",
		"verifyVaultWithAnchors",
		"verifyVaultWithAnchorsReading",
	]) {
		const fn = orig[name];
		if (typeof fn !== "function") continue;
		wrapped[name] = (...args: unknown[]) => {
			fire(seam.beforeVerify);
			const out = (fn as (...a: unknown[]) => unknown)(...args);
			fire(seam.afterVerify);
			return out;
		};
	}
	return wrapped;
});

// The anchored verification reads the vault's anchor mirror after its walk and before it evaluates
// the anchors: a log swapped here is one the walk never saw.
vi.mock("../../src/audit/anchor-verify.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../src/audit/anchor-verify.js")>();
	return {
		...orig,
		readAnchorMirror: (vaultPath: string) => {
			fire(seam.beforeMirror);
			return orig.readAnchorMirror(vaultPath);
		},
	};
});

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-verify-one-read-"));
	mkdirSync(join(tempDir, VAULT_DIR, "audit"), { recursive: true });
	out = [];
	// A verdict that succeeds never sets the exit code: start each row from 0, whatever ran before it.
	process.exitCode = 0;
	seam.afterVerify = undefined;
	seam.beforeVerify = undefined;
	seam.beforeMirror = undefined;
	seam.fired = 0;
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		out.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
	rmSync(tempDir, { recursive: true, force: true });
	cleanupAll();
});

const auditDir = (root = tempDir) => join(root, VAULT_DIR, "audit");
const logPath = (root = tempDir) => join(auditDir(root), "events.jsonl");
const metaPath = (root = tempDir) => `${logPath(root)}.meta`;
const json = () =>
	JSON.parse(out.join("\n")) as { success: boolean; data: Record<string, unknown> };

/** A log and its anchor, as bytes: one version of the vault's chain. */
interface ChainFiles {
	log: Buffer;
	meta: Buffer;
}
const capture = (root = tempDir): ChainFiles => ({
	log: readFileSync(logPath(root)),
	meta: readFileSync(metaPath(root)),
});
const put = (files: ChainFiles, root = tempDir): void => {
	writeFileSync(logPath(root), files.log);
	writeFileSync(metaPath(root), files.meta);
};

/** A line shaped like an `llm_call` for `transferId`, whose hash was never computed from it. */
function unverifiedLlmCall(transferId: string, hash: string): string {
	return `${JSON.stringify({
		id: `forged-${transferId}`,
		timestamp: new Date().toISOString(),
		previousHash: GENESIS_HASH,
		kind: "llm_call",
		actor: "local",
		data: { transferId },
		hash,
		sequence: 1,
	})}\n`;
}

/**
 * Three events, tx_1 to tx_3, where tx_2's `.meta` update failed after its bytes were synced: tx_2
 * is dead-lettered WITH its hash, and its event is on this chain. Returns the full chain (L1) and its
 * one-event prefix with that prefix's own anchor (L0): a valid chain on which tx_2's event is not.
 */
async function chainWithDeadLetterOnIt(): Promise<{ full: ChainFiles; prefix: ChainFiles }> {
	const a = createAuditWriter(tempDir);
	try {
		const e1 = await a.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_1" },
		});
		const prefix: ChainFiles = {
			log: readFileSync(logPath()),
			meta: Buffer.from(JSON.stringify({ lastHash: e1.hash, sequence: 1 })),
		};
		rmSync(metaPath());
		mkdirSync(metaPath());
		await expect(
			a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_2" } }),
		).rejects.toThrow();
		rmSync(metaPath(), { recursive: true });
		await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_3" } });
		return { full: capture(), prefix };
	} finally {
		a.release();
	}
}

describe("verify: the receipts are checked against the events the walk read", () => {
	it("an llm_call line written right after the walk audits no receipt: plain mode, exit 1", async () => {
		// An empty chain is walked (valid, 0 events); then two lines naming the receipts' transfers
		// appear, one with the hash a receipt names. Neither was hash-checked by this verdict.
		const hash = "a".repeat(64);
		seam.afterVerify = () => {
			writeFileSync(
				logPath(),
				unverifiedLlmCall("tx_9", hash) + unverifiedLlmCall("tx_8", "b".repeat(64)),
			);
		};
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_9", auditHash: hash },
				{ transferId: "tx_8", auditHash: "AUDIT_DEGRADED" },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.chainLength).toBe(0);
		expect(r.data.receipts).toEqual({
			checked: 2,
			unreadable: 0,
			unaudited: [
				{ transferId: "tx_9", reason: "its auditHash is not on the chain" },
				{
					transferId: "tx_8",
					reason: "its audit write degraded, and its llm_call event is not on the chain",
				},
			],
		});
		expect(r.data.complete).toBe(false);
		expect(r.success).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("the same in anchor mode: the receipts are checked against the anchored verdict's own walk", async () => {
		const hash = "a".repeat(64);
		seam.afterVerify = () => {
			writeFileSync(logPath(), unverifiedLlmCall("tx_9", hash));
		};
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, JSON.stringify({ transferId: "tx_9", auditHash: hash }));
		const anchors = join(tempDir, "anchors.jsonl");
		writeFileSync(anchors, "");
		await verifyRun(tempDir, { json: true }, ["--anchor", anchors, "--receipts", file]);
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.receipts).toEqual({
			checked: 1,
			unreadable: 0,
			unaudited: [{ transferId: "tx_9", reason: "its auditHash is not on the chain" }],
		});
		expect(r.success).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("verify: the dead letters are matched against the events the walk read", () => {
	it("a dead letter whose event is put back on the log right after the walk is still MISSING", async () => {
		const { full, prefix } = await chainWithDeadLetterOnIt();
		put(prefix);
		seam.afterVerify = () => put(full);
		await verifyRun(tempDir, { json: true });
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.valid).toBe(true);
		expect(r.data.chainLength).toBe(1);
		expect(r.data.deadLetters).toMatchObject({
			missing: 1,
			onChain: 0,
			missingTransferIds: ["tx_2"],
		});
		expect(r.data.complete).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("the same in anchor mode", async () => {
		const { full, prefix } = await chainWithDeadLetterOnIt();
		put(prefix);
		seam.afterVerify = () => put(full);
		const anchors = join(tempDir, "anchors.jsonl");
		writeFileSync(anchors, "");
		await verifyRun(tempDir, { json: true }, ["--anchor", anchors]);
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.chainLength).toBe(1);
		expect(r.data.deadLetters).toMatchObject({ missing: 1, onChain: 0 });
		expect(process.exitCode).toBe(1);
	});

	it("CONTROL: the full chain, unchanged, holds the dead-lettered event: complete, exit 0", async () => {
		await chainWithDeadLetterOnIt();
		await verifyRun(tempDir, { json: true });
		const r = json();
		expect(r.data.valid).toBe(true);
		expect(r.data.chainLength).toBe(3);
		expect(r.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
		expect(r.success).toBe(true);
		expect(process.exitCode).toBe(0);
	});
});

describe("verify: the anchors are checked against the hashes of the events walked", () => {
	/** An anchored vault (3 events, one signed anchor in an external store) and a pinned key file. */
	async function anchored() {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const pubkey = join(s.storeDir, "root.pub.pem");
		writeFileSync(pubkey, s.rootPem);
		return { s, args: ["--anchor", s.storeFile, "--pubkey", pubkey] };
	}

	it("a chain no anchor covers is not certified by the anchored chain swapped back in after its walk", async () => {
		const { s, args } = await anchored();
		const genuine = capture(s.root);
		// Another chain of three events: internally valid, with its own anchor, and covered by no
		// signed anchor. It is what the walk reads; the genuine chain returns before the anchors are
		// evaluated.
		const other = mkdtempSync(join(tmpdir(), "trust-verify-other-"));
		try {
			await appendEvents(other, 3);
			put(capture(other), s.root);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
		seam.beforeMirror = () => put(genuine, s.root);
		await verifyRun(s.root, { json: true }, args);
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.anchorState).not.toBe("ANCHORED_VERIFIED");
		expect(r.data.valid).toBe(false);
		expect(r.success).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("CONTROL: the genuine chain, unchanged, is ANCHORED_VERIFIED and exits 0", async () => {
		const { s, args } = await anchored();
		await verifyRun(s.root, { json: true }, args);
		const r = json();
		expect(r.data.anchorState).toBe("ANCHORED_VERIFIED");
		expect(r.data.valid).toBe(true);
		expect(process.exitCode).toBe(0);
	});
});

describe("health: the dead letters are matched against the chain its integrity line verified", () => {
	async function healthJson(): Promise<Record<string, unknown>> {
		const cwd = process.cwd();
		process.chdir(tempDir);
		try {
			await healthRun(undefined, { json: true });
		} finally {
			process.chdir(cwd);
		}
		return json().data.signals as Record<string, unknown>;
	}

	it("a chain swapped for its prefix after health's first read, before its walk: the event is MISSING", async () => {
		const { prefix } = await chainWithDeadLetterOnIt();
		seam.beforeVerify = () => put(prefix);
		const signals = await healthJson();
		expect(seam.fired).toBe(1);
		expect(signals.missingEvents).toBe(1);
		expect(signals.chainIntegrity).toBe(false);
	});

	it("CONTROL: the full chain, unchanged: verified, missingEvents 0", async () => {
		await chainWithDeadLetterOnIt();
		const signals = await healthJson();
		expect(signals.missingEvents).toBe(0);
		expect(signals.chainIntegrity).toBe(true);
	});
});
