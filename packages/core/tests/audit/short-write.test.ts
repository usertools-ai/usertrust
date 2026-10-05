import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #194.1: `writeSync` may write fewer bytes than asked. Modelled by a mocked `writeSync`:
 * `half` writes half of what it is asked each call (progress, so a writer that loops completes);
 * `stall` writes half once and then makes no progress (a full disk).
 */
const mode: { now: "half" | "stall" | null; stalled: boolean } = { now: null, stalled: false };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
		if (mode.now !== null) {
			const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : (data as Buffer);
			const offset = typeof rest[0] === "number" ? rest[0] : 0;
			const length = typeof rest[1] === "number" ? rest[1] : buf.length - offset;
			if (mode.now === "stall" && mode.stalled) return 0;
			const n = Math.max(1, Math.floor(length / 2));
			if (mode.now === "stall") mode.stalled = true;
			return fs.writeSync(fd, buf, offset, Math.min(n, length));
		}
		return (fs.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
	}) as typeof fs.writeSync;
	return { ...fs, writeSync, default: { ...fs, writeSync } };
});

const { AuditTornTailError, createAuditWriter, readDurableEventHash } = await import(
	"../../src/audit/chain.js"
);
const { verifyVault } = await import("../../src/audit/verify.js");
const { quarantineTornTail } = await import("../../src/audit/quarantine.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
afterEach(() => {
	mode.now = null;
	mode.stalled = false;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function vault() {
	const d = mkdtempSync(join(tmpdir(), "trust-short-write-"));
	dirs.push(d);
	return d;
}
const logOf = (v: string) => join(v, VAULT_DIR, "audit", "events.jsonl");

describe("#194.1: an append writes EVERY byte, or fails without claiming durability", () => {
	it("short writes that make progress: the line, and the .meta, land whole — the chain verifies", async () => {
		const v = vault();
		const w = createAuditWriter(v, { lockAtCreate: true });
		mode.now = "half";
		await w.appendEvent({ kind: "test.a", actor: "sys", data: { pad: "x".repeat(300) } });
		await w.appendEvent({ kind: "test.b", actor: "sys", data: {} });
		mode.now = null;
		w.release();
		expect(readFileSync(logOf(v), "utf-8").endsWith("\n")).toBe(true);
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 2 });
	});

	it("a write that STALLS: the append rejects with no durable hash; the next append refuses the torn tail; quarantine repairs it and appends resume on a verifying chain", async () => {
		const v = vault();
		const w = createAuditWriter(v, { lockAtCreate: true });
		await w.appendEvent({ kind: "test.before", actor: "sys", data: {} });
		mode.now = "stall";
		const err = await w
			.appendEvent({ kind: "test.torn", actor: "sys", data: {} })
			.catch((e: unknown) => e);
		mode.now = null;
		expect(err).toBeInstanceOf(Error);
		expect(readDurableEventHash(err), "never claimed durable").toBeUndefined();
		expect(readFileSync(logOf(v), "utf-8").endsWith("\n"), "a torn tail is on disk").toBe(false);
		await expect(
			w.appendEvent({ kind: "test.after", actor: "sys", data: {} }),
		).rejects.toBeInstanceOf(AuditTornTailError);
		w.release();
		const q = await quarantineTornTail(v);
		expect(q.torn).not.toBeNull();
		const w2 = createAuditWriter(v);
		await w2.appendEvent({ kind: "test.after", actor: "sys", data: {} });
		w2.release();
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("#194.3: a lock whose content cannot be written whole is NEVER created (no empty or partial lock file is ever visible)", () => {
		const v = vault();
		const lock = join(v, VAULT_DIR, "audit", ".audit-writer.lock");
		mode.now = "stall";
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow();
		mode.now = null;
		expect(existsSync(lock)).toBe(false);
	});
});
