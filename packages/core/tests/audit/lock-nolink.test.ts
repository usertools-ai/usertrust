import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #196 r1 P3: the writer lock is created by hard link (never visible half-written). On a
 * filesystem without link() (exFAT/FAT, some network and FUSE mounts) the writer must fail
 * CLOSED and SAY WHY — never fall back to the racy O_EXCL-then-write. `linkSync` is mocked to
 * fail the way such a filesystem does.
 */
const state = { code: null as string | null };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const linkSync = ((a: string, b: string) => {
		if (state.code !== null)
			throw Object.assign(new Error(`${state.code}: link`), { code: state.code });
		return fs.linkSync(a, b);
	}) as typeof fs.linkSync;
	return { ...fs, linkSync, default: { ...fs, linkSync } };
});

const { createAuditWriter } = await import("../../src/audit/chain.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
afterEach(() => {
	state.code = null;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("#196 r1 P3: no hard links → the writer fails closed and names the limit", () => {
	for (const code of ["EPERM", "ENOTSUP", "ENOSYS"]) {
		it(`link() → ${code}: refused with the LIMITATIONS message, no lock and no temp file left`, () => {
			const v = mkdtempSync(join(tmpdir(), "trust-nolink-"));
			dirs.push(v);
			mkdirSync(join(v, VAULT_DIR, "audit"), { recursive: true });
			state.code = code;
			expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(
				/does not support hard links .*LIMITATIONS\.md/,
			);
			expect(readdirSync(join(v, VAULT_DIR, "audit"))).toEqual([]);
		});
	}
});
