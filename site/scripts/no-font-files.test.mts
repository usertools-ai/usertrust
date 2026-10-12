/**
 * No font file is tracked anywhere in this repository. Brand assets (Usertools
 * Sans and every other font, the marks, the lattice) stay out of the public
 * repo: pages load them at runtime from the brand kit,
 * https://usertrust.ai/kit/, which serves them with
 * `access-control-allow-origin: *`.
 *
 * The listing is `git ls-files` from the repository root, so the guard sees
 * every tracked path in every package, not only `site/`. It lives in the
 * site's suite because that suite already runs in CI (`site-build`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const KIT_FONTS = "https://usertrust.ai/kit/fonts/";

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot|ttc|otc)$/i;

/**
 * A font file's first four bytes, by format: WOFF2, WOFF, OpenType (CFF), a font collection
 * (.ttc/.otc), TrueType (0x00010000) and old Mac TrueType (`true`). A font is found by its
 * BYTES, whatever its name: a font renamed `.png`, or a collection under any name, is still
 * one. The last two are four bytes a text file could start with by chance, so they count only
 * in a binary file.
 */
const FONT_MAGICS: ReadonlyArray<{
	format: string;
	bytes: readonly number[];
	binaryOnly: boolean;
}> = [
	{ format: "woff2", bytes: [0x77, 0x4f, 0x46, 0x32], binaryOnly: false },
	{ format: "woff", bytes: [0x77, 0x4f, 0x46, 0x46], binaryOnly: false },
	{ format: "otf", bytes: [0x4f, 0x54, 0x54, 0x4f], binaryOnly: false },
	{ format: "collection", bytes: [0x74, 0x74, 0x63, 0x66], binaryOnly: false },
	{ format: "ttf", bytes: [0x00, 0x01, 0x00, 0x00], binaryOnly: true },
	{ format: "ttf (true)", bytes: [0x74, 0x72, 0x75, 0x65], binaryOnly: true },
];

/**
 * The same four bytes as they open a base64 run: the first FIVE characters (30 bits). The
 * sixth also carries two bits of the font's fifth byte, so a six-character prefix would miss
 * a font whose fifth byte differs (a WOFF2 of an OpenType font is `d09GMk`, not `d09GMg`).
 */
const FONT_BASE64 = ["d09GM", "d09GR", "T1RUT", "dHRjZ", "AAEAA", "dHJ1Z"];

/**
 * The shortest base64 run read as an embedded font: 1,024 characters (768 bytes). A real font
 * is many kilobytes; a short run that only starts like one (a hash, an id) is not.
 */
const MIN_FONT_BASE64 = 1024;

/** Whether `bytes` is text: no NUL byte in its first 8000, the test git itself uses. */
function isText(bytes: Uint8Array): boolean {
	return !bytes.subarray(0, 8000).includes(0);
}

/** The font format `bytes` starts with, or null. */
export function fontMagic(bytes: Uint8Array): string | null {
	for (const { format, bytes: magic, binaryOnly } of FONT_MAGICS) {
		if (bytes.length < 12 || !magic.every((b, i) => bytes[i] === b)) continue;
		if (binaryOnly && isText(bytes)) continue;
		return format;
	}
	return null;
}

/**
 * The fonts `text` embeds INLINE, which no URL check sees: a `data:` URL of a font type
 * (`data:font/…`, `data:application/font…`, `data:application/x-font…`, or any type naming
 * woff), and a base64 run of at least MIN_FONT_BASE64 characters that starts as a font does.
 */
export function inlineFonts(text: string): string[] {
	const found: string[] = [];
	for (const m of text.matchAll(
		/data:(?:font\/|application\/(?:x-)?font|[^,;'"\s)]*woff)[^,'"\s)]*/gi,
	)) {
		found.push(m[0].slice(0, 60));
	}
	const prefixes = FONT_BASE64.join("|");
	const run = new RegExp(
		`(?<![A-Za-z0-9+/])(?:${prefixes})[A-Za-z0-9+/]{${MIN_FONT_BASE64 - 5},}`,
		"g",
	);
	for (const m of text.matchAll(run))
		found.push(`base64 ${m[0].slice(0, 12)}… (${m[0].length} chars)`);
	return found;
}

/**
 * A font file that legitimately has to be tracked (a non-brand test fixture,
 * say), by exact repo-relative path, with the reason it is here. Empty: no font
 * file is tracked. Adding an entry is a reviewed change to this line.
 */
export const ALLOWED_FONT_FILES: Readonly<Record<string, string>> = {};

/** Every path git tracks, repo-relative. Fails, never passes, if git cannot list. */
function trackedFiles(): string[] {
	const r = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
	assert.equal(r.status, 0, `git ls-files failed (status ${r.status}): ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/**
 * Every font URL `text` names (quoted, or in CSS `url(...)`) that is not the
 * kit's. The scan below runs it over each site source; the rows test plants
 * URLs through it directly, so no font URL is ever committed to site source.
 *
 * A URL is judged by its PATH: the query and the fragment are stripped first,
 * so `X.woff2?v=1` and `X.eot#iefix` are fonts, and the extension rule is
 * `FONT_FILE`, the same one the tracked-file guard applies. A kit URL with a
 * query still passes: a query or a fragment changes neither the host nor the
 * path, so the bytes still come from the kit and nothing is committed here.
 */
export function nonKitFontUrls(text: string): string[] {
	const offenders: string[] = [];
	for (const m of text.matchAll(/['"(`]([^'"()`\s]+)['")`]/g)) {
		const url = m[1] ?? "";
		const path = url.replace(/[?#].*$/, "");
		if (FONT_FILE.test(path) && !path.startsWith(KIT_FONTS)) offenders.push(url);
	}
	return offenders;
}

/** The font files among `paths` that are not explicitly allowlisted. */
export function fontFiles(paths: readonly string[]): string[] {
	return paths.filter((path) => FONT_FILE.test(path) && !Object.hasOwn(ALLOWED_FONT_FILES, path));
}

test("no font file is tracked anywhere in the repository", () => {
	const files = trackedFiles();
	// The control: this is the whole repository's listing, not an empty or partial one.
	assert.ok(files.includes("AGENTS.md"), "the listing reaches the repository root");
	assert.ok(files.includes("site/package.json"), "the listing reaches site/");
	assert.ok(
		files.some((f) => f.startsWith("packages/")),
		"the listing reaches packages/",
	);
	assert.deepEqual(
		fontFiles(files),
		[],
		"font files must load from https://usertrust.ai/kit/ at runtime, never be committed",
	);
});

test("the matcher catches every font extension, at any depth and in any case", () => {
	assert.deepEqual(
		fontFiles([
			"site/public/fonts/A.woff2",
			"B.WOFF",
			"packages/x/tests/fixtures/c.ttf",
			"d.otf",
			"e/f.eot",
			"h.ttc",
			"i/j.OTC",
			"site/public/fonts/OFL.txt",
			"g.woff2.md",
			"woff2",
		]),
		[
			"site/public/fonts/A.woff2",
			"B.WOFF",
			"packages/x/tests/fixtures/c.ttf",
			"d.otf",
			"e/f.eot",
			"h.ttc",
			"i/j.OTC",
		],
	);
});

test("every allowlisted font file is tracked and carries a reason", () => {
	const files = new Set(trackedFiles());
	for (const [path, reason] of Object.entries(ALLOWED_FONT_FILES)) {
		assert.ok(files.has(path), `${path} is allowlisted but not tracked; remove the entry`);
		assert.ok(reason.trim().length > 0, `${path} needs a reason`);
	}
});

/**
 * The site sources the URL scan reads: EVERY tracked text file under `site/`, whatever its
 * extension (pages, MDX docs, styles, config, JSON), not a list of extensions that a new
 * kind of source would fall outside of. Binary files (images, video) are skipped by their
 * bytes. Test files are skipped: their rows plant font URLs on purpose.
 */
export function siteSources(
	paths: readonly string[],
	read: (path: string) => Uint8Array,
): string[] {
	return paths.filter(
		(path) => path.startsWith("site/") && !/\.test\.[^/]+$/.test(path) && isText(read(path)),
	);
}

test("the scan reads every text file under site/, by its bytes, not by an extension list", () => {
	const files: Record<string, Uint8Array> = {
		"site/app/layout.tsx": Buffer.from("export default 1;"),
		"site/content/docs/index.mdx": Buffer.from("# Docs"),
		"site/app/globals.css": Buffer.from("body {}"),
		"site/source.config.json": Buffer.from("{}"),
		"site/notes": Buffer.from("no extension, still text"),
		"site/public/og.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
		"site/scripts/no-font-files.test.mts": Buffer.from("planted"),
		"packages/x/index.ts": Buffer.from("outside site/"),
	};
	assert.deepEqual(
		siteSources(Object.keys(files), (path) => files[path] ?? new Uint8Array()),
		[
			"site/app/layout.tsx",
			"site/content/docs/index.mdx",
			"site/app/globals.css",
			"site/source.config.json",
			"site/notes",
		],
	);
});

test("no site source points at a local font file; every font URL is the kit's", () => {
	const sources = siteSources(trackedFiles(), (path) => readFileSync(join(REPO_ROOT, path)));
	// The control: the scan reaches the root layout, the MDX docs and the styles.
	assert.ok(sources.includes("site/app/layout.tsx"), "the scan reaches the root layout");
	assert.ok(
		sources.some((f) => f.startsWith("site/content/docs/") && f.endsWith(".mdx")),
		"the scan reaches the MDX docs pages",
	);
	assert.ok(sources.includes("site/app/globals.css"), "the scan reaches the styles");
	const offenders: string[] = [];
	for (const file of sources) {
		const text = readFileSync(join(REPO_ROOT, file), "utf8");
		for (const url of nonKitFontUrls(text)) offenders.push(`${file}: ${url}`);
	}
	assert.deepEqual(offenders, []);
});

test("a font URL in an MDX page is caught, in JSX styles and in a link", () => {
	const page = [
		"# Fonts",
		'<style>{`@font-face { font-family: X; src: url("/fonts/local.woff2"); }`}</style>',
		"Download [the face](/fonts/Other.ttf).",
		'<link rel="preload" href="https://usertrust.ai/kit/fonts/Khand-Bold.woff2" />',
	].join("\n");
	assert.deepEqual(nonKitFontUrls(page), ["/fonts/local.woff2", "/fonts/Other.ttf"]);
});

test("a font URL is judged by its path: a query or a fragment does not hide it", () => {
	const local = (url: string) => nonKitFontUrls(`src: url("${url}") format("woff2");`);
	// The control: a plain local font URL is caught.
	assert.deepEqual(local("/fonts/X.woff2"), ["/fonts/X.woff2"]);
	// A query or a fragment after the extension is still a local font.
	assert.deepEqual(local("/fonts/X.woff2?v=1"), ["/fonts/X.woff2?v=1"]);
	assert.deepEqual(local("../public/fonts/X.eot#iefix"), ["../public/fonts/X.eot#iefix"]);
	assert.deepEqual(local("/fonts/X.eot?#iefix"), ["/fonts/X.eot?#iefix"]);
	assert.deepEqual(nonKitFontUrls("const f = '/fonts/X.ttf?v=2';"), ["/fonts/X.ttf?v=2"]);
	// The kit, with or without a query, is the one host allowed.
	assert.deepEqual(local("https://usertrust.ai/kit/fonts/X.woff2"), []);
	assert.deepEqual(local("https://usertrust.ai/kit/fonts/X.woff2?v=1"), []);
	// A name that only CONTAINS a font extension is not a font.
	assert.deepEqual(local("/fonts/X.woff2.md"), []);
	assert.deepEqual(local("/fonts/X.woff2x?v=1"), []);
});

/** This guard's own source names every pattern it looks for, so it is the one file not scanned. */
const SELF = "site/scripts/no-font-files.test.mts";

/** Up to the first 8000 bytes of a tracked file: enough for its magic and the text test. */
function head(path: string): Uint8Array {
	const fd = openSync(join(REPO_ROOT, path), "r");
	try {
		const buffer = Buffer.alloc(8000);
		return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
	} finally {
		closeSync(fd);
	}
}

test("no tracked file is a font by its BYTES, whatever its name", () => {
	const files = trackedFiles();
	assert.ok(files.length > 100, "the listing is the whole repository");
	const fonts = files
		.filter((path) => !Object.hasOwn(ALLOWED_FONT_FILES, path))
		.map((path) => [path, fontMagic(head(path))] as const)
		.filter(([, format]) => format !== null)
		.map(([path, format]) => `${path}: ${format}`);
	assert.deepEqual(fonts, [], "font files must load from https://usertrust.ai/kit/ at runtime");
});

test("no tracked text file embeds a font inline (a data: URL, a base64 run)", () => {
	const texts = trackedFiles().filter((path) => path !== SELF && isText(head(path)));
	// The control: the scan reaches the site, the docs and the packages.
	assert.ok(texts.includes("site/app/layout.tsx"), "the scan reaches the root layout");
	assert.ok(
		texts.some((f) => f.endsWith(".mdx")),
		"the scan reaches the MDX docs",
	);
	assert.ok(
		texts.some((f) => f.startsWith("packages/")),
		"the scan reaches packages/",
	);
	const offenders: string[] = [];
	for (const path of texts) {
		for (const found of inlineFonts(readFileSync(join(REPO_ROOT, path), "utf8"))) {
			offenders.push(`${path}: ${found}`);
		}
	}
	assert.deepEqual(offenders, []);
});

/** A stand-in font: a magic, then bytes that make it binary, `size` bytes in all. */
function fakeFont(magic: string | number[], size = 2048): Buffer {
	const bytes = Buffer.alloc(size);
	Buffer.from(typeof magic === "string" ? Buffer.from(magic, "latin1") : magic).copy(bytes);
	for (let i = 4; i < size; i += 1) bytes[i] = (i * 7919) % 251;
	bytes[5] = 0;
	return bytes;
}

test("a font is found by its bytes: a collection under a fake name, a WOFF2 renamed .png", () => {
	// A .ttc saved as notes.bin and a WOFF2 renamed logo.png: no font extension, still fonts.
	assert.equal(fontMagic(fakeFont("ttcf")), "collection");
	assert.equal(fontMagic(fakeFont("wOF2")), "woff2");
	assert.equal(fontMagic(fakeFont("wOFF")), "woff");
	assert.equal(fontMagic(fakeFont("OTTO")), "otf");
	assert.equal(fontMagic(fakeFont([0x00, 0x01, 0x00, 0x00])), "ttf");
	assert.equal(fontMagic(fakeFont("true")), "ttf (true)");
	// The controls: a real PNG header is not a font, and a TEXT file that starts with `true`
	// (a config, a fixture) is not one either.
	assert.equal(
		fontMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])),
		null,
	);
	assert.equal(fontMagic(Buffer.from("true\nfalse\ntrue\n")), null);
	assert.equal(fontMagic(Buffer.from("wOF2")), null, "too short to be a font");
});

test("a font inline: a data: URL of a font type, and a base64 font in a .tsx", () => {
	const woff2 = fakeFont("wOF2").toString("base64");
	// An inline data: URL in CSS, by its type, whatever the encoding.
	assert.equal(
		inlineFonts(`src: url(data:font/woff2;base64,${woff2.slice(0, 40)}) format("woff2");`).length,
		1,
	);
	assert.equal(inlineFonts('src: url("data:application/x-font-ttf;base64,AAAA")').length, 1);
	assert.equal(
		inlineFonts("src: url(data:application/font-woff;charset=utf-8;base64,AAAA)").length,
		1,
	);
	// A base64 font in a .tsx constant, with no data: prefix at all.
	const tsx = `export const FACE = "${woff2}";\n`;
	const found = inlineFonts(tsx);
	assert.equal(found.length, 1);
	assert.ok(found[0]?.startsWith("base64 d09GM"), found[0]);
	// The sixth base64 character carries the font's fifth byte: a WOFF2 of an OpenType font
	// starts `d09GMk`, and is still caught.
	const otfFlavour = Buffer.concat([
		Buffer.from("wOF2OTTO", "latin1"),
		fakeFont("xxxx").subarray(4),
	]);
	assert.ok(otfFlavour.toString("base64").startsWith("d09GMk"));
	assert.equal(inlineFonts(otfFlavour.toString("base64")).length, 1);
	// Every magic's base64 form is caught.
	for (const magic of ["wOFF", "OTTO", "ttcf", "true"]) {
		assert.equal(inlineFonts(fakeFont(magic).toString("base64")).length, 1, magic);
	}
	assert.equal(inlineFonts(fakeFont([0x00, 0x01, 0x00, 0x00]).toString("base64")).length, 1);
	// The controls: a short run that only starts like a font (a hash, an id), a PNG data: URL,
	// the kit's URL, and a run that is the middle of a longer one are not fonts.
	assert.deepEqual(inlineFonts(`const id = "${woff2.slice(0, 200)}";`), []);
	assert.deepEqual(inlineFonts('src="data:image/png;base64,iVBORw0KGgo="'), []);
	assert.deepEqual(inlineFonts('url("https://usertrust.ai/kit/fonts/Khand-Bold.woff2")'), []);
	assert.deepEqual(inlineFonts(`x${woff2}`), []);
});
