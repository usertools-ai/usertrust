import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Quarantine durability, against a mocked `node:fs`. The wrappers RECORD what was synced (by inode,
 * directory or file), each truncation and each rename (by target name), and INJECT one fault at a
 * named boundary:
 *  - `dirFsync`: a directory fsync that is unsupported (EINVAL) or fails (EIO);
 *  - `failEvidenceWrite`: the write of the evidence TEMP file (`quarantine/.<sha256>….tmp`) writes
 *    half and fails ENOSPC — matched by the descriptor's path, so no other write can consume it;
 *  - `failAppendOpen`: the next open of the log for APPEND (a chained record) fails EIO — after the
 *    cut, before its record;
 *  - `failMetaAfterAppend`: the `.meta` temp-file open that FOLLOWS the next log append fails
 *    EACCES — the record's line lands, its anchor update does not;
 *  - `linkLogAt`: when the evidence temp file is opened — after every path check, before the
 *    cut — another name is hard-linked to the log;
 *  - `swapQuarantineAt`: at the repair's first fsync of the log — after the read-only analysis,
 *    before the evidence is written — `quarantine/` is created as a symlink to another directory.
 */
const state = {
	dirFsync: "ok" as "ok" | "einval" | "eio",
	events: [] as string[],
	failEvidenceWrite: false,
	evidenceWriteFailed: false,
	failAppendOpen: false,
	failMetaAfterAppend: false,
	metaArmed: false,
	linkLogAt: undefined as { log: string; other: string } | undefined,
	swapQuarantineAt: undefined as { qDir: string; target: string } | undefined,
};
const EVIDENCE_TMP = /[\\/]quarantine[\\/]\.[0-9a-f]{64}[^\\/]*\.tmp$/;
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const fdPaths = new Map<number, string>();
	const openSync = ((p: unknown, flags?: unknown, mode?: unknown) => {
		const path = String(p);
		const append = typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0;
		if (append && path.endsWith("events.jsonl")) {
			if (state.failAppendOpen) {
				state.failAppendOpen = false;
				throw Object.assign(new Error(`EIO: i/o error, open '${path}'`), { code: "EIO" });
			}
			if (state.failMetaAfterAppend) {
				state.failMetaAfterAppend = false;
				state.metaArmed = true;
			}
		}
		if (state.linkLogAt !== undefined && EVIDENCE_TMP.test(path)) {
			fs.linkSync(state.linkLogAt.log, state.linkLogAt.other);
			state.linkLogAt = undefined;
		}
		if (state.metaArmed && /\.meta\.[0-9a-f-]+\.tmp$/.test(path)) {
			state.metaArmed = false;
			throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
				code: "EACCES",
			});
		}
		const fd = (fs.openSync as (...a: unknown[]) => number)(p, flags, mode);
		fdPaths.set(fd, path);
		return fd;
	}) as typeof fs.openSync;
	const closeSync = ((fd: number) => {
		fdPaths.delete(fd);
		return fs.closeSync(fd);
	}) as typeof fs.closeSync;
	const fsyncSync = ((fd: number) => {
		if (state.swapQuarantineAt !== undefined && (fdPaths.get(fd) ?? "").endsWith("events.jsonl")) {
			fs.symlinkSync(state.swapQuarantineAt.target, state.swapQuarantineAt.qDir);
			state.swapQuarantineAt = undefined;
		}
		const st = fs.fstatSync(fd);
		if (st.isDirectory()) {
			state.events.push(`fsync-dir:${st.ino}`);
			if (state.dirFsync === "einval") {
				throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
			}
			if (state.dirFsync === "eio") {
				throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
			}
		} else {
			state.events.push(`fsync-file:${st.ino}`);
		}
		return fs.fsyncSync(fd);
	}) as typeof fs.fsyncSync;
	const ftruncateSync = ((fd: number, len?: number) => {
		state.events.push("truncate");
		return fs.ftruncateSync(fd, len);
	}) as typeof fs.ftruncateSync;
	const renameSync = ((from: unknown, to: unknown) => {
		state.events.push(`rename:${String(to).split(/[\\/]/).pop()}`);
		return fs.renameSync(from as string, to as string);
	}) as typeof fs.renameSync;
	const writeSync = ((fd: number, ...rest: unknown[]) => {
		if (state.failEvidenceWrite && EVIDENCE_TMP.test(fdPaths.get(fd) ?? "")) {
			state.failEvidenceWrite = false;
			state.evidenceWriteFailed = true;
			const buf = rest[0] as Buffer;
			(fs.writeSync as (...a: unknown[]) => number)(
				fd,
				buf,
				0,
				Math.max(1, Math.floor(buf.length / 2)),
			);
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		}
		return (fs.writeSync as (...a: unknown[]) => number)(fd, ...rest);
	}) as typeof fs.writeSync;
	const wrapped = { openSync, closeSync, fsyncSync, ftruncateSync, renameSync, writeSync };
	return { ...fs, ...wrapped, default: { ...fs, ...wrapped } };
});

const { createAuditWriter, readDurableEventHash } = await import("../../src/audit/chain.js");
const {
	AuditQuarantineInterruptedError,
	AuditQuarantineRefusedError,
	QUARANTINE_EVENT_KIND,
	quarantineTornTail,
} = await import("../../src/audit/quarantine.js");
const { verifyVault } = await import("../../src/audit/verify.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
afterEach(() => {
	state.dirFsync = "ok";
	state.events = [];
	state.failEvidenceWrite = false;
	state.evidenceWriteFailed = false;
	state.failAppendOpen = false;
	state.failMetaAfterAppend = false;
	state.metaArmed = false;
	state.linkLogAt = undefined;
	state.swapQuarantineAt = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const logOf = (v: string) => join(v, VAULT_DIR, "audit", "events.jsonl");
const TORN = '{"id":"half-writ';
const recordsOf = (v: string) =>
	readFileSync(logOf(v), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { kind: string; previousHash: string; sequence: number })
		.filter((e) => e.kind === QUARANTINE_EVENT_KIND);
/** Put the `.meta` anchor ONE BEHIND the log's last complete line (its predecessor). */
function anchorOneBehind(v: string): void {
	const ls = readFileSync(logOf(v), "utf-8").split("\n");
	const complete = ls.slice(0, -1); // the last element is "" or a torn line
	const head = JSON.parse(complete.at(-1) as string) as { previousHash: string; sequence: number };
	writeFileSync(
		`${logOf(v)}.meta`,
		JSON.stringify({ lastHash: head.previousHash, sequence: head.sequence - 1 }),
	);
}

async function tornVault(): Promise<string> {
	const v = mkdtempSync(join(tmpdir(), "trust-qdur-"));
	dirs.push(v);
	const w = createAuditWriter(v);
	for (let i = 0; i < 2; i++) await w.appendEvent({ kind: "t", actor: "sys", data: { i } });
	w.release();
	appendFileSync(join(v, VAULT_DIR, "audit", "events.jsonl"), '{"id":"half-writ');
	return v;
}

describe("#196 r1: quarantine durability", () => {
	it("audit/ (the PARENT of the new quarantine/ entry) is fsync'd BEFORE the log is truncated", async () => {
		const v = await tornVault();
		const auditIno = statSync(join(v, VAULT_DIR, "audit")).ino;
		state.events = [];
		await quarantineTornTail(v);
		const parentSync = state.events.indexOf(`fsync-dir:${auditIno}`);
		const cut = state.events.indexOf("truncate");
		expect(parentSync).toBeGreaterThanOrEqual(0);
		expect(cut).toBeGreaterThan(parentSync);
	});

	it("a filesystem where DIRECTORY fsync is unsupported (EINVAL): recovery still completes and verifies", async () => {
		const v = await tornVault();
		state.dirFsync = "einval";
		const r = await quarantineTornTail(v);
		expect(r.torn).toMatchObject({ length: 16 });
		state.dirFsync = "ok";
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("an EVIDENCE write that fails MID-WAY (ENOSPC) leaves no partial evidence and the log uncut — the retry completes", async () => {
		const v = await tornVault();
		const qDir = join(v, VAULT_DIR, "audit", "quarantine");
		const before = readFileSync(logOf(v));
		state.failEvidenceWrite = true;
		await expect(quarantineTornTail(v)).rejects.toThrow(/ENOSPC/);
		expect(state.evidenceWriteFailed, "the fault hit the evidence temp file").toBe(true);
		// quarantine/ was made (the run reached the evidence write) and holds nothing.
		expect(readdirSync(qDir)).toEqual([]);
		expect(readFileSync(logOf(v)).equals(before), "nothing cut").toBe(true);
		const r = await quarantineTornTail(v);
		expect(r.torn).toMatchObject({ length: 16 });
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("#196 r2 P2: a GENUINE anchor-directory fsync failure (EIO) is NOT swallowed — the append reports it, with its durable hash", async () => {
		const v = mkdtempSync(join(tmpdir(), "trust-qdur-"));
		dirs.push(v);
		const w = createAuditWriter(v);
		state.dirFsync = "eio";
		let caught: unknown;
		try {
			await w.appendEvent({ kind: "t", actor: "sys", data: {} });
		} catch (err) {
			caught = err;
		}
		w.release();
		expect(caught).toBeInstanceOf(Error);
		expect(String((caught as Error).message)).toMatch(/EIO/);
		expect(typeof readDurableEventHash(caught)).toBe("string");
	});

	it("an UNSUPPORTED anchor-directory fsync (EINVAL) stays best effort — the append succeeds", async () => {
		const v = mkdtempSync(join(tmpdir(), "trust-qdur-"));
		dirs.push(v);
		const w = createAuditWriter(v);
		state.dirFsync = "einval";
		await expect(w.appendEvent({ kind: "t", actor: "sys", data: {} })).resolves.toMatchObject({
			sequence: 1,
		});
		w.release();
	});
});

describe("quarantine: every boundary of a repair leaves a state the next run finishes", () => {
	it("each CUT gets its own chained record: identical torn bytes cut again after an earlier cut was recorded, with the second record failing, are recorded by the retry", async () => {
		const v = await tornVault();
		await quarantineTornTail(v); // the first cut, recorded
		const w = createAuditWriter(v);
		await w.appendEvent({ kind: "t", actor: "sys", data: { after: 1 } });
		w.release();
		appendFileSync(logOf(v), TORN); // the SAME torn bytes recur
		state.failAppendOpen = true; // the second cut lands; its record does not
		await expect(quarantineTornTail(v)).rejects.toThrow(/EIO/);
		expect(readFileSync(logOf(v), "utf-8").endsWith("\n"), "the second cut landed").toBe(true);
		expect(recordsOf(v)).toHaveLength(1);
		const r = await quarantineTornTail(v);
		expect(r.recorded).toHaveLength(1);
		expect(recordsOf(v)).toHaveLength(2);
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 5 });
		expect(await quarantineTornTail(v)).toEqual({ dryRun: false, torn: null, recorded: [] });
	});

	it("a ONE-BEHIND anchor is advanced BEFORE the record is appended: a record whose anchor update fails leaves it one behind (never two), and the retry repairs it", async () => {
		const v = await tornVault();
		anchorOneBehind(v);
		state.failMetaAfterAppend = true; // the record's line lands; its .meta update fails
		await expect(quarantineTornTail(v)).rejects.toThrow(/EACCES/);
		expect(recordsOf(v)).toHaveLength(1);
		const r = await quarantineTornTail(v);
		expect(r).toMatchObject({ torn: null, recorded: [], anchorAdvanced: true });
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("an ABSENT anchor (one event) is written BEFORE the record is appended: a record whose anchor update fails leaves it one behind, and the retry repairs it", async () => {
		const v = mkdtempSync(join(tmpdir(), "trust-qdur-"));
		dirs.push(v);
		const w = createAuditWriter(v);
		await w.appendEvent({ kind: "t", actor: "sys", data: { i: 0 } });
		w.release();
		rmSync(`${logOf(v)}.meta`);
		appendFileSync(logOf(v), TORN);
		state.failMetaAfterAppend = true; // the record's line lands; its .meta update fails
		await expect(quarantineTornTail(v)).rejects.toThrow(/EACCES/);
		expect(recordsOf(v)).toHaveLength(1);
		const r = await quarantineTornTail(v);
		expect(r).toMatchObject({ torn: null, recorded: [], anchorAdvanced: true });
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 2 });
	});

	it("the LOG is fsync'd before a recovered head is published to .meta (log before sidecar)", async () => {
		const v = await tornVault();
		writeFileSync(logOf(v), readFileSync(logOf(v), "utf-8").slice(0, -TORN.length)); // no torn tail
		anchorOneBehind(v);
		const logIno = statSync(logOf(v)).ino;
		state.events = [];
		expect(await quarantineTornTail(v)).toMatchObject({ torn: null, anchorAdvanced: true });
		const logSync = state.events.indexOf(`fsync-file:${logIno}`);
		const publish = state.events.indexOf("rename:events.jsonl.meta");
		expect(logSync).toBeGreaterThanOrEqual(0);
		expect(publish).toBeGreaterThan(logSync);
	});

	it("with a torn tail too, the log is fsync'd before the anchor is advanced", async () => {
		const v = await tornVault();
		anchorOneBehind(v);
		const logIno = statSync(logOf(v)).ino;
		state.events = [];
		await quarantineTornTail(v);
		const logSync = state.events.indexOf(`fsync-file:${logIno}`);
		const publish = state.events.indexOf("rename:events.jsonl.meta");
		expect(logSync).toBeGreaterThanOrEqual(0);
		expect(publish).toBeGreaterThan(logSync);
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("a hard link made AFTER the first repair write but before the cut: an INTERRUPTED repair (never 'nothing was changed'), both names uncut; the next run finishes once the link is gone", async () => {
		const v = await tornVault();
		const other = join(v, "events-hardlink-raced");
		const before = readFileSync(logOf(v));
		state.linkLogAt = { log: logOf(v), other };
		const err = await quarantineTornTail(v).catch((e: unknown) => e);
		expect(existsSync(other), "the race was staged").toBe(true);
		expect(err).toBeInstanceOf(AuditQuarantineInterruptedError);
		expect(err).not.toBeInstanceOf(AuditQuarantineRefusedError);
		const message = (err as Error).message;
		expect(message).toMatch(/hard link/);
		expect(message).not.toMatch(/nothing was changed/i);
		expect(message).toMatch(/the torn bytes were saved as quarantine\/[0-9a-f]{64}-\d+\.torn/);
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
		expect(readFileSync(other).equals(before)).toBe(true);
		rmSync(other);
		const r = await quarantineTornTail(v);
		expect(r.torn).toMatchObject({ length: 16 });
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("quarantine/ swapped for a symlink AFTER the analysis is refused when the directory is made: nothing written through it, the log uncut", async () => {
		const v = await tornVault();
		const elsewhere = mkdtempSync(join(tmpdir(), "trust-elsewhere-"));
		dirs.push(elsewhere);
		const before = readFileSync(logOf(v));
		state.swapQuarantineAt = { qDir: join(v, VAULT_DIR, "audit", "quarantine"), target: elsewhere };
		await expect(quarantineTornTail(v)).rejects.toThrow(/not a real directory/);
		expect(state.swapQuarantineAt, "the swap was staged").toBeUndefined();
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
	});
});
