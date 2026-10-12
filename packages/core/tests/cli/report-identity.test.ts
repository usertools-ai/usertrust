import { mkdirSync, mkdtempSync, statSync as realStatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/report.js";

// A filesystem with no stable inode (FAT, some network shares) reports ino 0. The mock makes the directory named
// `no-inode` report it, the way such a filesystem would.
const fs = vi.hoisted(() => ({ zeroInoFor: "" }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: ((path: unknown, ...rest: unknown[]) => {
			const st = (actual.statSync as (...a: unknown[]) => { ino: bigint | number })(path, ...rest);
			if (fs.zeroInoFor !== "" && typeof path === "string" && path.endsWith(fs.zeroInoFor)) {
				const zero = (v: bigint | number) => (typeof v === "bigint" ? 0n : 0);
				return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: zero(st.ino) });
			}
			return st;
		}) as typeof actual.statSync,
	};
});

describe("--out on a filesystem with no stable inode is REFUSED, not passed", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "report-ino-"));
		fs.zeroInoFor = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		process.exitCode = undefined;
	});
	afterEach(() => {
		fs.zeroInoFor = "";
		vi.restoreAllMocks();
		process.exitCode = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function vault(): Promise<void> {
		mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
		const w = createAuditWriter(dir);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "t", cost: 1 } });
		w.release();
	}
	const end = () => new Date(Date.now() + 3_600_000).toISOString();

	it("CONTROL: the same --out is allowed when the filesystem reports real inodes", async () => {
		await vault();
		mkdirSync(join(dir, "no-inode"));
		await run(dir, {}, ["--week", "--end", end(), "--out", join(dir, "no-inode", "r.md")]);
		expect(process.exitCode).toBeUndefined();
		expect(realStatSync(join(dir, "no-inode", "r.md")).isFile()).toBe(true);
	});

	it("a destination directory whose inode reads 0 cannot be compared, so the report is refused (exit 2), nothing written", async () => {
		await vault();
		mkdirSync(join(dir, "no-inode"));
		fs.zeroInoFor = "no-inode";
		await run(dir, {}, ["--week", "--end", end(), "--out", join(dir, "no-inode", "r.md")]);
		expect(process.exitCode).toBe(2);
		expect(() => realStatSync(join(dir, "no-inode", "r.md"))).toThrow();
	});
});
