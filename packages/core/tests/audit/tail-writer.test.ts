// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The writer never appends over a tail it cannot explain against its anchor. It once ADOPTED any last
 * line it found and rewrote `.meta` to it: a truncated log (three events dropped from ten) took two
 * more appends with no error, and `verify` then passed 9/9 over a chain missing three events. Now
 * every append classifies the tail it is about to write after (`tail-state.ts`), through the very
 * descriptor it writes, and refuses anything but a FRESH vault, a MATCH, or ONE event past the anchor
 * (an interrupted write, rolled forward: its log synced before its anchor records it). A refusal writes
 * nothing, creates nothing, and dead-letters the event as any failed append does.
 *
 * Nothing is cached between appends, so the rows that changed the files UNDER A WARM writer (a
 * truncation, an anchor restored alone, a log replaced by a rename with a same-size file, a segment
 * added) are refused exactly as a cold writer refuses them.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readlinkSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One-shot and counted faults on the writer's file calls (see each row). */
const fault = vi.hoisted(() => ({
	/** 1-based numbers of the anchor writes (temp-file creates) that fail EACCES. */
	anchorWritesToFail: new Set<number>(),
	anchorWrites: 0,
	/** Fail the next fsync of the LOG's descriptor EIO, once (never another file's: the anchor's temp file). */
	failNextLogFsync: false,
	/** Fail the next fstat of the LOG's descriptor EIO, once. */
	failNextLogFstat: false,
	/** When set, the order of the writer's create of the log, its directory syncs and its anchor writes. */
	trace: undefined as string[] | undefined,
	/** Fail the next sync of the audit directory EIO, once, after the writer created the log. */
	failDirSyncAfterCreate: false,
	createdLog: false,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	// The descriptors open on the log, by number (a number is reused once closed: re-judged at each open).
	const logFds = new Set<number>();
	// The descriptors open on an audit directory (to sync it).
	const auditDirFds = new Set<number>();
	const openSync = ((p: unknown, ...rest: unknown[]) => {
		if (/\.meta\.[0-9a-f-]+\.tmp$/.test(String(p))) {
			fault.trace?.push("open:anchor-tmp");
			fault.anchorWrites++;
			if (fault.anchorWritesToFail.has(fault.anchorWrites)) {
				throw Object.assign(new Error(`EACCES: permission denied, open '${String(p)}'`), {
					code: "EACCES",
				});
			}
		}
		const fd = (fs.openSync as (...a: unknown[]) => number)(p, ...rest);
		logFds.delete(fd);
		auditDirFds.delete(fd);
		if (String(p).endsWith("events.jsonl")) {
			logFds.add(fd);
			const flags = rest[0];
			if (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) {
				fault.trace?.push("create:log");
				fault.createdLog = true;
			}
		}
		if (String(p).endsWith("/audit")) auditDirFds.add(fd);
		return fd;
	}) as typeof fs.openSync;
	const fsyncSync = ((fd: number) => {
		if (fault.failNextLogFsync && logFds.has(fd)) {
			fault.failNextLogFsync = false;
			throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
		}
		if (auditDirFds.has(fd)) {
			fault.trace?.push("fsync:audit-dir");
			if (fault.failDirSyncAfterCreate && fault.createdLog) {
				fault.failDirSyncAfterCreate = false;
				throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
			}
		}
		return fs.fsyncSync(fd);
	}) as typeof fs.fsyncSync;
	const fstatSync = ((fd: number, ...rest: unknown[]) => {
		if (fault.failNextLogFstat && logFds.has(fd)) {
			fault.failNextLogFstat = false;
			throw Object.assign(new Error("EIO: i/o error, fstat"), { code: "EIO" });
		}
		return (fs.fstatSync as (...a: unknown[]) => unknown)(fd, ...rest);
	}) as typeof fs.fstatSync;
	return {
		...fs,
		openSync,
		fsyncSync,
		fstatSync,
		default: { ...fs, openSync, fsyncSync, fstatSync },
	};
});

const { AuditTailMismatchError, AuditTornTailError, createAuditWriter, openSharedAuditWriter } =
	await import("../../src/audit/chain.js");
const { MAX_RECORD_LINE_BYTES, quarantineTornTail } = await import("../../src/audit/quarantine.js");
const { verifyVault, verifyVaultReading } = await import("../../src/audit/verify.js");
const { readChainDeadLetters } = await import("../../src/audit/dead-letters.js");
const { canonicalize } = await import("../../src/audit/canonical.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");
const { securePrivateVault } = await import("../../src/shared/private-fs.js");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tail-writer-"));
	fault.anchorWritesToFail.clear();
	fault.anchorWrites = 0;
	fault.failNextLogFsync = false;
	fault.failNextLogFstat = false;
	fault.trace = undefined;
	fault.failDirSyncAfterCreate = false;
	fault.createdLog = false;
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const auditDir = () => join(root, VAULT_DIR, "audit");
const logPath = () => join(auditDir(), "events.jsonl");
const metaPath = () => `${logPath()}.meta`;
const dlqPath = () => join(root, VAULT_DIR, "dlq", "dead-letters.jsonl");
/** A file's bytes, or what it is when it is not a regular file: a FIFO is never read (it would block). */
const read = (p: string): Buffer | string | null => {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(p);
	} catch {
		return null;
	}
	if (st.isSymbolicLink()) return `symlink -> ${readlinkSync(p)}`;
	if (!st.isFile()) return st.isDirectory() ? "directory" : st.isFIFO() ? "fifo" : "other";
	return readFileSync(p);
};
const files = () => ({ log: read(logPath()), meta: read(metaPath()) });
const lines = () => readFileSync(logPath(), "utf-8").trim().split("\n");
/** A promise's outcome as a value: its rejection, or "resolved". Asserted on, so a mutant that changes
 * the outcome fails by assertion (a bare `rejects` reads a resolved promise as an error, not a verdict). */
const outcome = (p: Promise<unknown>): Promise<unknown> =>
	p.then(
		() => "resolved",
		(e: unknown) => e,
	);
const message = (o: unknown): string => (o instanceof Error ? o.message : String(o));
const deadLetters = () =>
	existsSync(dlqPath()) ? readFileSync(dlqPath(), "utf-8").trim().split("\n") : [];
const input = (n: number) => ({
	kind: "llm_call",
	actor: "local",
	data: { transferId: `tx_${n}` },
});

async function vaultOf(n: number): Promise<void> {
	const w = createAuditWriter(root);
	try {
		for (let i = 1; i <= n; i++) await w.appendEvent(input(i));
	} finally {
		w.release();
	}
}

/** The append must reject in `state`, writing and creating nothing, its event dead-lettered. */
async function expectRefused(
	writer: { appendEvent: (i: ReturnType<typeof input>) => Promise<unknown> },
	state: string,
	n = 99,
): Promise<void> {
	const before = files();
	const letters = deadLetters().length;
	const err = await writer.appendEvent(input(n)).then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(err, `refused in ${state}`).toBeInstanceOf(AuditTailMismatchError);
	expect((err as InstanceType<typeof AuditTailMismatchError>).state).toBe(state);
	expect(files(), "nothing written, nothing created").toEqual(before);
	expect(deadLetters()).toHaveLength(letters + 1);
}

describe("a COLD writer: a truncated log is refused, not adopted", () => {
	it("ten events, the last three cut away with the anchor kept: two appends each refused FEWER_THAN_ANCHOR, both dead-lettered; verify fails", async () => {
		await vaultOf(10);
		writeFileSync(logPath(), `${lines().slice(0, 7).join("\n")}\n`);
		const w = createAuditWriter(root);
		try {
			await expectRefused(w, "FEWER_THAN_ANCHOR", 11);
			await expectRefused(w, "FEWER_THAN_ANCHOR", 12);
		} finally {
			w.release();
		}
		expect(lines()).toHaveLength(7);
		const verdict = verifyVault(join(root, VAULT_DIR));
		expect(verdict.valid).toBe(false);
		expect(verdict.tailState?.state).toBe("FEWER_THAN_ANCHOR");
		// The count the anchor records, on its own line: the diagnostic that names what is missing.
		expect(verdict.errors).toContain(
			"anchor mismatch: expected 10 event(s), found 7 (truncation/deletion)",
		);
	});
});

describe("a WARM writer: nothing is cached between appends", () => {
	function open() {
		securePrivateVault(join(root, VAULT_DIR), { create: true });
		return openSharedAuditWriter(root);
	}

	it("a truncation between two appends of one handle", async () => {
		const h = open();
		try {
			for (let i = 1; i <= 4; i++) await h.appendEvent(input(i));
			writeFileSync(logPath(), `${lines().slice(0, 2).join("\n")}\n`);
			await expectRefused(h, "FEWER_THAN_ANCHOR");
		} finally {
			h.release();
		}
	});

	it("the anchor restored alone, two events behind", async () => {
		const h = open();
		try {
			await h.appendEvent(input(1));
			const old = readFileSync(metaPath());
			await h.appendEvent(input(2));
			await h.appendEvent(input(3));
			writeFileSync(metaPath(), old);
			await expectRefused(h, "MORE_THAN_ONE_PAST_ANCHOR");
		} finally {
			h.release();
		}
	});

	it("the log replaced by a RENAME with a file of the same size: a re-hashed head the anchor never recorded", async () => {
		const h = open();
		try {
			for (let i = 1; i <= 3; i++) await h.appendEvent(input(i));
			const ls = lines();
			const last = JSON.parse(ls[2] as string) as Record<string, unknown>;
			const { hash: _old, ...body } = { ...last, data: { transferId: "tx_X" } } as Record<
				string,
				unknown
			>;
			const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
			const replaced = `${[ls[0], ls[1], canonicalize({ ...body, hash })].join("\n")}\n`;
			expect(Buffer.byteLength(replaced)).toBe(readFileSync(logPath()).length);
			const tmp = join(auditDir(), "replacement.tmp");
			writeFileSync(tmp, replaced);
			renameSync(tmp, logPath());
			await expectRefused(h, "HEAD_MISMATCH");
		} finally {
			h.release();
		}
	});

	it("a log segment added beside events.jsonl", async () => {
		const h = open();
		try {
			await h.appendEvent(input(1));
			writeFileSync(join(auditDir(), "events-0001.jsonl"), "");
			await expectRefused(h, "SEGMENTED");
		} finally {
			h.release();
		}
	});

	it("a refusal is not remembered: the corrupt last line restored, the next append goes on from the head", async () => {
		const h = open();
		try {
			for (let i = 1; i <= 2; i++) await h.appendEvent(input(i));
			const good = readFileSync(logPath());
			const head = JSON.parse(lines()[1] as string) as { hash: string };
			writeFileSync(logPath(), good.toString().replace("tx_2", "tx_Z"));
			await expectRefused(h, "CORRUPT_TAIL");
			writeFileSync(logPath(), good);
			const next = (await h.appendEvent(input(3))) as unknown as {
				previousHash: string;
				sequence: number;
			};
			expect(next).toMatchObject({ previousHash: head.hash, sequence: 3 });
		} finally {
			h.release();
		}
	});

	it("two handles on one vault: the second handle's append is refused after a truncation made under the first", async () => {
		const a = open();
		const b = open();
		try {
			for (let i = 1; i <= 3; i++) await a.appendEvent(input(i));
			writeFileSync(logPath(), `${lines().slice(0, 1).join("\n")}\n`);
			await expectRefused(b, "FEWER_THAN_ANCHOR");
		} finally {
			a.release();
			b.release();
		}
	});
});

describe("an interrupted write is rolled forward, never read as a truncation", () => {
	it("each append's own anchor write fails, the roll-forward between them does not: always exactly one event past the anchor", async () => {
		const w = createAuditWriter(root);
		try {
			await w.appendEvent(input(1)); // anchor write 1
			fault.anchorWritesToFail.add(2); // event 2's own anchor write
			expect(message(await outcome(w.appendEvent(input(2))))).toMatch(/EACCES/);
			expect(JSON.parse(readFileSync(metaPath(), "utf-8"))).toMatchObject({ sequence: 1 });
			// Event 3: the roll-forward (anchor write 3) records event 2; its own (write 4) fails.
			fault.anchorWritesToFail.add(4);
			expect(message(await outcome(w.appendEvent(input(3))))).toMatch(/EACCES/);
			expect(lines()).toHaveLength(3);
			// ONE behind, not two: the anchor records event 2.
			const event2 = JSON.parse(lines()[1] as string) as { hash: string };
			expect(JSON.parse(readFileSync(metaPath(), "utf-8"))).toEqual({
				lastHash: event2.hash,
				sequence: 2,
			});
			expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({
				valid: true,
				tailState: { state: "ONE_PAST_ANCHOR" },
			});
			await w.appendEvent(input(4));
		} finally {
			w.release();
		}
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 4 });
	});

	it("the same for the FIRST event, whose anchor was never written", async () => {
		const w = createAuditWriter(root);
		try {
			fault.anchorWritesToFail.add(1);
			expect(message(await outcome(w.appendEvent(input(1))))).toMatch(/EACCES/);
			expect(existsSync(metaPath())).toBe(false);
			fault.anchorWritesToFail.add(3);
			expect(message(await outcome(w.appendEvent(input(2))))).toMatch(/EACCES/);
			const event1 = JSON.parse(lines()[0] as string) as { hash: string };
			expect(JSON.parse(readFileSync(metaPath(), "utf-8"))).toEqual({
				lastHash: event1.hash,
				sequence: 1,
			});
			await w.appendEvent(input(3));
		} finally {
			w.release();
		}
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});
});

describe("the roll-forward syncs the log BEFORE its anchor records it", () => {
	it("a failed log fsync during the roll-forward refuses the append and leaves the anchor where it was", async () => {
		const w = createAuditWriter(root);
		try {
			await w.appendEvent(input(1));
			fault.anchorWritesToFail.add(2);
			expect(message(await outcome(w.appendEvent(input(2))))).toMatch(/EACCES/);
			const anchor = readFileSync(metaPath());
			const log = readFileSync(logPath());
			fault.failNextLogFsync = true;
			expect(message(await outcome(w.appendEvent(input(3))))).toMatch(/EIO/);
			expect(readFileSync(metaPath()), "the anchor is untouched").toEqual(anchor);
			expect(readFileSync(logPath()), "nothing appended").toEqual(log);
		} finally {
			w.release();
		}
	});
});

describe("every refused state writes nothing and creates nothing", () => {
	it("LOG_NOT_REGULAR: a symlink, a dangling symlink, a directory, a FIFO (bounded: never blocks)", async () => {
		for (const make of [
			() => {
				writeFileSync(join(root, "elsewhere.jsonl"), "");
				symlinkSync(join(root, "elsewhere.jsonl"), logPath());
			},
			() => symlinkSync(join(root, "nowhere.jsonl"), logPath()),
			() => mkdirSync(logPath()),
			() => execFileSync("mkfifo", [logPath()]),
		]) {
			mkdirSync(auditDir(), { recursive: true });
			make();
			const w = createAuditWriter(root);
			try {
				await expectRefused(w, "LOG_NOT_REGULAR");
			} finally {
				w.release();
			}
			rmSync(join(root, VAULT_DIR), { recursive: true, force: true });
		}
	});

	it("ANCHOR_UNREADABLE: not JSON, a symlink, a FIFO, and never followed or replaced", async () => {
		for (const make of [
			() => writeFileSync(metaPath(), "not json"),
			() => {
				writeFileSync(join(root, "real.meta"), readFileSync(metaPath()));
				rmSync(metaPath());
				symlinkSync(join(root, "real.meta"), metaPath());
			},
			() => {
				rmSync(metaPath());
				execFileSync("mkfifo", [metaPath()]);
			},
		]) {
			await vaultOf(2);
			make();
			const w = createAuditWriter(root);
			try {
				await expectRefused(w, "ANCHOR_UNREADABLE");
			} finally {
				w.release();
			}
			rmSync(join(root, VAULT_DIR), { recursive: true, force: true });
			rmSync(join(root, "real.meta"), { force: true });
		}
	});

	it("INVENTORY_UNREADABLE: audit/quarantine is not a directory", async () => {
		await vaultOf(1);
		writeFileSync(join(auditDir(), "quarantine"), "");
		const w = createAuditWriter(root);
		try {
			await expectRefused(w, "INVENTORY_UNREADABLE");
		} finally {
			w.release();
		}
	});

	it("RECOVERY_PENDING: a recovery's intent is present", async () => {
		await vaultOf(1);
		mkdirSync(join(auditDir(), "quarantine"));
		writeFileSync(join(auditDir(), "quarantine", "PENDING"), "{}");
		const w = createAuditWriter(root);
		try {
			await expectRefused(w, "RECOVERY_PENDING");
		} finally {
			w.release();
		}
	});

	it("UNCHAINED_PAST_ANCHOR: a correctly hashed event past the anchor that names another predecessor", async () => {
		await vaultOf(2);
		const body = {
			id: "stray",
			timestamp: "2026-10-12T00:00:00.000Z",
			previousHash: "e".repeat(64),
			kind: "llm_call",
			actor: "local",
			data: {},
			sequence: 3,
		};
		const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
		writeFileSync(
			logPath(),
			`${readFileSync(logPath(), "utf-8")}${canonicalize({ ...body, hash })}\n`,
		);
		const w = createAuditWriter(root);
		try {
			await expectRefused(w, "UNCHAINED_PAST_ANCHOR");
		} finally {
			w.release();
		}
	});

	it("TAIL_MALFORMED: a sequence that is a string, a fraction, or past 2^53", async () => {
		for (const bad of ['"2"', "1.5", String(2 ** 53)]) {
			await vaultOf(2);
			const ls = lines();
			writeFileSync(
				logPath(),
				`${ls[0]}\n${(ls[1] as string).replace('"sequence":2', `"sequence":${bad}`)}\n`,
			);
			const w = createAuditWriter(root);
			try {
				await expectRefused(w, "TAIL_MALFORMED");
			} finally {
				w.release();
			}
			rmSync(join(root, VAULT_DIR), { recursive: true, force: true });
		}
	});

	it("CORRUPT_TAIL: an edited payload, and an event canonicalization refuses (1e400)", async () => {
		for (const edit of [
			(l: string) => l.replace("tx_2", "tx_9"),
			(l: string) => l.replace('"tx_2"', "1e400"),
		]) {
			await vaultOf(2);
			const ls = lines();
			writeFileSync(logPath(), `${ls[0]}\n${edit(ls[1] as string)}\n`);
			const w = createAuditWriter(root);
			try {
				await expectRefused(w, "CORRUPT_TAIL");
			} finally {
				w.release();
			}
			rmSync(join(root, VAULT_DIR), { recursive: true, force: true });
		}
	});

	it("upgrade: a chain of several events with no anchor (deleted, or every write of it failed) is ANCHOR_MISSING, refused", async () => {
		await vaultOf(3);
		rmSync(metaPath());
		const w = createAuditWriter(root);
		try {
			await expectRefused(w, "ANCHOR_MISSING");
		} finally {
			w.release();
		}
	});

	it("an empty log under an anchor that records events, and an absent one: refused, and an absent log is never created", async () => {
		await vaultOf(2);
		writeFileSync(logPath(), "");
		let w = createAuditWriter(root);
		try {
			await expectRefused(w, "LOG_EMPTY_ANCHOR_RECORDS_EVENTS");
		} finally {
			w.release();
		}
		rmSync(logPath());
		w = createAuditWriter(root);
		try {
			await expectRefused(w, "LOG_EMPTY_ANCHOR_RECORDS_EVENTS");
		} finally {
			w.release();
		}
		expect(existsSync(logPath()), "not created").toBe(false);
	});
});

describe("a recovery in progress, and an event no one can hash, in the other readers", () => {
	it("quarantine-tail refuses a vault whose recovery intent is present, and changes nothing", async () => {
		await vaultOf(2);
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}{"torn`);
		mkdirSync(join(auditDir(), "quarantine"));
		writeFileSync(join(auditDir(), "quarantine", "PENDING"), "{}");
		const before = files();
		expect(message(await outcome(quarantineTornTail(root)))).toMatch(/recovery was interrupted/);
		expect(files()).toEqual(before);
	});

	it("verify is total: an event in the MIDDLE whose canonical form cannot be computed is an error at that event, never a throw", async () => {
		await vaultOf(3);
		const ls = lines();
		writeFileSync(
			logPath(),
			`${ls[0]}\n${(ls[1] as string).replace('"tx_2"', "1e400")}\n${ls[2]}\n`,
		);
		let verdict: ReturnType<typeof verifyVault> | undefined;
		expect(() => {
			verdict = verifyVault(join(root, VAULT_DIR));
		}).not.toThrow();
		expect(verdict?.valid).toBe(false);
		expect(verdict?.errors.join(" ")).toMatch(/Event 2 \(.*\): unhashable/);
	});
});

describe("one rule for every line, in every reader", () => {
	/** A legacy chain: events written before `sequence`, each at its line, hashed as the writer hashed them. */
	function legacyChain(n: number): string[] {
		const out: string[] = [];
		let prev = "0".repeat(64);
		for (let i = 1; i <= n; i++) {
			const body = {
				id: `legacy-${i}`,
				timestamp: "2026-08-14T00:00:00.000Z",
				previousHash: prev,
				kind: "llm_call",
				actor: "local",
				data: { n: i },
			};
			const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
			out.push(canonicalize({ ...body, hash }));
			prev = hash;
		}
		return out;
	}
	const legacyAnchor = (ls: string[]) =>
		JSON.stringify({
			lastHash: (JSON.parse(ls.at(-1) as string) as { hash: string }).hash,
			sequence: ls.length,
		});

	it("verify: a line that is JSON but not an event (null), in the MIDDLE of a valid chain, is an error at that line", async () => {
		await vaultOf(3);
		const ls = lines();
		writeFileSync(logPath(), `${ls[0]}\nnull\n${ls[1]}\n${ls[2]}\n`);
		const verdict = verifyVault(join(root, VAULT_DIR));
		expect(verdict.valid).toBe(false);
		expect(verdict.errors).toContain("not an audit event (events.jsonl:2)");
	});

	it("verify: every present sequence is its position, in a legacy chain as in any other", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const ls = legacyChain(3);
		// A sequence on the third event that is not its position: hashed with it, so only the rule catches it.
		const third = JSON.parse(ls[2] as string) as Record<string, unknown>;
		const { hash: _h, ...body } = { ...third, sequence: 7 } as Record<string, unknown>;
		const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
		const forged = [ls[0], ls[1], canonicalize({ ...body, hash })] as string[];
		writeFileSync(logPath(), `${forged.join("\n")}\n`);
		writeFileSync(metaPath(), legacyAnchor(forged));
		const verdict = verifyVault(join(root, VAULT_DIR));
		expect(verdict.valid).toBe(false);
		expect(verdict.errors.join(" ")).toMatch(/sequence 7 is not its position 3/);
	});

	it("CONTROL and quarantine: a legacy chain verifies at its positions, and quarantine-tail repairs its torn fragment", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const ls = legacyChain(3);
		writeFileSync(logPath(), `${ls.join("\n")}\n`);
		writeFileSync(metaPath(), legacyAnchor(ls));
		expect(verifyVault(join(root, VAULT_DIR)).valid).toBe(true);
		writeFileSync(logPath(), `${ls.join("\n")}\n{"torn`);
		const r = await outcome(quarantineTornTail(root));
		expect(r).not.toBeInstanceOf(Error);
		expect((r as { torn: unknown }).torn).not.toBeNull();
		expect(verifyVault(join(root, VAULT_DIR)).valid).toBe(true);
	});

	it("a legacy tail at the end of a log over the bound a whole log is read within: TAIL_OVERSIZE, and the log is never counted through", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const ls = legacyChain(2);
		// A sparse log: 1 GiB that stores nothing, then a newline and a legacy chain's two lines. The tail read
		// backward is legacy, so only a count of every line could place it, and no verifier reads a log this size.
		const GIB = 1024 * 1024 * 1024;
		const fd = openSync(logPath(), "w");
		try {
			ftruncateSync(fd, GIB);
			writeSync(fd, `\n${ls.join("\n")}\n`, GIB);
		} finally {
			closeSync(fd);
		}
		writeFileSync(metaPath(), legacyAnchor(ls));
		const size = statSync(logPath()).size;
		const meta = readFileSync(metaPath(), "utf-8");
		const w = createAuditWriter(root);
		let refused: unknown;
		try {
			refused = await outcome(w.appendEvent(input(9)));
		} finally {
			w.release();
		}
		expect(refused).toBeInstanceOf(AuditTailMismatchError);
		expect((refused as InstanceType<typeof AuditTailMismatchError>).state).toBe("TAIL_OVERSIZE");
		// Nothing written (the log is compared by size: reading it whole is what this row forbids).
		expect(statSync(logPath()).size).toBe(size);
		expect(readFileSync(metaPath(), "utf-8")).toBe(meta);
		expect(deadLetters()).toHaveLength(1);
	});

	it("beside a legacy last line near the count's bound: an event that would take the log past it is refused, one that fits goes on, and the vault stays appendable", async () => {
		mkdirSync(auditDir(), { recursive: true });
		const ls = legacyChain(2);
		// A sparse log 600 bytes under 1 GiB: a line of nothing, then the legacy chain's two lines, its last
		// at position 3 (the count's), which the anchor records.
		const GIB = 1024 * 1024 * 1024;
		const tailText = `\n${ls.join("\n")}\n`;
		const fd = openSync(logPath(), "w");
		try {
			ftruncateSync(fd, GIB - 600 - Buffer.byteLength(tailText));
			writeSync(fd, tailText, GIB - 600 - Buffer.byteLength(tailText));
		} finally {
			closeSync(fd);
		}
		const last = JSON.parse(ls[1] as string) as { hash: string };
		writeFileSync(metaPath(), JSON.stringify({ lastHash: last.hash, sequence: 3 }));
		expect(statSync(logPath()).size).toBe(GIB - 600);
		const w = createAuditWriter(root);
		let over: unknown;
		let fits: unknown;
		let next: unknown;
		try {
			over = await outcome(
				w.appendEvent({
					kind: "tool_use",
					actor: "local",
					data: { transferId: "tx_over", pad: "x".repeat(1024) },
				}),
			);
			expect(statSync(logPath()).size, "nothing written").toBe(GIB - 600);
			fits = await outcome(w.appendEvent(input(4)));
			// The legacy line is still one of the last two, so this append counts the log: it is within the bound.
			next = await outcome(w.appendEvent(input(5)));
		} finally {
			w.release();
		}
		expect(message(over)).toMatch(/over the 1073741824-byte bound its lines are counted within/);
		expect(fits).toBe("resolved");
		expect(next).toBe("resolved");
		expect(deadLetters()).toHaveLength(1);
	});
});

describe("a FRESH vault goes on, whether its log is absent or an empty file", () => {
	it("absent: created exclusively, owner-only, with the first event", async () => {
		const w = createAuditWriter(root);
		try {
			const e = (await w.appendEvent(input(1))) as unknown as { sequence: number };
			expect(e.sequence).toBe(1);
		} finally {
			w.release();
		}
		expect(lines()).toHaveLength(1);
	});

	it("an existing empty file (quarantine leaves one after cutting a torn first event): reused", async () => {
		mkdirSync(auditDir(), { recursive: true });
		writeFileSync(logPath(), "");
		const w = createAuditWriter(root);
		try {
			await w.appendEvent(input(1));
		} finally {
			w.release();
		}
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 1 });
	});
});

describe("bytes after the last newline, by kind", () => {
	async function tornWith(trailing: string): Promise<InstanceType<typeof AuditTornTailError>> {
		await vaultOf(2);
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${trailing}`);
		const before = files();
		const w = createAuditWriter(root);
		try {
			const err = await w.appendEvent(input(9)).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(AuditTornTailError);
			expect(files(), "nothing appended after them").toEqual(before);
			return err as InstanceType<typeof AuditTornTailError>;
		} finally {
			w.release();
		}
	}

	it("a fragment over MATCH: refused by the writer, then moved aside by quarantine-tail", async () => {
		const err = await tornWith('{"kind":"llm');
		expect(err).toMatchObject({ kind: "fragment", state: "MATCH" });
		expect(err.message).toMatch(/quarantine-tail/);
		await quarantineTornTail(root);
		expect(verifyVault(join(root, VAULT_DIR)).valid).toBe(true);
	});

	it("JSON that is not an event (null): refused by the writer, and by quarantine (not a torn write)", async () => {
		const err = await tornWith("null");
		expect(err.kind).toBe("non_event");
		expect(err.message).not.toMatch(/Run `usertrust audit quarantine-tail`/);
		expect(message(await outcome(quarantineTornTail(root)))).toMatch(/not a torn write/);
	});

	it("a whole event without its newline: refused by the writer, by quarantine, and by verify", async () => {
		await vaultOf(2);
		const head = JSON.parse(lines()[1] as string) as { hash: string };
		const body = {
			id: "x",
			timestamp: "2026-10-12T00:00:00.000Z",
			previousHash: head.hash,
			kind: "llm_call",
			actor: "local",
			data: {},
			sequence: 3,
		};
		const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
		rmSync(join(root, VAULT_DIR), { recursive: true, force: true });
		const err = await tornWith(canonicalize({ ...body, previousHash: "0".repeat(64), hash }));
		expect(err.kind).toBe("unterminated_event");
		expect(message(await outcome(quarantineTornTail(root)))).toMatch(/not a torn write/);
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: false });
	});
});

describe("the writer's own limits: a line it could not read back, a new log's directory entry, a failed read", () => {
	it("an event whose line is over the bound for one event is refused before anything is written: never a tail the writer would refuse", async () => {
		await vaultOf(1);
		// Compared by digest: a 16 MiB buffer in an assertion's diff would exhaust the heap.
		const digestOf = () =>
			Object.fromEntries(
				Object.entries(files()).map(([k, v]) => [
					k,
					v instanceof Buffer ? createHash("sha256").update(v).digest("hex") : v,
				]),
			);
		const before = digestOf();
		const big = "x".repeat(16 * 1024 * 1024);
		const w = createAuditWriter(root);
		let refused: unknown;
		try {
			refused = await outcome(
				w.appendEvent({ kind: "tool_use", actor: "local", data: { transferId: "tx_big", big } }),
			);
			expect(digestOf(), "nothing written").toEqual(before);
			// The next ordinary append goes on: the tail is still one the writer reads.
			await w.appendEvent(input(2));
		} finally {
			w.release();
		}
		expect(refused).toBeInstanceOf(Error);
		expect(message(refused)).toMatch(
			/over the 16777216-byte bound for one event \(this event was not written\)/,
		);
		expect(deadLetters()).toHaveLength(1);
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 2 });
	});

	const MIB = 1024 * 1024;
	/** The vault's files by digest: a buffer of tens of MiB in an assertion's diff would exhaust the heap. */
	const digests = () =>
		Object.fromEntries(
			Object.entries(files()).map(([k, v]) => [
				k,
				v instanceof Buffer ? createHash("sha256").update(v).digest("hex") : v,
			]),
		);

	/**
	 * A legacy vault: one event, then one an older writer left over the bound for one event (`pad` bytes of
	 * filler), correctly chained and anchored, so its tail is MATCH. Returns that last line's length.
	 */
	async function legacyBigTail(pad: number): Promise<number> {
		await vaultOf(1);
		const first = JSON.parse(lines()[0] as string) as { hash: string };
		const body = {
			id: "legacy-big",
			timestamp: "2026-10-01T00:00:00.000Z",
			previousHash: first.hash,
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_legacy", pad: "x".repeat(pad) },
			sequence: 2,
		};
		const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
		const line = canonicalize({ ...body, hash });
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${line}\n`);
		writeFileSync(metaPath(), JSON.stringify({ lastHash: hash, sequence: 2 }));
		return Buffer.byteLength(line);
	}

	const padded = (transferId: string, pad: number) => ({
		kind: "tool_use",
		actor: "local",
		data: { transferId, pad: "x".repeat(pad) },
	});

	it("a legacy last line over the bound for one event: an event that would leave a tail over the read bound is refused, a 1 KiB one goes on, and the vault stays appendable", async () => {
		await legacyBigTail(50 * MIB);
		const before = digests();
		const w = createAuditWriter(root);
		let refused: unknown;
		try {
			// 15 MiB is within the bound for one event, but with the 50 MiB line before it the tail is not
			// one the next append (or pre-flight) could read: TAIL_OVERSIZE, for good, for every event.
			refused = await outcome(w.appendEvent(padded("tx_15m", 15 * MIB)));
			expect(digests(), "nothing written").toEqual(before);
			await w.appendEvent(padded("tx_1k", 1024));
			await w.appendEvent(input(4));
		} finally {
			w.release();
		}
		expect(refused).toBeInstanceOf(Error);
		expect(message(refused)).toMatch(
			/over the 67108864-byte bound they are read within \(this event was not written\)/,
		);
		expect(deadLetters()).toHaveLength(1);
		// A writer that opens the vault afresh classifies it, and appends: it stayed appendable.
		const again = createAuditWriter(root);
		try {
			await again.appendEvent(input(5));
		} finally {
			again.release();
		}
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 5 });
	});

	it("the tail bound to the byte: one byte over it is refused; exactly at it is written, and the next append reads that tail", async () => {
		const legacy = await legacyBigTail(50 * MIB);
		// The writer's line for `padded(id, pad)` at sequence 3 is `pad` plus a fixed overhead: measured on a
		// probe vault's third event (the same shape, the same digit counts).
		const probeRoot = mkdtempSync(join(tmpdir(), "tail-writer-probe-"));
		let overhead: number;
		try {
			const probe = createAuditWriter(probeRoot);
			try {
				await probe.appendEvent(input(1));
				await probe.appendEvent(input(2));
				await probe.appendEvent(padded("tx_edge", 10));
			} finally {
				probe.release();
			}
			const probeLines = readFileSync(join(probeRoot, VAULT_DIR, "audit", "events.jsonl"), "utf-8")
				.trim()
				.split("\n");
			overhead = Buffer.byteLength(probeLines[2] as string) - 10;
		} finally {
			rmSync(probeRoot, { recursive: true, force: true });
		}
		// The tail after the append: the legacy line, the new one, and three newlines.
		const atBound = 64 * MIB - 3 - legacy - overhead;
		const w = createAuditWriter(root);
		let over: unknown;
		let at: unknown;
		try {
			over = await outcome(w.appendEvent(padded("tx_edge", atBound + 1)));
			at = await outcome(w.appendEvent(padded("tx_edge", atBound)));
		} finally {
			w.release();
		}
		expect(message(over)).toMatch(/would take 67108865 bytes, over the 67108864-byte bound/);
		expect(at).toBe("resolved");
		expect(Buffer.byteLength(lines()[2] as string)).toBe(64 * MIB - 3 - legacy);
		const next = createAuditWriter(root);
		try {
			expect(await outcome(next.appendEvent(input(4)))).toBe("resolved");
		} finally {
			next.release();
		}
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 4 });
	});

	/** The vault's files and whether `audit/quarantine` exists: what a refused repair must leave as it was. */
	const repairState = () => ({
		...digests(),
		quarantine: existsSync(join(auditDir(), "quarantine")),
	});
	/** `legacyBigTail(pad)`'s line is `pad` plus this many bytes (each row asserts the length it gets). */
	const LEGACY_LINE_OVERHEAD = 304;
	/** The longest last line quarantine-tail keeps a record's room beside: the read bound, less that room and three newlines. */
	const ROOM_EDGE = 64 * MIB - MAX_RECORD_LINE_BYTES - 3;

	it("quarantine-tail on a legacy last line over the read bound, a torn fragment after it: refused in a dry run and a real one before anything is changed, since the writer could not record the cut", async () => {
		const legacy = await legacyBigTail(64 * MIB);
		expect(legacy).toBeGreaterThan(64 * MIB);
		writeFileSync(logPath(), '{"kind":"llm', { flag: "a" });
		const before = repairState();
		const dry = await outcome(quarantineTornTail(root, { dryRun: true }));
		const real = await outcome(quarantineTornTail(root));
		for (const r of [dry, real]) {
			expect(message(r)).toMatch(
				/last lines over the 67108864-byte bound the writer reads them within \(TAIL_OVERSIZE\)/,
			);
		}
		expect(repairState(), "nothing saved, nothing cut").toEqual(before);
		expect(deadLetters()).toHaveLength(0);
	});

	it("quarantine-tail on a legacy line over the read bound BEFORE a small last one, a torn fragment after them: refused before anything is changed, since the writer could not read the cut log", async () => {
		await legacyBigTail(64 * MIB);
		// One small event after it, chained and anchored by hand (the writer refuses to append beside it): the
		// last line leaves room for a record, but the last two are over the bound the writer reads them within.
		const anchor = JSON.parse(readFileSync(metaPath(), "utf-8")) as {
			lastHash: string;
			sequence: number;
		};
		const body = {
			id: "legacy-small",
			timestamp: "2026-10-01T00:00:01.000Z",
			previousHash: anchor.lastHash,
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_after" },
			sequence: anchor.sequence + 1,
		};
		const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
		writeFileSync(logPath(), `${canonicalize({ ...body, hash })}\n{"kind":"llm`, { flag: "a" });
		writeFileSync(metaPath(), JSON.stringify({ lastHash: hash, sequence: body.sequence }));
		const before = repairState();
		const real = await outcome(quarantineTornTail(root));
		expect(message(real)).toMatch(
			/last lines over the 67108864-byte bound the writer reads them within \(TAIL_OVERSIZE\)/,
		);
		expect(repairState(), "nothing saved, nothing cut").toEqual(before);
		expect(deadLetters()).toHaveLength(0);
	});

	it("quarantine-tail on a legacy last line under the read bound with no room beside it for the record of the cut: refused before anything is changed", async () => {
		// A last line 400 bytes under the bound: the cut log is one the writer reads (its last two lines and
		// three newlines fit the bound), but the cut's record, about 500 bytes, would not fit beside it.
		const legacy = await legacyBigTail(64 * MIB - 400 - LEGACY_LINE_OVERHEAD);
		expect(legacy).toBe(64 * MIB - 400);
		expect(legacy + Buffer.byteLength(lines()[0] as string) + 3).toBeLessThanOrEqual(64 * MIB);
		writeFileSync(logPath(), '{"kind":"llm', { flag: "a" });
		const before = repairState();
		const real = await outcome(quarantineTornTail(root));
		expect(message(real)).toMatch(
			new RegExp(
				`last line \\(${legacy} bytes\\) leaves no room for the record of the cut within the 67108864-byte bound`,
			),
		);
		expect(repairState(), "nothing saved, nothing cut").toEqual(before);
		expect(deadLetters()).toHaveLength(0);
	});

	it("quarantine-tail on a legacy last line exactly at the edge of the room it keeps for the record: repaired, and its cut recorded", async () => {
		const legacy = await legacyBigTail(ROOM_EDGE - LEGACY_LINE_OVERHEAD);
		expect(legacy).toBe(ROOM_EDGE);
		writeFileSync(logPath(), '{"kind":"llm', { flag: "a" });
		expect(message(await outcome(quarantineTornTail(root)))).toBe("resolved");
		expect(JSON.parse(lines().at(-1) as string)).toMatchObject({
			kind: "audit.quarantine.torn_tail",
			sequence: 3,
		});
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("quarantine-tail on a legacy last line one byte past that edge: refused before anything is changed", async () => {
		const legacy = await legacyBigTail(ROOM_EDGE + 1 - LEGACY_LINE_OVERHEAD);
		expect(legacy).toBe(ROOM_EDGE + 1);
		writeFileSync(logPath(), '{"kind":"llm', { flag: "a" });
		const before = repairState();
		expect(message(await outcome(quarantineTornTail(root)))).toMatch(
			new RegExp(`last line \\(${legacy} bytes\\) leaves no room for the record of the cut`),
		);
		expect(repairState(), "nothing saved, nothing cut").toEqual(before);
		expect(deadLetters()).toHaveLength(0);
	});

	it("CONTROL: quarantine-tail on a 50 MiB legacy last line, a torn fragment after it: repaired, its cut recorded on a line under the room the repair keeps for it", async () => {
		await legacyBigTail(50 * MIB);
		writeFileSync(logPath(), '{"kind":"llm', { flag: "a" });
		expect(message(await outcome(quarantineTornTail(root)))).toBe("resolved");
		const record = lines().at(-1) as string;
		expect(JSON.parse(record)).toMatchObject({ kind: "audit.quarantine.torn_tail", sequence: 3 });
		expect(Buffer.byteLength(record)).toBeLessThan(MAX_RECORD_LINE_BYTES);
		expect(verifyVault(join(root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("a log this append creates is synced into its directory before the event is claimed durable", async () => {
		fault.trace = [];
		await vaultOf(1);
		const trace = fault.trace;
		const created = trace.indexOf("create:log");
		const anchor = trace.indexOf("open:anchor-tmp");
		expect(created, "the log was created by the append").toBeGreaterThanOrEqual(0);
		expect(anchor).toBeGreaterThan(created);
		expect(trace.slice(created, anchor), trace.join(" ")).toContain("fsync:audit-dir");
	});

	it("a new log whose directory sync fails after its event was written: the dead letter names the event, which verify finds on the chain", async () => {
		fault.failDirSyncAfterCreate = true;
		const w = createAuditWriter(root);
		let failed: unknown;
		try {
			failed = await outcome(w.appendEvent(input(1)));
		} finally {
			w.release();
		}
		expect(message(failed)).toMatch(/EIO/);
		const hash = (JSON.parse(lines()[0] as string) as { hash: string }).hash;
		expect(deadLetters()).toHaveLength(1);
		expect(JSON.parse(deadLetters()[0] as string)).toMatchObject({ eventHash: hash });
		// The event is there: the reader counts its dead letter on the chain, never missing.
		const { events } = verifyVaultReading(join(root, VAULT_DIR));
		const byHash = new Map(events.map((e) => [e.hash, e]));
		expect(readChainDeadLetters(join(root, VAULT_DIR), (h) => byHash.get(h))).toMatchObject({
			missing: 0,
			onChain: 1,
		});
	});

	it("a read that fails on the open log is LOG_UNREADABLE, by name, never a raw error", async () => {
		await vaultOf(1);
		const before = files();
		fault.failNextLogFstat = true;
		const w = createAuditWriter(root);
		let refused: unknown;
		try {
			refused = await outcome(w.appendEvent(input(2)));
		} finally {
			w.release();
		}
		expect(refused).toBeInstanceOf(AuditTailMismatchError);
		expect((refused as InstanceType<typeof AuditTailMismatchError>).state).toBe("LOG_UNREADABLE");
		expect(files(), "nothing written").toEqual(before);
	});

	it("the dead-letter queue is opened as the log is: never through a link to a file outside the vault", async () => {
		await vaultOf(2);
		writeFileSync(logPath(), `${lines()[0]}\n`);
		mkdirSync(join(root, VAULT_DIR, "dlq"), { recursive: true });
		const outside = join(root, "outside.jsonl");
		writeFileSync(outside, "");
		symlinkSync(outside, dlqPath());
		const w = createAuditWriter(root);
		try {
			expect(await outcome(w.appendEvent(input(3)))).toBeInstanceOf(AuditTailMismatchError);
		} finally {
			w.release();
		}
		expect(readFileSync(outside, "utf-8"), "nothing written through the link").toBe("");
	});

	it("the dead-letter queue is opened as the log is: never into a FIFO in its place (its reader gets nothing)", async () => {
		await vaultOf(2);
		writeFileSync(logPath(), `${lines()[0]}\n`);
		mkdirSync(join(root, VAULT_DIR, "dlq"), { recursive: true });
		execFileSync("mkfifo", ["-m", "600", dlqPath()]);
		// A reader holds the FIFO open, so a blind open for writing would not block: it would write.
		const reader = openSync(dlqPath(), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		try {
			const w = createAuditWriter(root);
			try {
				expect(await outcome(w.appendEvent(input(3)))).toBeInstanceOf(AuditTailMismatchError);
			} finally {
				w.release();
			}
			const buf = Buffer.alloc(4096);
			let got = 0;
			try {
				got = readSync(reader, buf, 0, buf.length, null);
			} catch (err) {
				// EAGAIN: nothing was written into it.
				expect((err as { code?: string }).code).toBe("EAGAIN");
			}
			expect(got, "nothing written into the FIFO").toBe(0);
		} finally {
			closeSync(reader);
		}
	});
});
