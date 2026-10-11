import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #196 r1 P2s on quarantine durability, against a mocked `node:fs`:
 *  - a DIRECTORY fsync that is unsupported (EINVAL) must not make recovery fail forever;
 *  - the new quarantine/ entry must be durable in its PARENT (audit/) before the log is cut.
 * `fsyncSync` and `ftruncateSync` are wrapped to log what was synced (by inode) and when the
 * truncation happened.
 */
const state: { dirFsync: "ok" | "einval" | "eio"; events: string[]; failNextWrite: boolean } = {
	dirFsync: "ok",
	events: [],
	failNextWrite: false,
};
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const fsyncSync = ((fd: number) => {
		const st = fs.fstatSync(fd);
		if (st.isDirectory()) {
			state.events.push(`fsync-dir:${st.ino}`);
			if (state.dirFsync === "einval") {
				throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
			}
			if (state.dirFsync === "eio") {
				throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
			}
		}
		return fs.fsyncSync(fd);
	}) as typeof fs.fsyncSync;
	const ftruncateSync = ((fd: number, len?: number) => {
		state.events.push("truncate");
		return fs.ftruncateSync(fd, len);
	}) as typeof fs.ftruncateSync;
	const writeSync = ((fd: number, ...rest: unknown[]) => {
		if (state.failNextWrite) {
			state.failNextWrite = false;
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
	return {
		...fs,
		fsyncSync,
		ftruncateSync,
		writeSync,
		default: { ...fs, fsyncSync, ftruncateSync, writeSync },
	};
});

const { createAuditWriter, readDurableEventHash } = await import("../../src/audit/chain.js");
const { quarantineTornTail } = await import("../../src/audit/quarantine.js");
const { verifyVault } = await import("../../src/audit/verify.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
afterEach(() => {
	state.dirFsync = "ok";
	state.events = [];
	state.failNextWrite = false;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

	it("#196 r2 P2: an evidence write that fails MID-WAY (ENOSPC) leaves no partial <sha>.torn — the retry completes", async () => {
		const v = await tornVault();
		const qDir = join(v, VAULT_DIR, "audit", "quarantine");
		state.failNextWrite = true; // the first write of the run is the evidence temp file
		await expect(quarantineTornTail(v)).rejects.toThrow(/ENOSPC/);
		expect(existsSync(qDir) ? readdirSync(qDir) : []).toEqual([]);
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
