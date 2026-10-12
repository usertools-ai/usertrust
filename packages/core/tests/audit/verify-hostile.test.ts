// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Both verifiers on a vault the audit trail's writer did not leave as it wrote it. One verdict for
 * one set of bytes, from every entry point, in both packages:
 *  - a chain whose only segment is a rotated one is classified by its events, never as an empty log
 *    (a truncated chain, its anchor deleted, renamed: once read FRESH and valid);
 *  - a log or a dead-letter queue past V8's string limit is read line by line, never decoded whole
 *    (once an uncaught ERR_STRING_TOO_LONG), and a file past the bound for one read is named, never read;
 *  - `verifyChain` is the vault's own walk: an id that cannot be made a string never throws, an
 *    interrupted recovery is seen, and every sequence is at its position;
 *  - an audit directory that is a link is the directory the OS opens there, for every writer and reader;
 *  - a FIFO in a file's place never blocks `usertrust health` or the anchor mirror's read.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readAnchorMirror as standaloneReadAnchorMirror,
	verifyChain as standaloneVerifyChain,
	verifyTransaction as standaloneVerifyTransaction,
	verifyVaultReading as standaloneVerifyVaultReading,
} from "../../../verify/src/index.js";
import { readAnchorMirror } from "../../src/audit/anchor-verify.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { readChainDeadLetters } from "../../src/audit/dead-letters.js";
import { quarantineTornTail } from "../../src/audit/quarantine.js";
import { verifyChain, verifyVaultReading } from "../../src/audit/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";
import { anchorOnce, cleanupAll, makeAnchoredVault } from "../harden/anchoring/fixtures.js";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
/** One past the longest string V8 makes (0x1fffffe8 characters): a line this long cannot be decoded. */
const PAST_STRING_LIMIT = 0x1fffffe8 + 2;
const GIB = 1024 * 1024 * 1024;

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "verify-hostile-"));
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const vaultDir = () => join(root, VAULT_DIR);
const auditDir = () => join(vaultDir(), "audit");
const logPath = () => join(auditDir(), "events.jsonl");
const metaPath = () => `${logPath()}.meta`;

async function vaultOf(n: number): Promise<void> {
	const w = createAuditWriter(root);
	try {
		for (let i = 1; i <= n; i++) {
			await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_${i}` } });
		}
	} finally {
		w.release();
	}
}

const lines = () => readFileSync(logPath(), "utf-8").trim().split("\n");

/** Both verifiers' verdicts on the vault, in the fields every row compares. */
function both() {
	return [
		verifyVaultReading(vaultDir()).result,
		standaloneVerifyVaultReading(vaultDir()).result,
	].map((r) => ({ valid: r.valid, state: r.tailState?.state ?? null, chainLength: r.chainLength }));
}

/** A sparse file of `size` bytes, all zeros but a newline at its end: one line of `size - 1` bytes. */
function sparseLine(path: string, size: number): void {
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, size);
		writeSync(fd, "\n", size - 1);
	} finally {
		closeSync(fd);
	}
}

/** A hashed event line, as the writer would persist it. */
function hashedLine(body: Record<string, unknown>): { line: string; hash: string } {
	const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
	return { line: canonicalize({ ...body, hash }), hash };
}

describe("a chain whose only segment is a rotated one is classified by its events", () => {
	it("truncated 10 -> 7, its anchor deleted, renamed to a rotated segment: ANCHOR_MISSING in both, never FRESH and valid", async () => {
		await vaultOf(10);
		writeFileSync(logPath(), `${lines().slice(0, 7).join("\n")}\n`);
		rmSync(metaPath());
		renameSync(logPath(), join(auditDir(), "events.0001.jsonl"));
		for (const v of both())
			expect(v).toEqual({ valid: false, state: "ANCHOR_MISSING", chainLength: 7 });
	});

	it("the complete chain renamed, its anchor intact: MATCH and valid in both, never 'the log is missing'", async () => {
		await vaultOf(10);
		renameSync(logPath(), join(auditDir(), "events.0001.jsonl"));
		for (const v of both()) expect(v).toEqual({ valid: true, state: "MATCH", chainLength: 10 });
	});

	it("CONTROL: the chain over two segments, its anchor intact: valid in both", async () => {
		await vaultOf(10);
		const all = lines();
		writeFileSync(join(auditDir(), "events.0001.jsonl"), `${all.slice(0, 5).join("\n")}\n`);
		writeFileSync(logPath(), `${all.slice(5).join("\n")}\n`);
		for (const v of both()) expect(v).toEqual({ valid: true, state: "MATCH", chainLength: 10 });
	});
});

describe("files past V8's string limit, and past the bound for one read", () => {
	it("a log of one line past the string limit: both verifiers answer, the line is malformed, nothing throws", async () => {
		mkdirSync(auditDir(), { recursive: true });
		sparseLine(logPath(), PAST_STRING_LIMIT);
		for (const read of [verifyVaultReading, standaloneVerifyVaultReading]) {
			const outcome = (() => {
				try {
					return read(vaultDir()).result;
				} catch (err) {
					return err;
				}
			})();
			expect(outcome).not.toBeInstanceOf(Error);
			expect(outcome).toMatchObject({ valid: false });
			expect((outcome as { errors: string[] }).errors).toContain("malformed JSON (events.jsonl:1)");
		}
	}, 60_000);

	it("a log past the bound for one read: named, never read, in both", async () => {
		mkdirSync(auditDir(), { recursive: true });
		sparseLine(logPath(), GIB + 2);
		for (const read of [verifyVaultReading, standaloneVerifyVaultReading]) {
			const outcome = (() => {
				try {
					return read(vaultDir());
				} catch (err) {
					return err;
				}
			})();
			expect(outcome).not.toBeInstanceOf(Error);
			const { result } = outcome as ReturnType<typeof verifyVaultReading>;
			expect(result.valid).toBe(false);
			expect(result.tailState?.state).toBe("TAIL_OVERSIZE");
			expect(result.errors.join(" ")).toMatch(
				/events\.jsonl \(1073741826 bytes, over the 1073741824-byte bound/,
			);
		}
	}, 60_000);

	it("a dead-letter queue of one line past the string limit: that letter is unreadable, so counted missing; nothing throws", async () => {
		mkdirSync(join(vaultDir(), "dlq"), { recursive: true });
		sparseLine(join(vaultDir(), "dlq", "dead-letters.jsonl"), PAST_STRING_LIMIT);
		const outcome = (() => {
			try {
				return readChainDeadLetters(vaultDir(), () => undefined);
			} catch (err) {
				return err;
			}
		})();
		expect(outcome).not.toBeInstanceOf(Error);
		expect(outcome).toMatchObject({ missing: 1, missingByKind: { "<unreadable>": 1 } });
	}, 60_000);
});

describe("a link in a file's place is judged, never read as nothing there", () => {
	it("a dead-letter DIRECTORY that is a link leading nowhere: the queue is unknown, never 'none'", async () => {
		await vaultOf(1);
		symlinkSync(join(root, "nowhere"), join(vaultDir(), "dlq"));
		expect(readChainDeadLetters(vaultDir(), () => undefined)).toMatchObject({
			unreadable: expect.stringMatching(/its directory cannot be read/),
		});
	});

	it("CONTROL: no dead-letter directory at all: nothing was dead-lettered", async () => {
		await vaultOf(1);
		expect(readChainDeadLetters(vaultDir(), () => undefined)).toMatchObject({ missing: 0 });
	});

	it("the standalone --tx with a link leading nowhere in the log's place: a failure, never 'not found'", async () => {
		mkdirSync(auditDir(), { recursive: true });
		symlinkSync(join(root, "nowhere.jsonl"), logPath());
		const tx = standaloneVerifyTransaction(vaultDir(), "tx_1");
		expect(tx).toMatchObject({ found: false, valid: false, failed: true });
		expect(tx.errors.join(" ")).toMatch(/a symlink, not a regular file/);
	});

	it("the standalone --tx with a link leading nowhere in the AUDIT DIRECTORY's place: a failure, never 'not found'", () => {
		mkdirSync(vaultDir(), { recursive: true });
		symlinkSync(join(root, "nowhere"), auditDir());
		const tx = standaloneVerifyTransaction(vaultDir(), "tx_1");
		expect(tx).toMatchObject({ found: false, valid: false, failed: true });
	});

	it("the standalone --tx on a chain whose only segment is a rotated one: the event is found there", async () => {
		await vaultOf(4);
		renameSync(logPath(), join(auditDir(), "events.0001.jsonl"));
		const tx = standaloneVerifyTransaction(vaultDir(), "tx_3");
		expect(tx).toMatchObject({ found: true, valid: true });
	});

	it("CONTROL: the standalone --tx with an empty audit directory: not found, the log empty", () => {
		mkdirSync(auditDir(), { recursive: true });
		const tx = standaloneVerifyTransaction(vaultDir(), "tx_1");
		expect(tx).toMatchObject({ found: false, valid: false });
		expect(tx.failed).toBeUndefined();
		expect(tx.errors.join(" ")).toMatch(/Audit log is empty/);
	});

	it("CONTROL: the standalone --tx with nothing at the audit directory's path: not found", () => {
		mkdirSync(vaultDir(), { recursive: true });
		const tx = standaloneVerifyTransaction(vaultDir(), "tx_1");
		expect(tx).toMatchObject({ found: false, valid: false });
		expect(tx.failed).toBeUndefined();
		expect(tx.errors.join(" ")).toMatch(/Audit log not found/);
	});
});

describe("verifyChain is the vault's own walk, in both packages", () => {
	it("an event whose id is an object with no callable toString: answered, never thrown", () => {
		mkdirSync(auditDir(), { recursive: true });
		const { line, hash } = hashedLine({
			id: { toString: 1 },
			timestamp: "2026-10-12T00:00:00.000Z",
			previousHash: GENESIS_HASH,
			kind: "llm_call",
			actor: "local",
			data: {},
			sequence: 1,
		});
		writeFileSync(logPath(), `${line}\n`);
		writeFileSync(metaPath(), JSON.stringify({ lastHash: hash, sequence: 1 }));
		for (const chain of [verifyChain, standaloneVerifyChain]) {
			const outcome = (() => {
				try {
					return chain(logPath());
				} catch (err) {
					return err;
				}
			})();
			expect(outcome).not.toBeInstanceOf(Error);
			expect(outcome).toMatchObject({ valid: true, eventsVerified: 1 });
		}
	});

	it("an interrupted recovery (audit/quarantine/PENDING) is RECOVERY_PENDING, never a valid chain", async () => {
		await vaultOf(3);
		mkdirSync(join(auditDir(), "quarantine"));
		writeFileSync(join(auditDir(), "quarantine", "PENDING"), "{}");
		for (const chain of [verifyChain, standaloneVerifyChain]) {
			const r = chain(logPath());
			expect(r.valid).toBe(false);
			expect(r.tailState?.state).toBe("RECOVERY_PENDING");
		}
	});

	it("every sequence is at its position: hashed and linked as 1, 5, 3 under an anchor of 3 is not a valid chain", () => {
		mkdirSync(auditDir(), { recursive: true });
		let previousHash = GENESIS_HASH;
		const out: string[] = [];
		for (const [i, sequence] of [1, 5, 3].entries()) {
			const { line, hash } = hashedLine({
				id: `e${i + 1}`,
				timestamp: "2026-10-12T00:00:00.000Z",
				previousHash,
				kind: "llm_call",
				actor: "local",
				data: {},
				sequence,
			});
			out.push(line);
			previousHash = hash;
		}
		writeFileSync(logPath(), `${out.join("\n")}\n`);
		writeFileSync(metaPath(), JSON.stringify({ lastHash: previousHash, sequence: 3 }));
		for (const chain of [verifyChain, standaloneVerifyChain]) {
			expect(chain(logPath()).valid).toBe(false);
		}
	});

	it("lines swapped in the file keep their hashes and links, and still are not a valid chain", async () => {
		await vaultOf(5);
		const all = lines();
		writeFileSync(logPath(), `${[all[1], all[0], ...all.slice(2)].join("\n")}\n`);
		for (const chain of [verifyChain, standaloneVerifyChain]) {
			expect(chain(logPath()).valid).toBe(false);
		}
		for (const v of both()) expect(v.valid).toBe(false);
	});

	it("verifyChain reads the one file it is given: a copy beside it is never read into it", async () => {
		await vaultOf(3);
		writeFileSync(join(auditDir(), "backup.jsonl"), readFileSync(logPath()));
		for (const chain of [verifyChain, standaloneVerifyChain]) {
			expect(chain(logPath())).toMatchObject({ valid: true, eventsVerified: 3 });
		}
	});

	it("CONTROL: the writer's own chain is valid to both, as verifyVault reads it", async () => {
		await vaultOf(3);
		for (const chain of [verifyChain, standaloneVerifyChain]) {
			expect(chain(logPath())).toMatchObject({ valid: true, eventsVerified: 3, errors: [] });
		}
		for (const v of both()) expect(v).toEqual({ valid: true, state: "MATCH", chainLength: 3 });
	});
});

describe("an audit directory that is a link is the directory the OS opens there, for every writer and reader", () => {
	/** The vault's audit directory moved elsewhere, a link left in its place. */
	async function linkedAudit(): Promise<string> {
		await vaultOf(2);
		const elsewhere = join(root, "elsewhere-audit");
		renameSync(auditDir(), elsewhere);
		symlinkSync(elsewhere, auditDir());
		return elsewhere;
	}

	it("verify reads it, `usertrust secret`'s writer appends to it, quarantine-tail judges it", async () => {
		const elsewhere = await linkedAudit();
		for (const v of both()) expect(v).toEqual({ valid: true, state: "MATCH", chainLength: 2 });
		const w = createAuditWriter(root);
		let appended: unknown;
		try {
			appended = await w
				.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_3" } })
				.then(
					() => "appended",
					(e: unknown) => e,
				);
		} finally {
			w.release();
		}
		expect(appended).toBe("appended");
		expect(readFileSync(join(elsewhere, "events.jsonl"), "utf-8").trim().split("\n")).toHaveLength(
			3,
		);
		const dry = await quarantineTornTail(root, { dryRun: true }).then(
			(r) => r,
			(e: unknown) => e,
		);
		expect(dry).not.toBeInstanceOf(Error);
		for (const v of both()) expect(v).toEqual({ valid: true, state: "MATCH", chainLength: 3 });
	});

	it("CONTROL: a link that leads nowhere is unreadable, never an empty vault", async () => {
		await vaultOf(1);
		rmSync(auditDir(), { recursive: true });
		symlinkSync(join(root, "nowhere"), auditDir());
		for (const v of both())
			expect(v).toMatchObject({ valid: false, state: "INVENTORY_UNREADABLE" });
	});
});

describe("the anchor mirror grows with every anchor: it is read within the bound for one read, line by line", () => {
	it("a mirror past 64 MiB (a few months of anchors) still reads its records, in both packages", async () => {
		const s = await makeAnchoredVault(2);
		try {
			await anchorOnce(s);
			const mirror = join(s.vaultPath, "audit", "anchors", "anchors.jsonl");
			// Padding the parser skips (blank lines), past the bound a mirror once had.
			appendFileSync(mirror, `${" ".repeat(65 * 1024 * 1024)}\n`);
			for (const read of [readAnchorMirror, standaloneReadAnchorMirror]) {
				const { records, errors } = read(s.vaultPath);
				expect(errors).toEqual([]);
				expect(records).toHaveLength(1);
			}
		} finally {
			cleanupAll();
		}
	}, 60_000);
});

describe("a FIFO in a file's place never blocks a reader (each row runs in a child, under a time bound)", () => {
	/** Run `script` (an ES module) in a child with the TypeScript loader, from the repository's root. */
	function child(script: string, ...args: string[]) {
		return spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script, ...args],
			{
				cwd: REPO,
				encoding: "utf-8",
				timeout: 30_000,
			},
		);
	}

	it("`usertrust health` with a FIFO in the log's place answers, naming it", async () => {
		await vaultOf(2);
		rmSync(logPath());
		mkfifo(logPath());
		const health = join(REPO, "packages", "core", "src", "cli", "health.ts");
		const r = child(
			`const { run } = await import(${JSON.stringify(health)}); await run(process.argv[1], { json: true });`,
			root,
		);
		expect(r.signal, "the child was killed: it blocked").toBeNull();
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).data.signals).toMatchObject({ chainState: "LOG_NOT_REGULAR" });
	});

	it("anchored verify with a FIFO in the anchor mirror's place answers, and never as 'no anchors'", async () => {
		await vaultOf(2);
		mkdirSync(join(auditDir(), "anchors"));
		mkfifo(join(auditDir(), "anchors", "anchors.jsonl"));
		const verify = join(REPO, "packages", "core", "src", "audit", "verify.ts");
		const r = child(
			`const { verifyVaultWithAnchors } = await import(${JSON.stringify(verify)}); process.stdout.write(JSON.stringify(verifyVaultWithAnchors(process.argv[1])));`,
			vaultDir(),
		);
		expect(r.signal, "the child was killed: it blocked").toBeNull();
		expect(r.status).toBe(0);
		// An unreadable mirror is evidence that cannot be read, never an absence: not UNANCHORED.
		expect(JSON.parse(r.stdout)).toMatchObject({ anchorState: "ANCHOR_UNVERIFIABLE" });
	});
});

/** A FIFO at `path`. */
function mkfifo(path: string): void {
	execFileSync("mkfifo", ["-m", "600", path]);
}
