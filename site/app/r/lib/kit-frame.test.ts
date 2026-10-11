/**
 * The share card's pinned frame loader. CI has no network, so the frame under test is a small SVG
 * made here; the live pin is checked as a shape (a content-addressed kit URL beside a sha384).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { KIT_FRAME, loadPinnedFrame } from "./kit-frame";

const sha384 = (bytes: Uint8Array) =>
	`sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const served = (bytes: Uint8Array, status = 200) =>
	(async () => new Response(bytes.slice().buffer, { status })) as unknown as typeof fetch;

const SVG = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><circle cx="1" cy="1" r="1"/></svg>\n',
);
const spec = { url: "https://example.test/card-frame.svg", integrity: sha384(SVG) };

test("the pin: a content-addressed kit SVG with its sha384", () => {
	assert.match(KIT_FRAME.url, /^https:\/\/usertrust\.ai\/kit\/card-frame\.[0-9a-f]{12}\.svg$/);
	assert.match(KIT_FRAME.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
});

test("a frame that matches its pin comes back as an SVG data URI of exactly those bytes", async () => {
	const frame = await loadPinnedFrame(spec, served(SVG));
	assert.ok(frame?.startsWith("data:image/svg+xml;base64,"));
	assert.deepEqual(
		new Uint8Array(Buffer.from((frame as string).split(",")[1] as string, "base64")),
		SVG,
	);
});

test("tampered bytes, an HTTP error, a network failure and a non-SVG body each yield no frame, never a throw", async () => {
	const tampered = new Uint8Array(SVG);
	tampered[tampered.length - 2] = 0x21;
	assert.equal(await loadPinnedFrame(spec, served(tampered)), undefined);
	assert.equal(await loadPinnedFrame(spec, served(SVG, 503)), undefined);
	assert.equal(
		await loadPinnedFrame(spec, (async () => {
			throw new Error("unreachable");
		}) as unknown as typeof fetch),
		undefined,
	);
	const html = new TextEncoder().encode("<html>not an svg</html>");
	assert.equal(
		await loadPinnedFrame({ ...spec, integrity: sha384(html) }, served(html)),
		undefined,
	);
});
