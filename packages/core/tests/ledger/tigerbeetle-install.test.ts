// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `installPinned` / `resolveBinary`: the pinned TigerBeetle server is downloaded, its sha256 is
 * checked BEFORE anything is extracted or run, and a refusal leaves nothing at the install path.
 * A local HTTP server serves fixture zips (stored and deflate, entries `tigerbeetle` and
 * `tigerbeetle.exe`), so no test touches the network.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	chmodSync,
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installDir,
	installPinned,
	MANIFEST,
	parseVersionOutput,
	platformKey,
	type ReleaseManifest,
	resolveBinary,
	TigerBeetleInstallError,
} from "../../src/ledger/tigerbeetle-install.js";
import { makeZip } from "./fixtures/make-zip.js";

const POSIX = process.platform !== "win32";
const VERSION = "0.17.9";
const script = (version: string) =>
	Buffer.from(`#!/bin/sh\necho "TigerBeetle version ${version}+fixture"\n`);

const servers: Server[] = [];

interface Served {
	baseUrl: string;
	hits: () => number;
}

/** Serve `body` for any `/<version>/<file>` request; `declared` overrides the Content-Length header. */
async function serve(
	body: Buffer,
	opts: { declared?: number; status?: number } = {},
): Promise<Served> {
	let hits = 0;
	const server = createServer((_req, res) => {
		hits++;
		res.statusCode = opts.status ?? 200;
		res.setHeader("content-length", String(opts.declared ?? body.length));
		res.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (addr === null || typeof addr === "string") throw new Error("no port");
	return { baseUrl: `http://127.0.0.1:${addr.port}`, hits: () => hits };
}

/** A manifest whose every platform points at `zip` (with the real sha256 and sizes of the fixture). */
function manifestFor(
	zip: Buffer,
	entry: string,
	entryBytes: number,
	over?: Partial<{ sha256: string; bytes: number }>,
): ReleaseManifest {
	const asset = {
		file: "fixture.zip",
		entry,
		sha256: over?.sha256 ?? createHash("sha256").update(zip).digest("hex"),
		bytes: over?.bytes ?? zip.length,
		entryBytes,
	};
	return {
		version: VERSION,
		baseUrl: "https://example.invalid",
		assets: {
			"darwin-arm64": asset,
			"darwin-x64": asset,
			"linux-arm64": asset,
			"linux-x64": asset,
			"win32-x64": { ...asset, entry: "tigerbeetle.exe" },
		},
	};
}

function home(): string {
	return mkdtempSync(join(tmpdir(), "ut-tb-install-"));
}

afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

describe.skipIf(!POSIX)("installPinned: a verified download", () => {
	it.each(["stored", "deflate"] as const)(
		"a %s archive with the right sha installs, runs `version`, and is reused without a second request",
		async (method) => {
			const bin = script(VERSION);
			const zip = makeZip([{ name: "tigerbeetle", data: bin, method }]);
			const served = await serve(zip);
			const h = home();
			const opts = {
				manifest: manifestFor(zip, "tigerbeetle", bin.length),
				platform: "linux" as const,
				arch: "x64",
				home: h,
				env: {},
				baseUrl: served.baseUrl,
			};
			const first = await installPinned(opts);
			expect(first).toMatchObject({ version: VERSION, source: "downloaded" });
			expect(first.path).toBe(
				join(installDir({ platform: "linux", home: h, env: {} }), "tigerbeetle"),
			);
			expect(statSync(first.path).mode & 0o777).toBe(0o755);
			expect(readdirSync(installDir({ platform: "linux", home: h, env: {} }))).toEqual([
				"tigerbeetle",
			]);
			const second = await installPinned(opts);
			expect(second.source).toBe("installed");
			expect(served.hits()).toBe(1);
		},
	);
});

describe.skipIf(!POSIX)("installPinned: refusals leave nothing at the install path", () => {
	const dirOf = (h: string) => installDir({ platform: "linux", home: h, env: {} });
	const listing = (h: string) => (existsSync(dirOf(h)) ? readdirSync(dirOf(h)) : []);

	it("a one-byte change is refused with sha-mismatch; the same tampered bytes, pinned as if verification passed, DO land (positive control)", async () => {
		const bin = script(VERSION);
		// a zip comment is a harmless place for one byte: the tampered archive is still a valid zip with the same entry
		const good = makeZip([{ name: "tigerbeetle", data: bin }], Buffer.from("AAAA"));
		const tampered = makeZip([{ name: "tigerbeetle", data: bin }], Buffer.from("AAAB"));
		expect(tampered.length).toBe(good.length);
		const served = await serve(tampered);
		const h = home();
		const base = {
			platform: "linux" as const,
			arch: "x64",
			home: h,
			env: {},
			baseUrl: served.baseUrl,
		};

		await expect(
			installPinned({ ...base, manifest: manifestFor(good, "tigerbeetle", bin.length) }),
		).rejects.toMatchObject({ code: "sha-mismatch" });
		expect(listing(h)).toEqual([]);

		// positive control: pin the tampered archive's own sha (verification bypassed) and the same bytes install, so the refusal above is the sha check and nothing else
		const landed = await installPinned({
			...base,
			manifest: manifestFor(tampered, "tigerbeetle", bin.length),
		});
		expect(landed.source).toBe("downloaded");
		expect(existsSync(landed.path)).toBe(true);
	});

	it("a sha-pinned archive that really is tampered at a harmless byte lands only when the pin matches it (control with an intact payload)", async () => {
		const bin = Buffer.concat([script(VERSION), Buffer.from("# padding\n")]);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip);
		const h = home();
		const base = {
			platform: "linux" as const,
			arch: "x64",
			home: h,
			env: {},
			baseUrl: served.baseUrl,
		};
		const wrong = manifestFor(zip, "tigerbeetle", bin.length, { sha256: "0".repeat(64) });
		await expect(installPinned({ ...base, manifest: wrong })).rejects.toMatchObject({
			code: "sha-mismatch",
		});
		expect(listing(h)).toEqual([]);
		const right = await installPinned({
			...base,
			manifest: manifestFor(zip, "tigerbeetle", bin.length),
		});
		expect(existsSync(right.path)).toBe(true);
	});

	it("an oversize stream is cut at the manifest's byte count (too-large) and nothing is left", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const huge = Buffer.concat([zip, Buffer.alloc(200_000, 1)]);
		const served = await serve(huge);
		const h = home();
		await expect(
			installPinned({
				manifest: manifestFor(zip, "tigerbeetle", bin.length),
				platform: "linux",
				arch: "x64",
				home: h,
				env: {},
				baseUrl: served.baseUrl,
			}),
		).rejects.toMatchObject({ code: "too-large" });
		expect(listing(h)).toEqual([]);
	});

	it("a declared Content-Length over the limit is refused before the body is read", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip, { declared: zip.length + 1_000_000 });
		const h = home();
		await expect(
			installPinned({
				manifest: manifestFor(zip, "tigerbeetle", bin.length),
				platform: "linux",
				arch: "x64",
				home: h,
				env: {},
				baseUrl: served.baseUrl,
			}),
		).rejects.toMatchObject({ code: "too-large" });
		expect(listing(h)).toEqual([]);
	});

	it("an extracted server that reports another version is discarded (version-mismatch)", async () => {
		const bin = script("0.17.8");
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip);
		const h = home();
		await expect(
			installPinned({
				manifest: manifestFor(zip, "tigerbeetle", bin.length),
				platform: "linux",
				arch: "x64",
				home: h,
				env: {},
				baseUrl: served.baseUrl,
			}),
		).rejects.toMatchObject({ code: "version-mismatch" });
		expect(listing(h)).toEqual([]);
	});

	it("a pinned archive with no matching entry, or the wrong extracted size, is bad-archive and leaves nothing", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "other", data: bin }]);
		const served = await serve(zip);
		const h = home();
		const base = {
			platform: "linux" as const,
			arch: "x64",
			home: h,
			env: {},
			baseUrl: served.baseUrl,
		};
		await expect(
			installPinned({ ...base, manifest: manifestFor(zip, "tigerbeetle", bin.length) }),
		).rejects.toMatchObject({ code: "bad-archive" });
		const zip2 = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served2 = await serve(zip2);
		await expect(
			installPinned({
				...base,
				baseUrl: served2.baseUrl,
				manifest: manifestFor(zip2, "tigerbeetle", bin.length + 1),
			}),
		).rejects.toMatchObject({ code: "bad-archive" });
		expect(listing(h)).toEqual([]);
	});

	it("an HTTP error and an unreachable network are download-failed, and the message names the way around a blocked network", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip, { status: 404 });
		const h = home();
		const base = {
			manifest: manifestFor(zip, "tigerbeetle", bin.length),
			platform: "linux" as const,
			arch: "x64",
			home: h,
			env: {},
		};
		await expect(installPinned({ ...base, baseUrl: served.baseUrl })).rejects.toMatchObject({
			code: "download-failed",
		});
		const refused = await installPinned({
			...base,
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		}).then(
			() => {
				throw new Error("expected installPinned to refuse");
			},
			(e: unknown) => e as TigerBeetleInstallError,
		);
		expect(refused.code).toBe("download-failed");
		expect(refused.message).toContain("USERTRUST_TB_BINARY");
		expect(refused.message).toContain("release-assets.githubusercontent.com");
		expect(listing(h)).toEqual([]);
	});

	it("an installed file is run once with `version` to check it (trusted on that string, no sha re-check at rest); one that reports another version is replaced by a verified download", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip);
		const h = home();
		const dir = dirOf(h);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "tigerbeetle"), script("0.17.8"), { mode: 0o755 });
		const got = await installPinned({
			manifest: manifestFor(zip, "tigerbeetle", bin.length),
			platform: "linux",
			arch: "x64",
			home: h,
			env: {},
			baseUrl: served.baseUrl,
		});
		expect(got.source).toBe("downloaded");
		expect(served.hits()).toBe(1);
	});

	it("a file-system failure while installing (the destination cannot be replaced) is install-failed with the cause kept, and no temp file is left", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip);
		const h = home();
		const dir = dirOf(h);
		// a NON-EMPTY DIRECTORY where the binary belongs: the verified server cannot be renamed over it
		mkdirSync(join(dir, "tigerbeetle"), { recursive: true });
		writeFileSync(join(dir, "tigerbeetle", "occupant"), "x");
		const refused = await installPinned({
			manifest: manifestFor(zip, "tigerbeetle", bin.length),
			platform: "linux",
			arch: "x64",
			home: h,
			env: {},
			baseUrl: served.baseUrl,
		}).then(
			() => {
				throw new Error("expected installPinned to refuse");
			},
			(e: unknown) => e as TigerBeetleInstallError,
		);
		expect(refused).toBeInstanceOf(TigerBeetleInstallError);
		expect(refused.code).toBe("install-failed");
		expect((refused.cause as NodeJS.ErrnoException).code).toMatch(
			/^(EISDIR|ENOTEMPTY|EEXIST|EPERM|EACCES)$/,
		);
		expect(refused.message).toContain("USERTRUST_TB_BINARY");
		expect(readdirSync(dir)).toEqual(["tigerbeetle"]);
	});
});

describe.skipIf(!POSIX || process.getuid?.() === 0)(
	"installPinned: disk failures while downloading are install-failed, not network errors",
	() => {
		const dirOf = (h: string) => installDir({ platform: "linux", home: h, env: {} });

		it("an existing but unwritable version directory is install-failed with the cause kept, and the message does not blame the network", async () => {
			const bin = script(VERSION);
			const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
			const served = await serve(zip);
			const h = home();
			const dir = dirOf(h);
			mkdirSync(dir, { recursive: true });
			chmodSync(dir, 0o555);
			try {
				const refused = await installPinned({
					manifest: manifestFor(zip, "tigerbeetle", bin.length),
					platform: "linux",
					arch: "x64",
					home: h,
					env: {},
					baseUrl: served.baseUrl,
				}).then(
					() => {
						throw new Error("expected installPinned to refuse");
					},
					(e: unknown) => e as TigerBeetleInstallError,
				);
				expect(refused.code).toBe("install-failed");
				expect((refused.cause as NodeJS.ErrnoException).code).toMatch(/^(EACCES|EPERM)$/);
				expect(refused.message).not.toContain("release-assets.githubusercontent.com");
			} finally {
				chmodSync(dir, 0o755);
			}
			expect(readdirSync(dir)).toEqual([]);
		});

		/** installPinned against a served fixture, with `extra` options; returns the error it refuses with. */
		async function refusedWith(
			extra: Partial<Parameters<typeof installPinned>[0]>,
			h: string,
		): Promise<TigerBeetleInstallError> {
			const bin = script(VERSION);
			const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
			const served = await serve(zip);
			return installPinned({
				manifest: manifestFor(zip, "tigerbeetle", bin.length),
				platform: "linux",
				arch: "x64",
				home: h,
				env: {},
				baseUrl: served.baseUrl,
				...extra,
			}).then(
				() => {
					throw new Error("expected installPinned to refuse");
				},
				(e: unknown) => e as TigerBeetleInstallError,
			);
		}

		it("a write stream that takes PART of the last chunk and then fails (ENOSPC) is install-failed with the cause kept, not download-failed with the blocked-network hint, and the temp file is removed", async () => {
			const h = home();
			const refused = await refusedWith(
				{
					createWriteStream: ((path: string) => {
						const fd = openSync(path, "wx", 0o600);
						return new Writable({
							write(chunk: Buffer, _enc, cb) {
								writeSync(fd, chunk, 0, Math.max(1, Math.floor(chunk.length / 2))); // half of it reaches the disk
								cb(
									Object.assign(new Error("ENOSPC: no space left on device, write"), {
										code: "ENOSPC",
									}),
								);
							},
							destroy(err, cb) {
								try {
									closeSync(fd);
								} catch {
									/* already closed */
								}
								cb(err);
							},
						});
					}) as unknown as typeof createWriteStream,
				},
				h,
			);
			expect(refused.code).toBe("install-failed");
			expect((refused.cause as NodeJS.ErrnoException).code).toBe("ENOSPC");
			expect(refused.message).not.toContain("release-assets.githubusercontent.com");
			expect(readdirSync(dirOf(h))).toEqual([]);
		});

		it("a write that makes NO progress (reports 0 bytes written, no error) is install-failed and leaves nothing: it can never pass for a complete file", async () => {
			const h = home();
			const refused = await refusedWith(
				{
					createWriteStream: ((path: string, o: object) =>
						createWriteStream(path, {
							...o,
							fs: {
								...fs,
								write: (
									_fd: number,
									buf: Buffer,
									_off: number,
									_len: number,
									_pos: unknown,
									cb: (e: null, n: number, b: Buffer) => void,
								) => cb(null, 0, buf),
							},
						} as never)) as unknown as typeof createWriteStream,
				},
				h,
			);
			expect(refused.code).toBe("install-failed");
			expect(refused.message).not.toContain("release-assets.githubusercontent.com");
			expect(readdirSync(dirOf(h))).toEqual([]);
		});

		it("a SHORT write that makes progress is completed natively by the write stream: the install succeeds with every byte on disk", async () => {
			const bin = Buffer.concat([script(VERSION), Buffer.from(`# ${"x".repeat(4000)}\n`)]);
			const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
			const served = await serve(zip);
			const h = home();
			let calls = 0;
			const got = await installPinned({
				manifest: manifestFor(zip, "tigerbeetle", bin.length),
				platform: "linux",
				arch: "x64",
				home: h,
				env: {},
				baseUrl: served.baseUrl,
				createWriteStream: ((path: string, o: object) =>
					createWriteStream(path, {
						...o,
						fs: {
							...fs,
							// every write lands only HALF of what it was given, and reports so
							write: (
								fd: number,
								buf: Buffer,
								off: number,
								len: number,
								pos: number | null,
								cb: (e: Error | null, n: number, b: Buffer) => void,
							) => {
								calls++;
								fs.write(fd, buf, off, Math.max(1, Math.floor(len / 2)), pos, cb);
							},
						},
					} as never)) as unknown as typeof createWriteStream,
			});
			expect(got.source).toBe("downloaded");
			expect(calls).toBeGreaterThan(2);
			expect(readFileSync(got.path).equals(bin)).toBe(true);
		});

		it("the response body is cancelled on every early exit: a non-OK status, a file that cannot be created, and a write error", async () => {
			const stream = () => {
				const state = { cancelled: false };
				const body = new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new Uint8Array([1, 2, 3]));
					},
					cancel() {
						state.cancelled = true;
					},
				});
				return { state, body };
			};
			const bin = script(VERSION);
			const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
			const manifest = manifestFor(zip, "tigerbeetle", bin.length);
			const base = { manifest, platform: "linux" as const, arch: "x64", env: {} };

			const a = stream();
			await expect(
				installPinned({
					...base,
					home: home(),
					fetch: (async () => new Response(a.body, { status: 404 })) as typeof fetch,
				}),
			).rejects.toMatchObject({ code: "download-failed" });
			expect(a.state.cancelled).toBe(true);

			const b = stream();
			await expect(
				installPinned({
					...base,
					home: home(),
					fetch: (async () => new Response(b.body, { status: 200 })) as typeof fetch,
					createWriteStream: ((_p: string, o: object) =>
						createWriteStream(
							"/nonexistent-dir-for-ut-tests/x",
							o as never,
						)) as unknown as typeof createWriteStream,
				}),
			).rejects.toMatchObject({ code: "install-failed" });
			expect(b.state.cancelled).toBe(true);

			const c = stream();
			await expect(
				installPinned({
					...base,
					home: home(),
					fetch: (async () => new Response(c.body, { status: 200 })) as typeof fetch,
					createWriteStream: (() =>
						new Writable({
							write(_chunk, _enc, cb) {
								cb(Object.assign(new Error("EIO"), { code: "EIO" }));
							},
						})) as unknown as typeof createWriteStream,
				}),
			).rejects.toMatchObject({ code: "install-failed" });
			expect(c.state.cancelled).toBe(true);
		});
	},
);

describe("platform map", () => {
	it("covers darwin-x64/arm64, linux-x64/arm64 and win32-x64, and nothing else", () => {
		for (const [p, a] of [
			["darwin", "x64"],
			["darwin", "arm64"],
			["linux", "x64"],
			["linux", "arm64"],
			["win32", "x64"],
		] as const) {
			expect(platformKey(p, a)).toBe(`${p}-${a}`);
		}
		for (const [p, a] of [
			["linux", "ia32"],
			["freebsd", "x64"],
			["win32", "arm64"],
			["darwin", "ppc"],
			["linux", "riscv64"],
		] as const) {
			expect(platformKey(p, a)).toBeUndefined();
		}
	});

	it("installPinned says `unsupported` for anything else, and the windows entry is tigerbeetle.exe", async () => {
		await expect(installPinned({ platform: "freebsd", arch: "x64" })).rejects.toMatchObject({
			code: "unsupported",
		});
		expect(MANIFEST.assets["win32-x64"]?.entry).toBe("tigerbeetle.exe");
		for (const k of ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"])
			expect(MANIFEST.assets[k]?.entry).toBe("tigerbeetle");
	});
});

describe("installDir", () => {
	it("is per-user, versioned, and never inside node_modules", () => {
		expect(installDir({ platform: "darwin", home: "/h", version: "1.2.3" })).toBe(
			"/h/Library/Application Support/usertrust/tigerbeetle/1.2.3",
		);
		expect(installDir({ platform: "linux", home: "/h", env: {}, version: "1.2.3" })).toBe(
			"/h/.local/share/usertrust/tigerbeetle/1.2.3",
		);
		expect(
			installDir({
				platform: "linux",
				home: "/h",
				env: { XDG_DATA_HOME: "/x/data" },
				version: "1.2.3",
			}),
		).toBe("/x/data/usertrust/tigerbeetle/1.2.3");
		expect(
			installDir({
				platform: "linux",
				home: "/h",
				env: { XDG_DATA_HOME: "relative/dir" },
				version: "1.2.3",
			}),
		).toBe("/h/.local/share/usertrust/tigerbeetle/1.2.3");
		expect(
			installDir({
				platform: "win32",
				home: "C:\\h",
				env: { LOCALAPPDATA: "C:\\L" },
				version: "1.2.3",
			}),
		).toContain("usertrust");
		expect(installDir({ platform: "linux", home: "/h", env: {} })).not.toContain("node_modules");
	});
});

describe("parseVersionOutput", () => {
	it("reads the real `tigerbeetle version` line and nothing looser", () => {
		expect(parseVersionOutput("TigerBeetle version 0.17.9+cc1c06a\n")).toBe("0.17.9");
		expect(parseVersionOutput("TigerBeetle version 0.17.9\n")).toBe("0.17.9");
		expect(parseVersionOutput("TigerBeetle version 0.17.9-evil\n")).toBeUndefined();
		expect(parseVersionOutput("something TigerBeetle version 0.17.9\n")).toBeUndefined();
		expect(parseVersionOutput("")).toBeUndefined();
	});
});

describe.skipIf(!POSIX)("resolveBinary", () => {
	const fake = (version: string): string => {
		const dir = mkdtempSync(join(tmpdir(), "ut-tb-bin-"));
		const p = join(dir, "tigerbeetle");
		writeFileSync(p, script(version));
		chmodSync(p, 0o755);
		return p;
	};

	it("USERTRUST_TB_BINARY is used only when it reports the pinned version", async () => {
		const good = await resolveBinary({ env: { USERTRUST_TB_BINARY: fake(VERSION) } });
		expect(good).toMatchObject({ version: VERSION, source: "env" });
		await expect(
			resolveBinary({ env: { USERTRUST_TB_BINARY: fake("0.17.8") } }),
		).rejects.toMatchObject({ code: "binary-env-invalid" });
		await expect(
			resolveBinary({ env: { USERTRUST_TB_BINARY: join(tmpdir(), "no-such-binary-ut") } }),
		).rejects.toMatchObject({ code: "binary-env-invalid" });
		const wrong = await resolveBinary({ env: { USERTRUST_TB_BINARY: fake("0.17.8") } }).then(
			() => {
				throw new Error("expected resolveBinary to refuse");
			},
			(e: unknown) => e as Error,
		);
		expect(wrong.message).toContain("USERTRUST_TB_BINARY");
	});

	it("a bare USERTRUST_TB_BINARY name is resolved against the cwd once: the file that is stat'd is the file whose version is checked and returned, not a PATH decoy", async () => {
		const cwdDir = mkdtempSync(join(tmpdir(), "ut-tb-cwd-"));
		const decoyDir = mkdtempSync(join(tmpdir(), "ut-tb-decoy-"));
		for (const [dir, version] of [
			[cwdDir, VERSION],
			[decoyDir, "0.16.74"],
		] as const) {
			const p = join(dir, "tigerbeetle-bare");
			writeFileSync(p, script(version));
			chmodSync(p, 0o755);
		}
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
		const oldPath = process.env.PATH;
		process.env.PATH = `${decoyDir}:${oldPath ?? ""}`;
		try {
			// the real `version` run (no injected runner), so a PATH search for the bare name would find the decoy and report 0.16.74
			const got = await resolveBinary({ env: { USERTRUST_TB_BINARY: "tigerbeetle-bare" } });
			expect(got).toMatchObject({
				version: VERSION,
				source: "env",
				path: join(cwdDir, "tigerbeetle-bare"),
			});
		} finally {
			process.env.PATH = oldPath;
			cwd.mockRestore();
		}
	});

	it("with nothing installed and download not asked for, there is no binary", async () => {
		expect(
			await resolveBinary({ platform: "linux", arch: "x64", home: home(), env: {} }),
		).toBeUndefined();
	});

	it("finds the installed pinned binary, and downloads only when asked", async () => {
		const bin = script(VERSION);
		const zip = makeZip([{ name: "tigerbeetle", data: bin }]);
		const served = await serve(zip);
		const h = home();
		const opts = {
			manifest: manifestFor(zip, "tigerbeetle", bin.length),
			platform: "linux" as const,
			arch: "x64",
			home: h,
			env: {},
			baseUrl: served.baseUrl,
		};
		expect(await resolveBinary(opts)).toBeUndefined();
		expect(served.hits()).toBe(0);
		expect((await resolveBinary({ ...opts, download: true }))?.source).toBe("downloaded");
		expect((await resolveBinary(opts))?.source).toBe("installed");
		expect(served.hits()).toBe(1);
	});
});
