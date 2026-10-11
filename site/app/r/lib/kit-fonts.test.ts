/**
 * The share card's pinned font loader. CI has no network and this repository
 * carries no brand font, so the success path runs on a woff2 made here from
 * the image renderer's own bundled font (not a brand asset).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
// @ts-expect-error -- wawoff2 ships no type declarations
import compress from "wawoff2/compress";
// @ts-expect-error -- wawoff2 ships no type declarations
import decompress from "wawoff2/decompress";
import { decodeToTtf, KIT_FONTS, loadPinnedFonts, type PinnedFont } from "./kit-fonts";

const require = createRequire(import.meta.url);
const NOTO_TTF = readFileSync(
	require.resolve("next/dist/compiled/@vercel/og/noto-sans-v27-latin-regular.ttf"),
);
const sha384 = (bytes: Uint8Array) =>
	`sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const served = (bytes: Uint8Array, status = 200) =>
	(async () => new Response(bytes.slice().buffer, { status })) as unknown as typeof fetch;

async function woff2Fixture(): Promise<{ bytes: Uint8Array; spec: PinnedFont }> {
	const bytes: Uint8Array = await compress(NOTO_TTF);
	return {
		bytes,
		spec: {
			name: "Test Sans",
			weight: 500,
			url: "https://example.test/font.woff2",
			integrity: sha384(bytes),
		},
	};
}

test("the pins: Usertools Sans 700 and 500 from the kit, each with its sha384", () => {
	assert.deepEqual(
		KIT_FONTS.map((font) => [font.name, font.weight, font.url, font.integrity]),
		[
			[
				"Usertools Sans",
				700,
				"https://usertrust.ai/kit/fonts/UsertoolsSans-Bold.woff2",
				"sha384-4VUXquEEk06VnqIylqcwVD7njxe+rNZQwD7RgWBP/+IwwKIiXL8YGB2yrZ3SDsGE",
			],
			[
				"Usertools Sans",
				500,
				"https://usertrust.ai/kit/fonts/UsertoolsSans-Medium.woff2",
				"sha384-z/JCyQWuIoV/SEkZg8aC0AIH1faMb3TiUwkJculoPF5JlGjx8PJ6LNprEGrO5ECG",
			],
		],
	);
});

test("bytes that match their pin are decoded to a TTF the renderer can read", async () => {
	const { bytes, spec } = await woff2Fixture();
	const fonts = await loadPinnedFonts([spec], served(bytes));
	assert.ok(fonts, "the pinned font loads");
	assert.equal(fonts.length, 1);
	assert.equal(fonts[0]?.name, "Test Sans");
	assert.equal(fonts[0]?.weight, 500);
	const head = new Uint8Array(fonts[0]?.data ?? new ArrayBuffer(0)).slice(0, 4);
	assert.deepEqual([...head], [0, 1, 0, 0], "TrueType magic");
});

test("any other bytes are refused: the card gets no font at all", async () => {
	const { bytes, spec } = await woff2Fixture();
	const tampered = new Uint8Array(bytes);
	tampered[tampered.length - 1] ^= 0xff;
	assert.equal(await loadPinnedFonts([spec], served(tampered)), undefined);
});

test("an unreachable kit, an HTTP error, or a body that is not woff2 yields no font, never a throw", async () => {
	const { spec } = await woff2Fixture();
	const unreachable = (async () => {
		throw new Error("unreachable");
	}) as unknown as typeof fetch;
	assert.equal(await loadPinnedFonts([spec], unreachable), undefined);
	assert.equal(await loadPinnedFonts([spec], served(new Uint8Array(0), 404)), undefined);
	const garbage = new Uint8Array([1, 2, 3, 4]);
	assert.equal(
		await loadPinnedFonts([{ ...spec, integrity: sha384(garbage) }], served(garbage)),
		undefined,
	);
});

test("never a partial set: one font failing drops them all", async () => {
	const { bytes, spec } = await woff2Fixture();
	const other: PinnedFont = { ...spec, weight: 700, url: "https://example.test/bold.woff2" };
	const fetchOne = (async (url: string) =>
		url === spec.url
			? new Response(bytes.slice().buffer)
			: new Response(null, { status: 404 })) as unknown as typeof fetch;
	assert.equal(await loadPinnedFonts([spec, other], fetchOne), undefined);
});

/** A second, DISTINCT valid font: the same face with a different head.fontRevision. */
async function distinctFont(revision: number) {
	const numTables = NOTO_TTF.readUInt16BE(4);
	let head = -1;
	for (let i = 0; i < numTables; i++) {
		const o = 12 + i * 16;
		if (NOTO_TTF.toString("latin1", o, o + 4) === "head") head = NOTO_TTF.readUInt32BE(o + 8);
	}
	const ttf = Buffer.from(NOTO_TTF);
	ttf.writeUInt32BE(revision, head + 4);
	// wawoff2 returns a view into one shared WASM heap; every result is copied before the next call.
	const woff2 = Uint8Array.from(await compress(ttf));
	const decoded = Uint8Array.from(await decompress(woff2));
	return { woff2, decoded };
}

test("two distinct fonts decoded together each come back as their own bytes", async () => {
	// wawoff2.decompress hands back a view into shared WASM memory. Two decodes in flight let the
	// second overwrite the first before its post-await copy ran, so the first font was another
	// font's bytes (or invalid), and getKitFonts() then cached that for the whole server instance.
	const a = await distinctFont(0x00010000);
	const b = await distinctFont(0x00020000);
	assert.notDeepEqual(a.decoded, b.decoded, "fixtures must differ or the test proves nothing");
	const specs: PinnedFont[] = [
		{ name: "A", weight: 700, url: "https://example.test/a.woff2", integrity: sha384(a.woff2) },
		{ name: "B", weight: 500, url: "https://example.test/b.woff2", integrity: sha384(b.woff2) },
	];
	const byUrl = new Map([
		[specs[0]?.url, a.woff2],
		[specs[1]?.url, b.woff2],
	]);
	const fetchBoth = (async (url: string) =>
		new Response(Uint8Array.from(byUrl.get(url) as Uint8Array), {
			status: 200,
		})) as unknown as typeof fetch;

	const fonts = await loadPinnedFonts(specs, fetchBoth);
	assert.ok(fonts, "both fonts load");
	assert.deepEqual(new Uint8Array(fonts[0]?.data as ArrayBuffer), a.decoded);
	assert.deepEqual(new Uint8Array(fonts[1]?.data as ArrayBuffer), b.decoded);
});

test("a font that fails to decode does not wedge the next load", async () => {
	// The pin matches but the bytes are not woff2, so the decode itself rejects. The serialising
	// chain must carry on: a chain that stayed rejected would fail every later card for the process.
	const junk = new TextEncoder().encode("not a woff2 file at all, but pinned");
	const bad: PinnedFont = {
		name: "Bad",
		weight: 500,
		url: "https://example.test/bad.woff2",
		integrity: sha384(junk),
	};
	assert.equal(await loadPinnedFonts([bad], served(junk)), undefined);
	const { bytes, spec } = await woff2Fixture();
	const fonts = await loadPinnedFonts([spec], served(bytes));
	assert.ok(fonts, "the next load still works");
});

const NEVER = () => new Promise<Uint8Array>(() => {});

test("a decode that never settles is abandoned: it rejects after the timeout, and the queue is released", { timeout: 8000 }, async () => {
	const started = Date.now();
	await assert.rejects(decodeToTtf(new Uint8Array([1]), 40, NEVER), /timed out/);
	assert.ok(Date.now() - started < 3000, "bounded by the timeout, not by the decode");
	// The stuck decode must not hold the chain: the next font still decodes.
	const { bytes } = await woff2Fixture();
	const ttf = await decodeToTtf(bytes);
	assert.ok(ttf.byteLength > 0, "the next decode runs after the abandoned one");
});

test("a font whose decode never settles leaves the card unbranded, and the next load still works", { timeout: 8000 }, async () => {
	const { bytes, spec } = await woff2Fixture();
	const stuck = (woff2: Uint8Array) => decodeToTtf(woff2, 40, NEVER);
	assert.equal(await loadPinnedFonts([spec], served(bytes), 3000, stuck), undefined);
	assert.ok(await loadPinnedFonts([spec], served(bytes)), "a later card is not wedged behind it");
});
