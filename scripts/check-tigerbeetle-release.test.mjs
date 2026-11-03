// The TigerBeetle release digest check (check-tigerbeetle-release.mjs) against a fake GitHub: it fails when ONE sha,
// ONE size or one asset differs, and passes only when all match. Run with
// `node --test scripts/check-tigerbeetle-release.test.mjs`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { checkRelease } from "./check-tigerbeetle-release.mjs";

const execFileP = promisify(execFile);
const real = JSON.parse(
	readFileSync(
		new URL("../packages/core/src/ledger/tigerbeetle-release.json", import.meta.url),
		"utf8",
	),
);

/** A fake `fetch`: the release API answers with `assets`; each asset's download URL answers with `bodies[name]`. */
function fakeFetch(assets, bodies = {}) {
	return async (url) => {
		if (String(url).startsWith("https://api.github.com/"))
			return { ok: true, status: 200, json: async () => ({ assets }) };
		const name = String(url).split("/").pop();
		const body = bodies[name];
		if (body === undefined) return { ok: false, status: 404 };
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () =>
				body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
		};
	};
}

/** The release assets exactly as the manifest describes them. */
function publishedFor(manifest) {
	const seen = new Map();
	for (const a of Object.values(manifest.assets)) {
		seen.set(a.file, {
			name: a.file,
			size: a.bytes,
			digest: `sha256:${a.sha256}`,
			browser_download_url: `https://example.invalid/${a.file}`,
		});
	}
	return [...seen.values()];
}

describe("the shipped manifest", () => {
	test("is internally consistent: platforms sharing a file agree on its sha and size", async () => {
		const r = await checkRelease({ manifest: real, fetchImpl: fakeFetch(publishedFor(real)) });
		assert.deepEqual(r.problems, []);
		assert.equal(r.ok, true);
		assert.equal(r.checked, 4); // five platforms, four distinct files (macOS is one universal zip)
	});
});

describe("checkRelease", () => {
	test("passes when every digest and size match", async () => {
		const r = await checkRelease({ manifest: real, fetchImpl: fakeFetch(publishedFor(real)) });
		assert.equal(r.ok, true);
	});

	test("fails when ONE sha differs, naming the file", async () => {
		const pub = publishedFor(real);
		pub[1] = { ...pub[1], digest: `sha256:${"0".repeat(64)}` };
		const r = await checkRelease({ manifest: real, fetchImpl: fakeFetch(pub) });
		assert.equal(r.ok, false);
		assert.equal(r.problems.length, 1);
		assert.match(r.problems[0], new RegExp(pub[1].name));
	});

	test("fails on a size difference, a missing asset, and platforms that disagree about one file", async () => {
		const pub = publishedFor(real);
		const r1 = await checkRelease({
			manifest: real,
			fetchImpl: fakeFetch(pub.map((a, i) => (i === 0 ? { ...a, size: a.size + 1 } : a))),
		});
		assert.equal(r1.ok, false);
		const r2 = await checkRelease({ manifest: real, fetchImpl: fakeFetch(pub.slice(1)) });
		assert.equal(r2.ok, false);
		assert.match(r2.problems.join("\n"), /not an asset/);
		const split = structuredClone(real);
		split.assets["darwin-x64"].sha256 = "1".repeat(64);
		const r3 = await checkRelease({ manifest: split, fetchImpl: fakeFetch(publishedFor(real)) });
		assert.equal(r3.ok, false);
		assert.match(r3.problems.join("\n"), /disagree/);
	});

	test("fails when GitHub does not answer", async () => {
		const r = await checkRelease({
			manifest: real,
			fetchImpl: async () => ({ ok: false, status: 502 }),
		});
		assert.equal(r.ok, false);
		assert.match(r.problems[0], /502/);
	});

	test("--download hashes the real bytes itself: a wrong download fails even when GitHub's digest field agrees", async () => {
		const body = Buffer.from("not the archive");
		const manifest = {
			version: "0.0.1",
			baseUrl: "x",
			assets: {
				"linux-x64": {
					file: "a.zip",
					entry: "tigerbeetle",
					sha256: createHash("sha256").update(body).digest("hex"),
					bytes: body.length,
					entryBytes: 1,
				},
			},
		};
		const pub = publishedFor(manifest);
		const good = await checkRelease({
			manifest,
			download: true,
			fetchImpl: fakeFetch(pub, { "a.zip": body }),
		});
		assert.equal(good.ok, true);
		const bad = await checkRelease({
			manifest,
			download: true,
			fetchImpl: fakeFetch(pub, { "a.zip": Buffer.from("not the archivf") }),
		});
		assert.equal(bad.ok, false);
		assert.match(bad.problems.join("\n"), /downloaded bytes hash/);
	});
});

// The entry guard compares import.meta.url (percent-encoded) with the path in argv. A raw string compare is false under a path with a space (or on
// Windows), and then the script exits 0 without checking anything. These rows run the real script from a path WITH A SPACE, against a local stub of
// the release API (TB_RELEASE_API_BASE), so they need no network and cannot become a flaky CI dependency.
describe("the script run as a command, from a path with a space", () => {
	const root = mkdtempSync(join(tmpdir(), "tb-release-cli-"));
	const home = join(root, "space dir");
	const copy = (manifest) => {
		mkdirSync(join(home, "scripts"), { recursive: true });
		mkdirSync(join(home, "packages/core/src/ledger"), { recursive: true });
		copyFileSync(
			new URL("./check-tigerbeetle-release.mjs", import.meta.url),
			join(home, "scripts/check-tigerbeetle-release.mjs"),
		);
		writeFileSync(
			join(home, "packages/core/src/ledger/tigerbeetle-release.json"),
			JSON.stringify(manifest),
		);
		return join(home, "scripts/check-tigerbeetle-release.mjs");
	};
	after(() => rmSync(root, { recursive: true, force: true }));

	/** A stub of the release API that publishes exactly the REAL manifest's assets. */
	async function withStub(fn) {
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ assets: publishedFor(real) }));
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		try {
			return await fn(`http://127.0.0.1:${server.address().port}`);
		} finally {
			await new Promise((r) => server.close(r));
		}
	}
	const run = async (script, base) => {
		try {
			const { stdout, stderr } = await execFileP(process.execPath, [script], {
				env: { ...process.env, TB_RELEASE_API_BASE: base },
			});
			return { code: 0, stdout, stderr };
		} catch (err) {
			return { code: err.code, stdout: err.stdout, stderr: err.stderr };
		}
	};

	test("the good manifest exits 0 and says it matched", async () => {
		const script = copy(real);
		assert.match(script, / /);
		await withStub(async (base) => {
			const r = await run(script, base);
			assert.equal(r.code, 0, r.stderr);
			assert.match(r.stdout, /match the manifest/);
		});
	});

	test("a manifest with one wrong sha exits non-zero and prints the problem (the old guard exited 0 silently)", async () => {
		const bad = structuredClone(real);
		bad.assets["linux-x64"].sha256 = "0".repeat(64);
		const script = copy(bad);
		await withStub(async (base) => {
			const r = await run(script, base);
			assert.notEqual(r.code, 0);
			assert.match(r.stderr, /tigerbeetle-x86_64-linux\.zip: manifest sha256/);
			assert.match(r.stderr, /1 problem\(s\)/);
		});
	});

	test("a manifest that cannot be read exits non-zero", async () => {
		const script = copy({ version: "0.0.0-nonexistent", assets: null });
		await withStub(async (base) => {
			const r = await run(script, base);
			assert.notEqual(r.code, 0);
		});
	});
});
