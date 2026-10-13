// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE TARBALL NPM PUBLISHES IS WRITTEN BY THE RELEASE ITSELF. FROM THE BUILD IT TAKES ONLY
 * dist/ BYTES THAT PASS EVERY RULE, AND NOTHING OF THE BUILD TARBALL'S HEADERS.
 *
 * scripts/release-tarball.py is run as the release runs it, on hand-made build tarballs
 * (./tar-fixture.ts). Each refusal row is an otherwise valid tarball with one defect, and
 * asserts the message of the one rule that must refuse it, so removing that rule turns the
 * row red even where another layer would still refuse. What npm makes of the output is read
 * with the npm on this machine's own modules (node-tar and pacote), never a reimplementation.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archive, gz, header, member, pax, paxRaw, readTar, record } from "./tar-fixture.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TOOL = join(ROOT, "scripts/release-tarball.py");
const MTIME = 1_760_000_000;
const MIB = 1024 * 1024;

/** The release commit's root files: what the output's root files must be, byte for byte. */
const BLOBS: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "fixture-pkg", version: "1.2.3", files: ["dist"] }, null, "\t")}\n`,
	"README.md": "# fixture-pkg\n",
	LICENSE: "Apache License 2.0 (fixture)\n",
	NOTICE: "fixture NOTICE\n",
};

/** An otherwise valid build tarball: root members whose CONTENTS differ from the commit's. */
const BASE = (): Buffer[] => [
	member("package/package.json", '{"name":"fixture-pkg","version":"9.9.9","publishConfig":{}}'),
	member("package/README.md", "a README the build wrote\n"),
	member("package/dist/index.js", "export const a = 1;\n"),
	member("package/dist/sub/a.js", "export const b = 2;\n"),
];
const valid = (...extra: Buffer[]): Buffer => gz(archive(...BASE(), ...extra));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "release-tarball-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function assemble(
	input: Buffer | ((path: string) => void),
	blobs: Record<string, string> = BLOBS,
	rootArgs?: (root: string) => string[],
) {
	const root = join(dir, "root");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root);
	let args: string[] = [];
	for (const [name, text] of Object.entries(blobs)) {
		writeFileSync(join(root, name), text);
		args.push("--root", `${name}=${join(root, name)}`);
	}
	if (rootArgs) args = rootArgs(root);
	const inPath = join(dir, "build.tgz");
	const outPath = join(dir, "publish.tgz");
	rmSync(inPath, { force: true });
	if (typeof input === "function") input(inPath);
	else writeFileSync(inPath, input);
	rmSync(outPath, { force: true });
	const r = spawnSync(
		"python3",
		[
			"-I",
			TOOL,
			"assemble",
			"--input",
			inPath,
			"--output",
			outPath,
			"--mtime",
			String(MTIME),
			...args,
		],
		{ encoding: "utf8", timeout: 180_000 },
	);
	let out: Buffer | null = null;
	try {
		out = readFileSync(outPath);
	} catch {
		out = null;
	}
	return { status: r.status, err: r.stderr, stdout: r.stdout, out, outPath };
}

function refused(
	input: Buffer | ((path: string) => void),
	message: string,
	rootArgs?: (root: string) => string[],
): void {
	const r = assemble(input, BLOBS, rootArgs);
	expect(r.err).toContain(message);
	expect(r.status).toBe(1);
	expect(r.out, "nothing is written when the input is refused").toBeNull();
}

/** The npm on this machine: its own node-tar and pacote, the code that reads what we publish. */
const npmRequire = createRequire(
	join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "npm", "package.json"),
);
const nodeTar = npmRequire("tar") as {
	x: (opts: {
		file: string;
		cwd: string;
		sync: true;
		strict: true;
		onwarn: (code: string, message: string) => void;
	}) => void;
};
const pacote = npmRequire("pacote") as {
	manifest: (spec: string, opts: { cache: string }) => Promise<{ name: string; version: string }>;
};

/** Every file node-tar (npm's extractor) writes from <file>, with its bytes. */
function npmExtract(file: string): Record<string, string> {
	const cwd = mkdtempSync(join(dir, "x-"));
	const warnings: string[] = [];
	nodeTar.x({ file, cwd, sync: true, strict: true, onwarn: (c, m) => warnings.push(`${c} ${m}`) });
	expect(warnings).toEqual([]);
	const found: Record<string, string> = {};
	const walk = (d: string): void => {
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			if (statSync(p).isDirectory()) walk(p);
			else found[relative(cwd, p)] = readFileSync(p, "utf8");
		}
	};
	walk(cwd);
	return found;
}

const expectedFiles = (payload: Record<string, string>): Record<string, string> => ({
	...Object.fromEntries(Object.entries(BLOBS).map(([n, t]) => [`package/${n}`, t])),
	...payload,
});
const BASE_PAYLOAD = {
	"package/dist/index.js": "export const a = 1;\n",
	"package/dist/sub/a.js": "export const b = 2;\n",
};

describe("assembly: the positive control", { timeout: 180_000 }, () => {
	it("holds exactly the commit's root files and the build's dist/ bytes, under fixed headers", () => {
		const r = assemble(valid());
		expect(r.err).toBe("");
		expect(r.status).toBe(0);
		const out = r.out as Buffer;
		// The gzip wrapper is fixed: no file name, mtime 0.
		expect(out.subarray(0, 10).toString("hex")).toBe("1f8b08000000000002ff");
		const entries = readTar(out);
		const want = expectedFiles(BASE_PAYLOAD);
		expect(entries.map((e) => e.name)).toEqual(Object.keys(want).sort());
		for (const e of entries) {
			expect(e.data.toString("utf8"), e.name).toBe(want[e.name]);
			expect([e.type, e.mode, e.uid, e.gid, e.uname, e.gname, e.mtime, e.linkname]).toEqual([
				"0",
				0o644,
				0,
				0,
				"",
				"",
				MTIME,
				"",
			]);
			expect(e.magic).toBe("ustar\u000000");
			expect(e.paxKeys).toEqual([]);
		}
		// The root files are the commit's even though the build's differ.
		expect(entries.find((e) => e.name === "package/package.json")?.data.toString()).toBe(
			BLOBS["package.json"],
		);
	});

	it("is deterministic: the same input and commit give the same bytes", () => {
		const a = assemble(valid()).out as Buffer;
		const b = assemble(valid()).out as Buffer;
		expect(a.equals(b)).toBe(true);
	});

	it("npm's own reader extracts exactly the expected files, and reads the commit's manifest", async () => {
		const r = assemble(valid());
		expect(r.status).toBe(0);
		expect(npmExtract(r.outPath)).toEqual(expectedFiles(BASE_PAYLOAD));
		const m = await pacote.manifest(`file:${r.outPath}`, { cache: join(dir, "cache") });
		expect([m.name, m.version]).toEqual(["fixture-pkg", "1.2.3"]);
	});

	it("accepts what `npm pack` really writes (PAX path, mtime and size records included)", () => {
		const pkg = join(dir, "pkg");
		// 169 bytes with no USTAR split, so npm's packer writes it as a PAX path.
		const long = `${"a".repeat(50)}/${"b".repeat(100)}/c.js`;
		mkdirSync(join(pkg, "dist", "a".repeat(50), "b".repeat(100)), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "fixture-pkg",
				version: "1.2.3",
				files: ["dist", "LICENSE", "NOTICE"],
			}),
		);
		for (const n of Object.keys(BLOBS)) {
			if (n !== "package.json") writeFileSync(join(pkg, n), "build copy\n");
		}
		writeFileSync(join(pkg, "dist", "index.js"), "1\n");
		writeFileSync(join(pkg, "dist", long), "2\n");
		const packed = spawnSync(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", dir, "--cache", join(dir, "npm-cache")],
			{ cwd: pkg, encoding: "utf8" },
		);
		expect(packed.status, packed.stderr).toBe(0);
		const input = readFileSync(join(dir, "fixture-pkg-1.2.3.tgz"));
		expect(readTar(input).some((e) => e.paxKeys.includes("path"))).toBe(true);
		const r = assemble(input);
		expect(r.err).toBe("");
		expect(r.status).toBe(0);
		expect(npmExtract(r.outPath)).toEqual(
			expectedFiles({ "package/dist/index.js": "1\n", [`package/dist/${long}`]: "2\n" }),
		);
	});

	it("a name no USTAR header can hold gets a PAX header whose only record is its path", () => {
		const name = `package/dist/${"a".repeat(50)}/${"b".repeat(100)}/${"c".repeat(27)}.js`;
		const r = assemble(valid(pax([["path", name]]), member("package/dist/long", "L")));
		expect(r.err).toBe("");
		expect(r.status).toBe(0);
		const entries = readTar(r.out as Buffer);
		expect(entries.find((e) => e.name === name)?.paxKeys).toEqual(["path"]);
		for (const e of entries) if (e.name !== name) expect(e.paxKeys).toEqual([]);
		expect(npmExtract(r.outPath)[name]).toBe("L");
	});

	it("ships a root file the manifest's files names, from the commit only", () => {
		const blobs = { ...BLOBS, "openclaw.plugin.json": '{"id":"fixture"}\n' };
		const input = valid(member("package/openclaw.plugin.json", '{"id":"from the build"}'));
		const r = assemble(input, blobs);
		expect(r.status).toBe(0);
		expect(npmExtract(r.outPath)["package/openclaw.plugin.json"]).toBe('{"id":"fixture"}\n');
		// Without the manifest naming it, the same member is refused.
		refused(input, "is not a root file this package ships");
	});
});

describe("the PAX comment injection (records hidden in a comment) never reaches npm", {
	timeout: 180_000,
}, () => {
	it("npm reads the commit's package.json and the expected files, nothing the comments say", async () => {
		const evil = JSON.stringify({
			name: "fixture-pkg",
			version: "6.6.6",
			publishConfig: { registry: "https://evil.invalid/" },
		});
		const realManifest = Buffer.byteLength(BLOBS["package.json"] as string);
		// What node-tar would take from these comments if they were copied into the output:
		// dist/a.js renamed to package/package.json, and dist/z.js swallowing the real one.
		const swallow = 1 + 512 + Math.ceil(realManifest / 512) * 512;
		const input = valid(
			pax([["comment", `\n${record("path", "package/package.json").slice(0, -1)}`]]),
			member("package/dist/a.js", evil),
			pax([["comment", `\n${record("size", String(swallow)).slice(0, -1)}`]]),
			member("package/dist/z.js", "z"),
		);
		const r = assemble(input);
		expect(r.err).toBe("");
		expect(r.status).toBe(0);
		const out = r.out as Buffer;
		for (const e of readTar(out)) expect(e.paxKeys, e.name).toEqual([]);
		expect(out.includes("comment=")).toBe(false);
		expect(npmExtract(r.outPath)).toEqual(
			expectedFiles({ ...BASE_PAYLOAD, "package/dist/a.js": evil, "package/dist/z.js": "z" }),
		);
		const m = await pacote.manifest(`file:${r.outPath}`, { cache: join(dir, "cache") });
		expect([m.name, m.version]).toEqual(["fixture-pkg", "1.2.3"]);
	});
});

describe("member types: only regular files and directories", { timeout: 180_000 }, () => {
	const rows: [string, Buffer[], string][] = [
		[
			"a symlink",
			[header("package/dist/link.js", { type: "2", linkname: "index.js" })],
			"is a symbolic link",
		],
		[
			"a hard link",
			[header("package/dist/hard.js", { type: "1", linkname: "package/dist/index.js" })],
			"is a hard link",
		],
		[
			"a hard link, then a link over its target",
			[
				member("package/dist/x.js", "1"),
				header("package/dist/y.js", { type: "1", linkname: "package/dist/x.js" }),
				header("package/dist/x.js", { type: "1", linkname: "package/dist/x.js" }),
			],
			"is a hard link",
		],
		["a FIFO", [header("package/dist/fifo.js", { type: "6" })], "is a FIFO"],
		[
			"a GNU sparse file",
			[member("package/dist/sparse.js", "s", { type: "S" })],
			"is a GNU sparse file",
		],
		[
			"a PAX (1.0) sparse file",
			[
				pax([
					["GNU.sparse.major", "1"],
					["GNU.sparse.minor", "0"],
					["GNU.sparse.name", "package/dist/sparse.js"],
					["GNU.sparse.realsize", "4"],
				]),
				member("package/dist/GNUSparseFile.0/sparse.js", "1\n0\n4\n"),
			],
			"a sparse file (extended header key",
		],
		[
			"a global extended header",
			[pax([["comment", "g"]], { type: "g" })],
			"is a global extended header",
		],
		[
			"a GNU long name",
			[member("././@LongLink", "package/dist/long.js\0", { type: "L" })],
			"is a GNU long name",
		],
		[
			"a PAX linkpath on a file",
			[pax([["linkpath", "package/dist/index.js"]]), member("package/dist/l.js", "l")],
			"the extended header key 'linkpath' is not accepted",
		],
	];
	for (const [what, members, message] of rows) {
		it(`refuses ${what}`, () => refused(valid(...members), message));
	}
});

describe("member names", { timeout: 180_000 }, () => {
	const rows: [string, Buffer, string][] = [
		["an absolute path", member("/package/dist/x.js", "x"), "is outside package/"],
		["a leading ./", member("./package/dist/x.js", "x"), "is outside package/"],
		["a .. component", member("package/dist/../dist/x.js", "x"), "begins or ends with a dot"],
		["a backslash", member("package/dist/a\\b.js", "x"), "is not a permitted name"],
		["a trailing newline", member("package/dist/x.js\n", "x"), "is not a permitted name"],
		["a duplicate", member("package/dist/index.js", "again"), "appears twice"],
		["a duplicate in another case", member("package/dist/INDEX.js", "again"), "appears twice"],
		[
			"a file where a directory is",
			member("package/dist/sub", "x"),
			"is a file and also a directory",
		],
		["dist/.npmignore", member("package/dist/.npmignore", "index.js"), "begins or ends with a dot"],
		[
			"dist/sub/.gitignore",
			member("package/dist/sub/.gitignore", "*"),
			"begins or ends with a dot",
		],
		["dist/.npmrc", member("package/dist/.npmrc", "registry=x"), "begins or ends with a dot"],
		[
			"a nested dist/package.json",
			member("package/dist/package.json", "{}"),
			"which npm or Node treats specially",
		],
		[
			"a nested Package.JSON",
			member("package/dist/sub/Package.JSON", "{}"),
			"which npm or Node treats specially",
		],
		[
			"a node_modules directory",
			member("package/dist/node_modules/x.js", "x"),
			"which npm or Node treats specially",
		],
		[
			"an unknown root member",
			member("package/server.js", "x"),
			"is not a root file this package ships",
		],
		[
			"a root .npmrc",
			member("package/.npmrc", "registry=x"),
			"is not a root file this package ships",
		],
		[
			"a root directory",
			header("package/src/", { type: "5" }),
			"is not a root file this package ships",
		],
	];
	for (const [what, extra, message] of rows) {
		it(`refuses ${what}`, () => refused(valid(extra), message));
	}

	it("refuses a directory below a file", () =>
		refused(
			valid(member("package/dist/f.js", "f"), member("package/dist/f.js/g.js", "g")),
			"which is a file",
		));
});

describe("the caps, each reached alone", { timeout: 180_000 }, () => {
	it("refuses a build tarball over 16 MiB compressed", () => {
		const parts = [0, 1, 2].map((i) =>
			member(`package/dist/r${i}.bin`, randomBytes(Math.ceil((17 * MIB) / 3))),
		);
		const input = valid(...parts);
		expect(input.length).toBeGreaterThan(16 * MIB);
		refused(input, "the build tarball is more than 16777216 bytes");
	});

	it("refuses a tar stream over 64 MiB", () => {
		const input = gz(Buffer.concat([archive(...BASE()), Buffer.alloc(70 * MIB)]));
		refused(input, "decompresses to more than 67108864 bytes");
	});

	it("refuses more than 4096 tar headers", () => {
		const many = Array.from({ length: 4093 }, (_, i) => member(`package/dist/e/${i}.js`, ""));
		refused(valid(...many), "more than 4096 tar headers");
	});

	it("counts extended headers: 2051 files behind 2047 PAX headers are 4098 headers", () => {
		const many = Array.from({ length: 2047 }, (_, i) => [
			pax([["mtime", "1"]]),
			member(`package/dist/e/${i}.js`, ""),
		]).flat();
		refused(valid(...many), "more than 4096 tar headers");
	});

	it("refuses one member over 8 MiB", () => {
		refused(
			valid(member("package/dist/big.bin", Buffer.alloc(8 * MIB + 1))),
			"the cap for one file is 8388608",
		);
	});

	it("refuses members totalling over 48 MiB", () => {
		const parts = Array.from({ length: 7 }, (_, i) =>
			member(`package/dist/t${i}.bin`, Buffer.alloc(7 * MIB)),
		);
		refused(valid(...parts), "the members total more than 50331648 bytes");
	});

	it("refuses a name over 200 bytes", () => {
		const name = `package/dist/${"a".repeat(90)}/${"b".repeat(97)}`;
		expect(Buffer.byteLength(name)).toBe(201);
		refused(
			valid(pax([["path", name]]), member("package/dist/n", "n")),
			"is longer than 200 bytes",
		);
	});

	it("refuses a component over 100 bytes", () => {
		const name = `package/dist/${"c".repeat(101)}`;
		refused(
			valid(pax([["path", name]]), member("package/dist/n", "n")),
			"has a component longer than 100 bytes",
		);
	});

	it("refuses a name more than 16 levels below package/", () => {
		const name = `package/dist/${"d/".repeat(15)}f.js`;
		refused(valid(member(name, "f")), "is more than 16 levels deep");
	});

	it("refuses an extended header over 1024 bytes, before parsing it", () => {
		const records: [string, string][] = [
			["comment", "p".repeat(1000)],
			["path", "package/dist/p.js"],
		];
		expect(Buffer.byteLength(records.map(([k, v]) => record(k, v)).join(""))).toBe(1040);
		refused(
			valid(pax(records), member("package/dist/q.js", "q")),
			"an extended header of 1040 bytes",
		);
	});
});

describe("the gzip and tar framing", { timeout: 180_000 }, () => {
	it("refuses bytes after the gzip stream", () => {
		refused(Buffer.concat([valid(), Buffer.from("trailing")]), "data follows the gzip stream");
	});

	it("refuses a second, concatenated gzip member", () => {
		refused(
			Buffer.concat([valid(), gz(archive(member("package/dist/later.js", "later")))]),
			"data follows the gzip stream",
		);
	});

	it("refuses a corrupt gzip trailer", () => {
		const input = Buffer.from(valid());
		input[input.length - 6] = (input[input.length - 6] ?? 0) ^ 0xff;
		refused(input, "not a valid gzip stream");
	});

	it("refuses a truncated gzip stream", () => {
		const input = valid();
		refused(input.subarray(0, input.length - 20), "the gzip stream is truncated");
	});

	it("refuses data after the end-of-archive marker", () => {
		refused(
			gz(Buffer.concat([archive(...BASE()), Buffer.from("x")])),
			"data follows the end-of-archive marker",
		);
	});

	it("refuses a header with a wrong checksum", () => {
		const bad = member("package/dist/c.js", "c");
		bad[0] = "q".charCodeAt(0);
		refused(valid(bad), "checksum is wrong");
	});
});

describe("the tar headers, read by their own rules", { timeout: 180_000 }, () => {
	const rows: [string, Buffer, string][] = [
		[
			"a GNU (not POSIX ustar) header",
			gz(archive(...BASE(), member("package/dist/g.js", "g", { patch: [[257, "ustar  \0"]] }))),
			"is not POSIX ustar",
		],
		[
			"a size in base-256",
			gz(
				archive(
					...BASE(),
					member("package/dist/b.js", "", { patch: [[124, "\x80\0\0\0\0\0\0\0\0\0\0\0"]] }),
				),
			),
			"uses the base-256 encoding",
		],
		[
			"a size that is not octal",
			gz(archive(...BASE(), member("package/dist/o.js", "", { patch: [[124, "00000000009\0"]] }))),
			"is not an octal number",
		],
		[
			"two extended headers in a row",
			valid(pax([["mtime", "1"]]), pax([["mtime", "1"]]), member("package/dist/t.js", "t")),
			"two extended headers in a row",
		],
		[
			"a PAX size that disagrees with the header",
			valid(pax([["size", "2"]]), member("package/dist/s.js", "s")),
			"the extended header's size disagrees",
		],
		["a directory with a size", valid(member("package/dist/d/", "x", { type: "5" })), "has a size"],
		[
			"no end-of-archive marker",
			gz(Buffer.concat(BASE())),
			"ends without its end-of-archive marker",
		],
		[
			"a half end-of-archive marker",
			gz(
				Buffer.concat([
					...BASE(),
					Buffer.alloc(512),
					member("package/dist/z.js", "z"),
					Buffer.alloc(1024),
				]),
			),
			"the end-of-archive marker is incomplete",
		],
		[
			"an extended header with no member after it",
			gz(Buffer.concat([...BASE(), pax([["mtime", "1"]]), Buffer.alloc(1024)])),
			"an extended header has no member after it",
		],
		[
			"a member running past the end",
			gz(
				Buffer.concat([...BASE(), header("package/dist/t.js", { size: 4096 }), Buffer.alloc(1024)]),
			),
			"runs past the end of the tar stream",
		],
		[
			"an extended header running past the end",
			gz(
				Buffer.concat([
					...BASE(),
					header("PaxHeader/x", { type: "x", size: 900 }),
					Buffer.alloc(512),
				]),
			),
			"an extended header runs past the end",
		],
	];
	for (const [what, input, message] of rows) {
		it(`refuses ${what}`, () => refused(input, message));
	}
});

describe("PAX records, parsed by their lengths", { timeout: 180_000 }, () => {
	const next = member("package/dist/p.js", "p");
	const rows: [string, Buffer, string][] = [
		["a record with no length", paxRaw("x path=package/dist/a.js\n"), "has no valid length"],
		[
			"a record longer than its header",
			paxRaw("99 path=package/dist/a.js\n"),
			"does not end where its length says",
		],
		["a record with no key", paxRaw("6 =ab\n"), "has no key"],
		[
			"a record that is not UTF-8",
			paxRaw(Buffer.concat([Buffer.from("13 comment="), Buffer.from([0xff]), Buffer.from("\n")])),
			"is not valid text",
		],
		[
			"a key given twice",
			pax([
				["path", "package/dist/a.js"],
				["path", "package/dist/b.js"],
			]),
			"the extended header key 'path' appears twice",
		],
		[
			"a size that is not a number",
			pax([["size", "1x"]]),
			"the extended header size is not a number",
		],
	];
	for (const [what, ext, message] of rows) {
		it(`refuses ${what}`, () => refused(valid(ext, next), message));
	}
});

describe("the input file and the arguments", { timeout: 180_000 }, () => {
	it("refuses a build tarball that is a FIFO, without waiting on it", () => {
		refused((p) => {
			expect(spawnSync("mkfifo", [p]).status).toBe(0);
		}, "the build tarball is not a regular file");
	});

	it("refuses a build tarball that is a symlink, without following it", () => {
		const real = join(dir, "real.tgz");
		writeFileSync(real, valid());
		refused((p) => symlinkSync(real, p), "the parser failed");
	});

	it("refuses a root file named dist", () => {
		refused(valid(), "is not <root file name>=<path>", (root) => [
			"--root",
			`package.json=${join(root, "package.json")}`,
			"--root",
			`dist=${join(root, "README.md")}`,
		]);
	});

	it("refuses a root file that is a symlink", () => {
		refused(valid(), "symbolic links", (root) => {
			symlinkSync(join(root, "README.md"), join(root, "linked"));
			return [
				"--root",
				`package.json=${join(root, "package.json")}`,
				"--root",
				`README.md=${join(root, "linked")}`,
			];
		});
	});

	it("refuses root files without package.json", () => {
		refused(valid(), "must include package.json", (root) => [
			"--root",
			`README.md=${join(root, "README.md")}`,
		]);
	});
});
