// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `installPinned` / `resolveBinary`: the pinned TigerBeetle server is downloaded, its sha256 is
 * checked BEFORE anything is extracted or run, and a refusal leaves nothing at the install path.
 * A local HTTP server serves fixture zips (stored and deflate, entries `tigerbeetle` and
 * `tigerbeetle.exe`), so no test touches the network.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	installDir,
	installPinned,
	MANIFEST,
	parseVersionOutput,
	platformKey,
	type ReleaseManifest,
	resolveBinary,
	type TigerBeetleInstallError,
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

	it("an installed file that reports another version is replaced by a verified download, never run as is", async () => {
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
});

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
