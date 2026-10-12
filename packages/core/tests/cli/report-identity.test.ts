import { mkdirSync, mkdtempSync, statSync as realStatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/report.js";

// A filesystem with no stable inode (FAT, some network shares) reports ino 0. The mock makes the directory named
// `no-inode` report it, the way such a filesystem would.
const fs = vi.hoisted(() => ({ zeroInoFor: "", realpathThrows: false, tmpWrites: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		// `realpath.native` fails on musl without /proc; nothing the report does needs it
		// Record where the report's temp file is created.
		writeFileSync: ((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string" && path.endsWith(".tmp")) fs.tmpWrites.push(path);
			return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.writeFileSync,
		realpathSync: Object.assign(actual.realpathSync.bind(actual), {
			native: (p: unknown, ...rest: unknown[]) => {
				if (fs.realpathThrows) throw Object.assign(new Error("ENOENT: /proc"), { code: "ENOENT" });
				return (actual.realpathSync.native as (...a: unknown[]) => unknown)(p, ...rest);
			},
		}),
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
		fs.realpathThrows = false;
		fs.tmpWrites.length = 0;
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		process.exitCode = undefined;
	});
	afterEach(() => {
		fs.zeroInoFor = "";
		fs.realpathThrows = false;
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

	it("--tenant-config still reads when realpath.native fails (musl without /proc): the read needs no realpath", async () => {
		await vault();
		const { writeFileSync, symlinkSync } = await import("node:fs");
		mkdirSync(join(dir, "real", "sub"), { recursive: true });
		symlinkSync(join(dir, "real", "sub"), join(dir, "conf-link"));
		writeFileSync(join(dir, "real", "tenant.json"), JSON.stringify({ budget: 777 }));
		fs.realpathThrows = true;
		const out: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		});
		await run(dir, {}, [
			"--week",
			"--end",
			end(),
			"--format",
			"json",
			"--tenant-config",
			"conf-link/../tenant.json",
		]);
		expect(process.exitCode).toBeUndefined();
		expect(
			(JSON.parse(out.join("")) as { budget: { configuredUt: number } }).budget.configuredUt,
		).toBe(777);
	});

	it("the temp file is created where the OS resolves the target: `.usertrust/link/../r.md` never gets a temp file inside the vault", async () => {
		await vault();
		mkdirSync(join(dir, "reports", "sub"), { recursive: true });
		const { symlinkSync } = await import("node:fs");
		symlinkSync(join(dir, "reports", "sub"), join(dir, ".usertrust", "link"));
		await run(dir, {}, ["--week", "--end", end(), "--out", ".usertrust/link/../r.md"]);
		expect(process.exitCode).toBeUndefined();
		expect(fs.tmpWrites).toHaveLength(1);
		// the temp path keeps the user's `link/..` spelling (the OS puts it in reports/); a lexically collapsed one would sit in the vault
		expect(fs.tmpWrites[0]).toContain(`${join(".usertrust", "link")}${"/"}..`);
		expect(realStatSync(join(dir, "reports", "r.md")).isFile()).toBe(true);
	});
});
