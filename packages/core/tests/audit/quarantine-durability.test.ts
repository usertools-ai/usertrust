import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
const state: { dirFsync: "ok" | "einval"; events: string[] } = { dirFsync: "ok", events: [] };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const fsyncSync = ((fd: number) => {
		const st = fs.fstatSync(fd);
		if (st.isDirectory()) {
			state.events.push(`fsync-dir:${st.ino}`);
			if (state.dirFsync === "einval") {
				throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
			}
		}
		return fs.fsyncSync(fd);
	}) as typeof fs.fsyncSync;
	const ftruncateSync = ((fd: number, len?: number) => {
		state.events.push("truncate");
		return fs.ftruncateSync(fd, len);
	}) as typeof fs.ftruncateSync;
	return { ...fs, fsyncSync, ftruncateSync, default: { ...fs, fsyncSync, ftruncateSync } };
});

const { createAuditWriter } = await import("../../src/audit/chain.js");
const { quarantineTornTail } = await import("../../src/audit/quarantine.js");
const { verifyVault } = await import("../../src/audit/verify.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
afterEach(() => {
	state.dirFsync = "ok";
	state.events = [];
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
});
