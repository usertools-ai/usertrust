// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Get the pinned TigerBeetle server onto this machine, and prove it is the pinned one BEFORE it can
 * run. The server is a native binary that will hold a user's money record, so nothing here trusts the
 * network:
 *
 *   1. stream the pinned release asset to a temp file BESIDE the destination, hashing as it goes, and
 *      cut the stream the moment it passes the manifest's byte count (so a hostile or broken server
 *      cannot fill the disk);
 *   2. compare the sha256 with the manifest's. A mismatch refuses and removes the temp file: nothing
 *      is ever left at the install path;
 *   3. only after the sha matches, extract the one manifest entry in-process (zip-entry.ts), so the zip
 *      parser only ever sees pinned bytes;
 *   4. write it 0755 next to the destination, run `version` on THAT file, and rename it into place
 *      only if it reports the pinned version.
 *
 * The binary lives in a per-user, versioned directory (never node_modules). `USERTRUST_TB_BINARY` is a
 * way around a blocked network and is version-checked the same way: a binary that reports another
 * version is refused, not run.
 *
 * Native features first (CLAUDE.md rule 10): TigerBeetle, SurrealDB and Pinecone provide no installer,
 * and `tigerbeetle-node` ships the client only, not the server, so this module is what is left to build.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import releaseManifest from "./tigerbeetle-release.json" with { type: "json" };
import { extractZipEntry, ZipEntryError } from "./zip-entry.js";

const execFileAsync = promisify(execFile);

/** No release asset may exceed this, whatever a manifest says (a manifest bug cannot raise the cap). */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** The extracted binary may not exceed this either. */
export const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReleaseAsset {
	/** The file name under `<baseUrl>/<version>/`. */
	file: string;
	/** The one entry to extract: `tigerbeetle`, or `tigerbeetle.exe` on Windows. */
	entry: string;
	/** Lowercase hex sha256 of the downloaded archive. */
	sha256: string;
	/** Exact size of the archive; the download is cut when it passes this. */
	bytes: number;
	/** Exact size of the extracted entry. */
	entryBytes: number;
}

export interface ReleaseManifest {
	version: string;
	baseUrl: string;
	assets: Record<string, ReleaseAsset>;
}

export const MANIFEST: ReleaseManifest = releaseManifest as ReleaseManifest;

export type InstallErrorCode =
	| "unsupported"
	| "download-failed"
	| "too-large"
	| "sha-mismatch"
	| "bad-archive"
	| "version-mismatch"
	| "binary-env-invalid"
	| "install-failed";

/** Every way the install can refuse. `message` names the fix; nothing here ever falls back to a different binary. */
export class TigerBeetleInstallError extends Error {
	readonly code: InstallErrorCode;
	constructor(code: InstallErrorCode, message: string) {
		super(message);
		this.name = "TigerBeetleInstallError";
		this.code = code;
	}
}

const BLOCKED_NETWORK_HINT =
	"If this machine cannot reach github.com (and release-assets.githubusercontent.com, where GitHub serves the file from), download the pinned release " +
	"yourself and point USERTRUST_TB_BINARY at the tigerbeetle binary inside it. In an agent sandbox, re-run the same command with network access approved.";

/** `darwin-arm64`, `linux-x64`, ...; `undefined` for a platform the manifest has no asset for. */
export function platformKey(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	manifest: ReleaseManifest = MANIFEST,
): string | undefined {
	const key = `${platform}-${arch}`;
	return Object.hasOwn(manifest.assets, key) ? key : undefined;
}

/** The per-user, versioned directory the pinned binary installs into. */
export function installDir(
	opts: {
		platform?: NodeJS.Platform;
		env?: NodeJS.ProcessEnv;
		home?: string;
		version?: string;
	} = {},
): string {
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const home = opts.home ?? homedir();
	const version = opts.version ?? MANIFEST.version;
	let root: string;
	if (platform === "darwin") {
		root = join(home, "Library", "Application Support", "usertrust", "tigerbeetle");
	} else if (platform === "win32") {
		const base = env.LOCALAPPDATA;
		root = join(
			base !== undefined && base !== "" ? base : join(home, "AppData", "Local"),
			"usertrust",
			"tigerbeetle",
		);
	} else {
		const xdg = env.XDG_DATA_HOME;
		// the XDG spec says a relative XDG_DATA_HOME is to be ignored
		const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
		root = join(base, "usertrust", "tigerbeetle");
	}
	return join(root, version);
}

export interface InstallOptions {
	manifest?: ReleaseManifest;
	platform?: NodeJS.Platform;
	arch?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Override the download base (tests point it at a local server). Never read from the environment. */
	baseUrl?: string;
	/** Injectable `fetch`. */
	fetch?: typeof fetch;
	/** Overall download budget. */
	timeoutMs?: number;
	/** Run `<binary> version` and return its stdout. Injectable. */
	runVersion?: (binary: string) => Promise<string>;
}

export interface ResolvedBinary {
	path: string;
	version: string;
	source: "env" | "installed" | "downloaded";
}

/** `TigerBeetle version 0.17.9+cc1c06a` -> `0.17.9`; `undefined` for anything else. */
export function parseVersionOutput(stdout: string): string | undefined {
	const m = /^TigerBeetle version (\d+\.\d+\.\d+)(?:\+\S+)?\s*$/m.exec(stdout);
	return m?.[1];
}

async function defaultRunVersion(binary: string): Promise<string> {
	const { stdout } = await execFileAsync(binary, ["version"], {
		timeout: 10_000,
		encoding: "utf8",
	});
	return stdout;
}

async function reportedVersion(
	binary: string,
	run: (b: string) => Promise<string>,
): Promise<string | undefined> {
	try {
		return parseVersionOutput(await run(binary));
	} catch {
		return undefined;
	}
}

function tempBeside(dest: string, tag: string): string {
	return `${dest}.${tag}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		/* a temp file that cannot be removed is not a reason to mask the real error */
	}
}

/** Stream `url` to `tmp`, return the sha256 of what was written. Cut and refuse past `limit` bytes. */
async function download(
	url: string,
	tmp: string,
	limit: number,
	opts: InstallOptions,
): Promise<string> {
	const doFetch = opts.fetch ?? fetch;
	let res: Response;
	try {
		res = await doFetch(url, {
			signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			redirect: "follow",
		});
	} catch (err) {
		throw new TigerBeetleInstallError(
			"download-failed",
			`could not download ${url}: ${(err as Error).message}. ${BLOCKED_NETWORK_HINT}`,
		);
	}
	if (!res.ok || res.body === null) {
		throw new TigerBeetleInstallError(
			"download-failed",
			`downloading ${url} answered HTTP ${res.status}. ${BLOCKED_NETWORK_HINT}`,
		);
	}
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > limit) {
		await res.body.cancel().catch(() => undefined);
		throw new TigerBeetleInstallError(
			"too-large",
			`${url} declares ${declared} bytes, over the ${limit} byte limit for this release; refusing it`,
		);
	}
	const hash = createHash("sha256");
	const file = await open(tmp, "wx", 0o600);
	let received = 0;
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			received += chunk.byteLength;
			if (received > limit) {
				throw new TigerBeetleInstallError(
					"too-large",
					`${url} sent more than the ${limit} bytes this release has; the stream was cut and the file refused`,
				);
			}
			hash.update(chunk);
			await file.write(chunk);
		}
	} catch (err) {
		if (err instanceof TigerBeetleInstallError) throw err;
		throw new TigerBeetleInstallError(
			"download-failed",
			`the download of ${url} broke after ${received} bytes: ${(err as Error).message}. ${BLOCKED_NETWORK_HINT}`,
		);
	} finally {
		await file.close().catch(() => undefined);
	}
	return hash.digest("hex");
}

/**
 * Download, verify and install the pinned server for this platform. Returns the installed path. If the
 * pinned version is already installed and reports itself correctly, nothing is downloaded.
 */
export async function installPinned(opts: InstallOptions = {}): Promise<ResolvedBinary> {
	const manifest = opts.manifest ?? MANIFEST;
	const platform = opts.platform ?? process.platform;
	const key = platformKey(platform, opts.arch ?? process.arch, manifest);
	if (key === undefined) {
		throw new TigerBeetleInstallError(
			"unsupported",
			`no pinned TigerBeetle ${manifest.version} server exists for ${platform}-${opts.arch ?? process.arch}; run in starter mode, or point USERTRUST_TB_BINARY at a ${manifest.version} server you built`,
		);
	}
	const asset = manifest.assets[key] as ReleaseAsset;
	const run = opts.runVersion ?? defaultRunVersion;
	const dir = installDir({
		platform,
		version: manifest.version,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.home !== undefined ? { home: opts.home } : {}),
	});
	const dest = join(dir, asset.entry);

	if (existsSync(dest)) {
		const have = await reportedVersion(dest, run);
		if (have === manifest.version) return { path: dest, version: have, source: "installed" };
		// an installed file that does not report the pinned version is replaced, never run
	}

	const limit = Math.min(asset.bytes, MAX_DOWNLOAD_BYTES);
	const url = `${opts.baseUrl ?? manifest.baseUrl}/${manifest.version}/${asset.file}`;
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		throw new TigerBeetleInstallError(
			"install-failed",
			`cannot create ${dir}: ${(err as Error).message}. Re-run with home-folder write access approved, or set USERTRUST_TB_BINARY.`,
		);
	}

	const archiveTmp = tempBeside(dest, "download");
	const binaryTmp = tempBeside(dest, "extract");
	try {
		const sha = await download(url, archiveTmp, limit, opts);
		if (sha !== asset.sha256) {
			throw new TigerBeetleInstallError(
				"sha-mismatch",
				`the downloaded TigerBeetle ${manifest.version} archive has sha256 ${sha}, not the pinned ${asset.sha256}; it was discarded and nothing was installed`,
			);
		}
		let binary: Buffer;
		try {
			binary = extractZipEntry(
				readFileSync(archiveTmp),
				asset.entry,
				Math.min(asset.entryBytes, MAX_BINARY_BYTES),
			);
		} catch (err) {
			if (err instanceof ZipEntryError)
				throw new TigerBeetleInstallError(
					"bad-archive",
					`the pinned archive is not readable: ${err.message}`,
				);
			throw err;
		}
		if (binary.length !== asset.entryBytes) {
			throw new TigerBeetleInstallError(
				"bad-archive",
				`the extracted ${asset.entry} is ${binary.length} bytes, not the pinned ${asset.entryBytes}`,
			);
		}
		writeFileSync(binaryTmp, binary, { mode: 0o755, flag: "wx" });
		const have = await reportedVersion(binaryTmp, run);
		if (have !== manifest.version) {
			throw new TigerBeetleInstallError(
				"version-mismatch",
				`the extracted server reports ${have ?? "no version"}, not ${manifest.version}; it was discarded`,
			);
		}
		renameSync(binaryTmp, dest);
		return { path: dest, version: manifest.version, source: "downloaded" };
	} finally {
		removeQuietly(archiveTmp);
		removeQuietly(binaryTmp);
	}
}

/**
 * Find the server to run. `USERTRUST_TB_BINARY` wins and is version-checked; then the installed pinned
 * binary; then, only when `download` is true, the verified download. Returns `undefined` when there is
 * none and downloading was not asked for.
 */
export async function resolveBinary(
	opts: InstallOptions & { download?: boolean } = {},
): Promise<ResolvedBinary | undefined> {
	const manifest = opts.manifest ?? MANIFEST;
	const env = opts.env ?? process.env;
	const run = opts.runVersion ?? defaultRunVersion;
	const override = env.USERTRUST_TB_BINARY;
	if (override !== undefined && override !== "") {
		let usable = false;
		try {
			usable = statSync(override).isFile();
		} catch {
			usable = false;
		}
		if (!usable) {
			throw new TigerBeetleInstallError(
				"binary-env-invalid",
				`USERTRUST_TB_BINARY is set to ${override}, which is not a file`,
			);
		}
		const have = await reportedVersion(override, run);
		if (have !== manifest.version) {
			throw new TigerBeetleInstallError(
				"binary-env-invalid",
				`USERTRUST_TB_BINARY (${override}) reports ${have ?? "no TigerBeetle version"}, but this release is pinned to ${manifest.version}`,
			);
		}
		return { path: override, version: have, source: "env" };
	}
	const platform = opts.platform ?? process.platform;
	const key = platformKey(platform, opts.arch ?? process.arch, manifest);
	if (key !== undefined) {
		const asset = manifest.assets[key] as ReleaseAsset;
		const dest = join(
			installDir({
				platform,
				version: manifest.version,
				env,
				...(opts.home !== undefined ? { home: opts.home } : {}),
			}),
			asset.entry,
		);
		if (existsSync(dest)) {
			const have = await reportedVersion(dest, run);
			if (have === manifest.version) return { path: dest, version: have, source: "installed" };
		}
	}
	if (opts.download === true) return installPinned(opts);
	return undefined;
}
