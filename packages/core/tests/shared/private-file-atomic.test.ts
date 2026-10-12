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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePrivateFileAtomic } from "../../src/shared/private-fs.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("writePrivateFileAtomic", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "private-atomic-"));
	});
	afterEach(() => {
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
});
