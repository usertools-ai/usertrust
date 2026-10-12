import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirSyncWarning, writePrivateFileAtomic } from "../../src/shared/private-fs.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("writePrivateFileAtomic", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "private-atomic-"));
	});
	afterEach(() => {
		chmodSync(dir, 0o700);
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	const tmpFiles = () => readdirSync(dir).filter((n) => n.endsWith(".tmp"));

	it("replaces an existing 0644 file with a 0600 file in a new inode, leaving no temp file", () => {
		const path = join(dir, ".env");
		writeFileSync(path, "OLD\n");
		chmodSync(path, 0o644);
		const oldIno = statSync(path).ino;

		writePrivateFileAtomic(path, "NEW\n");

		const st = statSync(path);
		expect(st.mode & 0o777).toBe(0o600);
		expect(st.ino).not.toBe(oldIno);
		expect(readFileSync(path, "utf-8")).toBe("NEW\n");
		expect(tmpFiles()).toEqual([]);
	});

	it("replaces a symbolic link without writing through it", () => {
		const target = join(dir, "target");
		writeFileSync(target, "SENTINEL\n");
		const path = join(dir, ".env");
		symlinkSync(target, path);

		writePrivateFileAtomic(path, "NEW\n");

		expect(lstatSync(path).isSymbolicLink()).toBe(false);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf-8")).toBe("NEW\n");
		expect(readFileSync(target, "utf-8")).toBe("SENTINEL\n");
		expect(tmpFiles()).toEqual([]);
	});

	it("removes its temp file when the rename fails", () => {
		// A non-empty directory at the path: the rename over it fails.
		const path = join(dir, ".env");
		mkdirSync(path);
		writeFileSync(join(path, "inside"), "x");

		expect(() => writePrivateFileAtomic(path, "NEW\n")).toThrow();
		expect(tmpFiles()).toEqual([]);
		expect(readFileSync(join(path, "inside"), "utf-8")).toBe("x");
	});

	it.skipIf(process.getuid?.() === 0)(
		"a directory that cannot be synced after the rename warns, and does not throw",
		() => {
			const path = join(dir, ".env");
			writeFileSync(path, "OLD\n");
			chmodSync(path, 0o644);
			// Write and search, but not read: the temp file's create and the rename succeed,
			// and only the post-rename directory open fails (EACCES).
			chmodSync(dir, 0o300);
			const warnings: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
				warnings.push(String(chunk));
				return true;
			});

			expect(() => writePrivateFileAtomic(path, "NEW\n")).not.toThrow();

			chmodSync(dir, 0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(readFileSync(path, "utf-8")).toBe("NEW\n");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("was replaced");
			expect(warnings[0]).toContain("owner-only");
			expect(warnings[0]).toContain("EACCES");
			expect(tmpFiles()).toEqual([]);
		},
	);
});

describe("dirSyncWarning", () => {
	it("off Windows, says the file is owner-only (mode 600)", () => {
		const text = dirSyncWarning("/v/.usertrust/.env", "EIO");
		expect(text).toBe(
			"usertrust: warning: /v/.usertrust/.env was replaced and is owner-only (mode 600), but its directory could not be synced (EIO), so the new directory entry may not survive a power loss",
		);
	});

	it("on Windows, where usertrust sets no permissions, makes no owner-only claim", () => {
		const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		Object.defineProperty(process, "platform", { ...real, value: "win32" });
		try {
			const text = dirSyncWarning("C:\\v\\.usertrust\\.env", "EPERM");
			expect(text).not.toContain("owner-only");
			expect(text).not.toContain("mode 600");
			expect(text).toBe(
				"usertrust: warning: C:\\v\\.usertrust\\.env was replaced, but its directory could not be synced (EPERM), so the new directory entry may not survive a power loss",
			);
		} finally {
			Object.defineProperty(process, "platform", real);
		}
		expect(process.platform).not.toBe("win32");
	});
});
