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
import { KIT_FONTS, loadPinnedFonts, type PinnedFont } from "./kit-fonts";

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
