// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ONE READ PER VERDICT. `usertrust verify` and `usertrust health` judge the caller's receipts, the
 * dead letters and the anchors' coverage against the events their integrity walk read, never against
 * the log read again. Each row here changes the log at a seam the verdict must not see: right after
 * the verified read returns (receipts and dead letters), right after the walk inside the anchored
 * verification (the anchors' hashes), right after the standalone's snapshot (`--tx`, and its anchor
 * mirror), or right before the walk (health, whose signals now read that walk's events too). Read
 * twice, each of these was a verdict about two different logs: a false clean. And a vault that keeps
 * changing while it is read has no snapshot: nothing is judged against a chain nobody read.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseAnchorsContent as standaloneParseAnchors,
	verifyTransaction as standaloneVerifyTransaction,
	verifyVaultWithAnchors as standaloneVerifyVaultWithAnchors,
} from "../../../verify/src/index.js";
import { readAnchorIdentity } from "../../src/audit/anchor.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVaultComplete } from "../../src/audit/complete.js";
import { buildMerkleTree } from "../../src/audit/merkle.js";
import { verifyVaultWithAnchors as coreVerifyVaultWithAnchors } from "../../src/audit/verify.js";
import { run as exportRun } from "../../src/cli/export.js";
import { run as healthRun } from "../../src/cli/health.js";
import { run as inspectRun } from "../../src/cli/inspect.js";
import { run as reportRun } from "../../src/cli/report.js";
import { run as verifyRun } from "../../src/cli/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	signRecord,
} from "../harden/anchoring/fixtures.js";

/** Where a row changes the log: each hook runs at most once per verdict, and counts that it ran. */
const seam = vi.hoisted(() => ({
	afterVerify: undefined as (() => void) | undefined,
	beforeVerify: undefined as (() => void) | undefined,
	beforeMirror: undefined as (() => void) | undefined,
	/** After the standalone's snapshot is taken: any read after it sees what this puts back. */
	afterSnapshot: undefined as (() => void) | undefined,
	/** After core's snapshot is taken: the same, for the core verifier's walk. */
	afterCoreSnapshot: undefined as (() => void) | undefined,
	/** The standalone's anchor-mirror reads, and records added to the Nth (a mirror that changed). */
	standaloneMirrorReads: 0,
	mirrorExtra: undefined as ((read: number) => unknown[] | undefined) | undefined,
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

// The anchored verification evaluates the anchors after its walk: a log swapped here is one the walk
// never saw. Its anchor mirror is parsed here too (`parseAnchorMirror`), from the bytes its snapshot
// read; a mirror read again by path (`readAnchorMirror`) would see whatever is there now. Both are
// seams, counted, in both packages (the standalone has its own copy of the module: the parity
// contract), and `mirrorExtra` adds records to the Nth mirror reading of the standalone, as a mirror
// that changed since its verdict read it would.
function wrapMirror<M extends { records: unknown[]; errors: string[] }>(
	read: () => M,
	standalone: boolean,
): M {
	fire(seam.beforeMirror);
	if (!standalone) return read();
	seam.standaloneMirrorReads++;
	const out = read();
	const extra = seam.mirrorExtra?.(seam.standaloneMirrorReads) as M["records"] | undefined;
	return extra === undefined ? out : { ...out, records: [...out.records, ...extra] };
}
vi.mock("../../src/audit/anchor-verify.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../src/audit/anchor-verify.js")>();
	return {
		...orig,
		parseAnchorMirror: (...a: Parameters<typeof orig.parseAnchorMirror>) =>
			wrapMirror(() => orig.parseAnchorMirror(...a), false),
		readAnchorMirror: (...a: Parameters<typeof orig.readAnchorMirror>) =>
			wrapMirror(() => orig.readAnchorMirror(...a), false),
	};
});
vi.mock("../../../verify/src/anchor-verify.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../../verify/src/anchor-verify.js")>();
	return {
		...orig,
		parseAnchorMirror: (...a: Parameters<typeof orig.parseAnchorMirror>) =>
			wrapMirror(() => orig.parseAnchorMirror(...a), true),
		readAnchorMirror: (...a: Parameters<typeof orig.readAnchorMirror>) =>
			wrapMirror(() => orig.readAnchorMirror(...a), true),
	};
});

vi.mock("../../src/audit/stable-read.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../src/audit/stable-read.js")>();
	return {
		...orig,
		readVaultSnapshot: (...args: Parameters<typeof orig.readVaultSnapshot>) => {
			const read = orig.readVaultSnapshot(...args);
			fire(seam.afterCoreSnapshot);
			return read;
		},
	};
});
vi.mock("../../../verify/src/stable-read.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../../verify/src/stable-read.js")>();
	return {
		...orig,
		readVaultSnapshot: (...args: Parameters<typeof orig.readVaultSnapshot>) => {
			const read = orig.readVaultSnapshot(...args);
			fire(seam.afterSnapshot);
			return read;
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
	seam.afterSnapshot = undefined;
	seam.afterCoreSnapshot = undefined;
	seam.standaloneMirrorReads = 0;
	seam.mirrorExtra = undefined;
	seam.fired = 0;
	busy.auditDir = undefined;
	busy.listings = 0;
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

/**
 * A one-shot fault: the next anchor write (the create of its temp file) fails EACCES, after the
 * append's event was synced to the log. What a failed anchor update leaves: the event on the chain,
 * the OLD anchor in place (the next append rolls it forward), and the event dead-lettered with its hash.
 */
const anchorFault = vi.hoisted(() => ({ armed: false }));
/**
 * A vault that keeps changing while it is read: while armed, every listing of `auditDir` holds a name
 * the one before it did not, so no attempt of a snapshot is ever consistent.
 */
const busy = vi.hoisted(() => ({ auditDir: undefined as string | undefined, listings: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const openSync = ((p: unknown, ...rest: unknown[]) => {
		if (anchorFault.armed && /\.meta\.[0-9a-f-]+\.tmp$/.test(String(p))) {
			anchorFault.armed = false;
			throw Object.assign(new Error(`EACCES: permission denied, open '${String(p)}'`), {
				code: "EACCES",
			});
		}
		return (fs.openSync as (...a: unknown[]) => number)(p, ...rest);
	}) as typeof fs.openSync;
	// By real path: the CLI reads the vault it resolves (`/private/var/...` for `/var/...` on macOS).
	const real = (path: string): string => {
		try {
			return fs.realpathSync(path);
		} catch {
			return path;
		}
	};
	const readdirSync = ((p: unknown, ...rest: unknown[]) => {
		const names = (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
		if (
			busy.auditDir !== undefined &&
			real(String(p)) === real(busy.auditDir) &&
			Array.isArray(names)
		) {
			busy.listings++;
			return [...names, `changing-${busy.listings}.tmp`];
		}
		return names;
	}) as typeof fs.readdirSync;
	return { ...fs, openSync, readdirSync, default: { ...fs, openSync, readdirSync } };
});

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
		anchorFault.armed = true;
		await expect(
			a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_2" } }),
		).rejects.toThrow();
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

	/** Another chain of three events: internally valid, with its own anchor, and covered by no signed anchor. */
	async function otherChain(): Promise<ChainFiles> {
		const other = mkdtempSync(join(tmpdir(), "trust-verify-other-"));
		try {
			await appendEvents(other, 3);
			return capture(other);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	}

	it("a chain no anchor covers is not certified by the anchored chain swapped back in after its walk", async () => {
		const { s, args } = await anchored();
		const genuine = capture(s.root);
		// The other chain is what the walk reads; the genuine one returns before the anchors are evaluated.
		put(await otherChain(), s.root);
		seam.beforeMirror = () => put(genuine, s.root);
		await verifyRun(s.root, { json: true }, args);
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.anchorState).not.toBe("ANCHORED_VERIFIED");
		expect(r.data.valid).toBe(false);
		expect(r.success).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("the standalone verifier certifies no such chain either, and both verifiers give one verdict", async () => {
		const { s } = await anchored();
		const genuine = capture(s.root);
		const other = await otherChain();
		const params = { externalAnchorsRaw: [readFileSync(s.storeFile, "utf-8")], trust: s.trust };
		put(other, s.root);
		seam.beforeMirror = () => put(genuine, s.root);
		const standalone = standaloneVerifyVaultWithAnchors(s.vaultPath, params);
		put(other, s.root);
		const core = coreVerifyVaultWithAnchors(s.vaultPath, params);
		expect(seam.fired).toBe(2);
		expect(standalone.anchorState).not.toBe("ANCHORED_VERIFIED");
		expect(standalone.valid).toBe(false);
		expect({ state: standalone.anchorState, valid: standalone.valid }).toEqual({
			state: core.anchorState,
			valid: core.valid,
		});
	});

	it("the standalone --tx: a forged chain's event is never shown under the genuine chain's inclusion proof", async () => {
		const { s } = await anchored();
		const genuine = capture(s.root);
		// The other chain holds an event of the same transfer id (tr_2), with its own content. It is what
		// the snapshot reads; the genuine chain (its log and its anchor) returns right after, where a
		// multi-read `--tx` read the log again for its verdict and its proof. One snapshot reads no log
		// after it: the verdict is about the chain it read.
		put(await otherChain(), s.root);
		seam.afterSnapshot = () => put(genuine, s.root);
		const params = { externalAnchorsRaw: [readFileSync(s.storeFile, "utf-8")], trust: s.trust };
		const tx = standaloneVerifyTransaction(s.vaultPath, "tr_2", params);
		expect(tx.found).toBe(true);
		expect(tx.receipt).not.toMatch(/INCLUSION VERIFIED/);
		expect(tx.valid).toBe(false);
	});

	it("CONTROL: the standalone --tx on the genuine chain unchanged: the event's inclusion is verified", async () => {
		const { s } = await anchored();
		const params = { externalAnchorsRaw: [readFileSync(s.storeFile, "utf-8")], trust: s.trust };
		const tx = standaloneVerifyTransaction(s.vaultPath, "tr_2", params);
		expect(tx.receipt).toMatch(/INCLUSION VERIFIED/);
		expect(tx.valid).toBe(true);
	});

	/**
	 * A rotation record naming an attacker's key, and a record under that key covering the vault's 4th
	 * event: what a mirror holds when someone who can write the vault adds them.
	 */
	function forgedCover(s: Awaited<ReturnType<typeof anchored>>["s"]): unknown[] {
		const identity = readAnchorIdentity(s.root);
		if (identity === null) throw new Error("no anchor identity");
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const der = publicKey.export({ type: "spki", format: "der" });
		const attackerKeyId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
		const attackerKeyFile = join(s.storeDir, "attacker.pem");
		writeFileSync(attackerKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
		const hashes = readFileSync(logPath(s.root), "utf-8")
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as { hash: string }).hash);
		const filler = "a".repeat(64);
		const rotation = {
			v: 1 as const,
			vaultId: identity.vaultId,
			anchorSeq: 2,
			prevAnchorHash: filler,
			treeSize: 3,
			lastHash: hashes[2] as string,
			merkleRoot: filler,
			timestamp: new Date().toISOString(),
			keyId: identity.keyId,
			rotation: { nextKeyId: attackerKeyId, nextPublicKeySpki: der.toString("base64") },
			sig: "AAAA",
		};
		const cover = signRecord(
			{
				v: 1,
				vaultId: identity.vaultId,
				anchorSeq: 3,
				prevAnchorHash: filler,
				treeSize: 4,
				lastHash: hashes[3] as string,
				merkleRoot: buildMerkleTree(hashes).root as string,
				timestamp: new Date().toISOString(),
				keyId: attackerKeyId,
			},
			attackerKeyFile,
		);
		return standaloneParseAnchors(`${JSON.stringify(rotation)}\n${JSON.stringify(cover)}\n`)
			.records;
	}

	it("the standalone --tx: a covering record added to the mirror after its verdict read it is never used", async () => {
		const { s } = await anchored();
		// tr_4 lands after the signed anchor: it is in the unanchored tail, which no record covers.
		await appendEvents(s.root, 1, 4);
		const forged = forgedCover(s);
		seam.mirrorExtra = (read) => (read >= 2 ? forged : undefined);
		const params = { externalAnchorsRaw: [readFileSync(s.storeFile, "utf-8")], trust: s.trust };
		const tx = standaloneVerifyTransaction(s.vaultPath, "tr_4", params);
		expect(tx.found).toBe(true);
		expect(tx.receipt).not.toMatch(/INCLUSION VERIFIED/);
		expect(tx.receipt).toMatch(/IN UNANCHORED TAIL/);
		expect(seam.standaloneMirrorReads, "the mirror is read once, by the verdict").toBe(1);
	});

	it("CONTROL: the same records in the mirror from its first read: the verdict sees them and refuses", async () => {
		const { s } = await anchored();
		await appendEvents(s.root, 1, 4);
		const forged = forgedCover(s);
		seam.mirrorExtra = () => forged;
		const params = { externalAnchorsRaw: [readFileSync(s.storeFile, "utf-8")], trust: s.trust };
		const tx = standaloneVerifyTransaction(s.vaultPath, "tr_4", params);
		expect(tx.receipt).not.toMatch(/INCLUSION VERIFIED/);
		expect(tx.anchorState).not.toBe("ANCHORED_VERIFIED");
		expect(tx.valid).toBe(false);
	});

	it("an event appended and anchored while the walk runs is outside the verdict: never a rollback", async () => {
		const { s, args } = await anchored();
		const mirror = join(auditDir(s.root), "anchors", "anchors.jsonl");
		const store = readFileSync(s.storeFile, "utf-8");
		const before = { chain: capture(s.root), mirror: readFileSync(mirror) };
		// What an honest writer and emitter leave a moment later: tr_4, and a second anchor covering it.
		await appendEvents(s.root, 1, 4);
		await anchorOnce(s);
		const after = { chain: capture(s.root), mirror: readFileSync(mirror) };
		put(before.chain, s.root);
		writeFileSync(mirror, before.mirror);
		writeFileSync(s.storeFile, store);
		// They land the moment the snapshot is taken, before anything else is read. Read again after
		// the walk (the mirror, or the vault), it held an anchor of 4 events over a walk of 3: a
		// rollback, for an honest vault. Once: a second snapshot would see them.
		seam.afterCoreSnapshot = () => {
			seam.afterCoreSnapshot = undefined;
			put(after.chain, s.root);
			writeFileSync(mirror, after.mirror);
		};
		await verifyRun(s.root, { json: true }, args);
		expect(seam.fired).toBe(1);
		const r = json();
		expect(r.data.anchorState).toBe("ANCHORED_VERIFIED");
		expect(r.data.valid).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("CONTROL: the standalone verifier, on the genuine chain unchanged: ANCHORED_VERIFIED", async () => {
		const { s } = await anchored();
		const params = { externalAnchorsRaw: [readFileSync(s.storeFile, "utf-8")], trust: s.trust };
		const standalone = standaloneVerifyVaultWithAnchors(s.vaultPath, params);
		expect(standalone.anchorState).toBe("ANCHORED_VERIFIED");
		expect(standalone.valid).toBe(true);
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

	it("a chain swapped for its prefix right before health's one read: the event is MISSING", async () => {
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

// Each busy read makes every attempt it is allowed (26, 100 ms apart) before it says so.
describe("a vault that keeps changing while it is read: no verdict, and nothing judged against it", {
	timeout: 20_000,
}, () => {
	const busyLine =
		"the vault is being written: its audit files kept changing while they were read, so there is no verdict (run verify again)";

	it("verify --json --receipts: no verdict, the dead letters and receipts not judged, exit 1", async () => {
		await chainWithDeadLetterOnIt();
		const file = join(tempDir, "receipts.jsonl");
		writeFileSync(file, JSON.stringify({ transferId: "tx_1", auditHash: "a".repeat(64) }));
		busy.auditDir = auditDir();
		await verifyRun(tempDir, { json: true }, ["--receipts", file]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data).toMatchObject({ busy: true, valid: false, complete: null, deadLetters: null });
		expect(r.data.receipts).toBeUndefined();
		expect(r.data.errors).toEqual([busyLine]);
		expect(process.exitCode).toBe(1);
	});

	it("anchored verify --json: the anchors are not evaluated, never 'deletion detected'", async () => {
		const st = await makeAnchoredVault(3);
		await anchorOnce(st);
		const pubkey = join(st.storeDir, "root.pub.pem");
		writeFileSync(pubkey, st.rootPem);
		busy.auditDir = auditDir(st.root);
		await verifyRun(st.root, { json: true }, ["--anchor", st.storeFile, "--pubkey", pubkey]);
		const r = json();
		expect(r.data).toMatchObject({
			busy: true,
			anchorState: "ANCHOR_UNVERIFIABLE",
			anchoring: { reasons: ["busy"] },
		});
		expect((r.data.errors as string[]).join(" ")).not.toMatch(/deletion/);
		expect(process.exitCode).toBe(1);
	});

	it("the standalone verifier: its anchors not evaluated, and --tx says busy, never 'not found'", async () => {
		const st = await makeAnchoredVault(3);
		await anchorOnce(st);
		const params = { externalAnchorsRaw: [readFileSync(st.storeFile, "utf-8")], trust: st.trust };
		busy.auditDir = auditDir(st.root);
		const vault = standaloneVerifyVaultWithAnchors(st.vaultPath, params);
		expect(vault).toMatchObject({ busy: true, anchorState: "ANCHOR_UNVERIFIABLE" });
		expect(vault.anchoring.reasons).toEqual(["busy"]);
		const tx = standaloneVerifyTransaction(st.vaultPath, "tr_2", params);
		expect(tx).toMatchObject({ found: false, valid: false, busy: true, errors: [busyLine] });
	});

	it("health --json: no health verdict, never a chain called critical because nobody read it", async () => {
		await chainWithDeadLetterOnIt();
		busy.auditDir = auditDir();
		const cwd = process.cwd();
		process.chdir(tempDir);
		try {
			await healthRun(undefined, { json: true });
		} finally {
			process.chdir(cwd);
		}
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data).toMatchObject({ busy: true });
		expect(r.data.level).toBeUndefined();
	});

	it("inspect: no statement from a vault being written, never 'INTEGRITY FAILURE'", async () => {
		await chainWithDeadLetterOnIt();
		busy.auditDir = auditDir();
		await inspectRun(tempDir, { json: true });
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data).toMatchObject({ busy: true });
		expect(process.exitCode).toBe(1);
	});

	it("export: no verdict for a vault being written, never 'BROKEN'", async () => {
		await chainWithDeadLetterOnIt();
		busy.auditDir = auditDir();
		const outDir = join(tempDir, "md-out");
		await exportRun(tempDir, { json: false }, ["--markdown", outDir]);
		expect(out.join("\n")).toMatch(/Chain integrity: .*no verdict/);
		expect(out.join("\n")).not.toMatch(/BROKEN/);
		expect(readFileSync(join(outDir, "Ledger Index.md"), "utf-8")).toMatch(
			/Vault verification: no verdict/,
		);
	});

	it("report --json: no report from a vault being written, never a week of no spend", async () => {
		await chainWithDeadLetterOnIt();
		busy.auditDir = auditDir();
		const target = join(tempDir, "week.md");
		await reportRun(tempDir, { json: true }, [
			"--week",
			"--end",
			new Date().toISOString(),
			"--out",
			target,
		]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.message).toMatch(/being written: its audit files kept changing/);
		expect(existsSync(target)).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("verifyVaultComplete: no dead letters judged against a read that has no snapshot", async () => {
		await chainWithDeadLetterOnIt();
		busy.auditDir = auditDir();
		const v = verifyVaultComplete(join(tempDir, VAULT_DIR));
		expect(v.reading.result.busy).toBe(true);
		expect(v).toMatchObject({ deadLetters: null, complete: false, valid: false });
		expect(v.errors).toEqual([busyLine]);
	});

	it("CONTROL: the same vault at rest is verified and complete, and inspect and export say so", async () => {
		await chainWithDeadLetterOnIt();
		await verifyRun(tempDir, { json: true });
		expect(json().data).toMatchObject({ valid: true, complete: true });
		out.length = 0;
		await inspectRun(tempDir, { json: true });
		expect(json().data).toMatchObject({ chain: { valid: true, events: 3 } });
		// The statement's rows come from the walk's events, not only its count.
		expect(json().data.transactions).toHaveLength(3);
		out.length = 0;
		await exportRun(tempDir, { json: false }, ["--markdown", join(tempDir, "md-out")]);
		expect(out.join("\n")).toMatch(/Chain integrity: verified/);
	});

	it("CONTROL: the same vault at rest is reported on, and its dead letters are judged", async () => {
		await chainWithDeadLetterOnIt();
		const target = join(tempDir, "week.md");
		await reportRun(tempDir, { json: true }, [
			"--week",
			"--end",
			new Date().toISOString(),
			"--out",
			target,
		]);
		expect(json()).toMatchObject({ success: true, data: { verified: true } });
		expect(existsSync(target)).toBe(true);
		const v = verifyVaultComplete(join(tempDir, VAULT_DIR));
		expect(v).toMatchObject({ complete: true, valid: true });
		expect(v.deadLetters).not.toBeNull();
	});
});
