/**
 * The `/og` card's pinned poster loader, and the kit image URLs. CI has no network, so the poster
 * under test is a few bytes made here that start like a JPEG; the live pin is checked as a shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { KIT_IMAGES, KIT_POSTER } from "./kit-images";
import { loadPinnedPoster } from "./kit-poster";

const sha384 = (bytes: Uint8Array) =>
	`sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const served = (bytes: Uint8Array, status = 200) =>
	(async () => new Response(bytes.slice().buffer, { status })) as unknown as typeof fetch;

const JPEG = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9,
]);
const spec = { url: "https://example.test/poster.jpg", integrity: sha384(JPEG) };

test("every brand image is an absolute kit URL, so a preview or Git deploy loads it too", () => {
	for (const [name, url] of Object.entries(KIT_IMAGES)) {
		assert.match(url, /^https:\/\/usertrust\.ai\/kit\/images\/[a-z-]+\.(?:jpg|svg)$/, name);
	}
});

test("the pin: the hero's settled frame from the kit, with its sha384", () => {
	assert.equal(KIT_POSTER.url, KIT_IMAGES.introPoster);
	assert.match(KIT_POSTER.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
});

test("a poster that matches its pin comes back as exactly those bytes", async () => {
	const poster = await loadPinnedPoster(spec, served(JPEG));
	assert.ok(poster instanceof ArrayBuffer);
	assert.deepEqual(new Uint8Array(poster), JPEG);
});

test("tampered bytes, an HTTP error, a network failure and a non-JPEG body each yield no poster, never a throw", async () => {
	const tampered = new Uint8Array(JPEG);
	tampered[tampered.length - 3] = 0x21;
	assert.equal(await loadPinnedPoster(spec, served(tampered)), undefined);
	assert.equal(await loadPinnedPoster(spec, served(JPEG, 404)), undefined);
	assert.equal(
		await loadPinnedPoster(spec, (async () => {
			throw new Error("unreachable");
		}) as unknown as typeof fetch),
		undefined,
	);
	const html = new TextEncoder().encode("<html>not a poster</html>");
	assert.equal(
		await loadPinnedPoster({ ...spec, integrity: sha384(html) }, served(html)),
		undefined,
	);
});
