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
 *
 * THE INVARIANT IS ON BYTES. A font is found by its content, whatever its name
 * (`fontMagic`, `inlineFonts`). The formats, and where each signature comes from:
 * - file(1)'s magic database, `Magdir/fonts` (rev 1.46, file 5.41): the sfnt
 *   versions `\0\1\0\0`, `true` and `typ1`; `OTTO`; `ttcf` (collections, .ttc/.otc);
 *   `wOFF` and `wOF2`; PostScript Type 1 (`%!PS-AdobeFont-1.`, `%!FontType1`,
 *   `%!PS-Adobe-3.0 Resource-Font`, at offset 0 as text or at 6 after a PFB segment
 *   header); X11 BDF (`STARTFONT `); X11 PCF (`\x01fcp`); PFR (`PFR0`, `PFR1`);
 *   FontForge sources (`SplineFontDB:`).
 * - The Embedded OpenType submission (W3C, 2008), section 3: EOT has no leading
 *   signature. Its little-endian header holds MagicNumber 0x504C at offset 34 (`LP`)
 *   and Version 0x00010000, 0x00020001 or 0x00020002 at offset 8, and its sizes are
 *   consistent: 0 < FontDataSize (offset 4) < EOTSize (offset 0) <= the file's length
 *   (a file may carry bytes after the structure). All are required, in a binary file.
 * - Adobe Technical Note 5012 (Type 42): `%!PS-TrueTypeFont`.
 * - SVG 1.1, chapter 20: an SVG font is a `<font>` element with `<glyph>` or
 *   `<font-face>` children inside `<svg>`.
 * - The OpenType specification, "Organization of an OpenType font": every
 *   TrueType/OpenType font begins with a table directory (sfntVersion, numTables,
 *   searchRange, entrySelector, rangeShift, then 16-byte table records). It is
 *   searched for ANYWHERE in a file (`sfntDirectories`), so sfnt data inside an
 *   uncompressed container (a Mac .dfont or suitcase, any binary) is found.
 * - The UFO 3 specification, GLIF: a glyph file is a `<glyph>` with an `<outline>`
 *   of `<contour>`s.
 *
 * SCOPE. The invariant protects the brand FACES, which are outline fonts. In scope:
 * outline-font data (sfnt TrueType/OpenType and CFF, Type 1, and their sources) in
 * any form a byte scan can see. Out of scope, because they cannot carry a brand face:
 * bitmap and console formats (Berkeley vfont, X11 SNF and Speedo, GRUB PFF2, libGrx,
 * DOS code pages, GEM GDOS, FIGlet; BDF and PCF are flagged anyway), Windows .fon/.fnt,
 * and metrics-only Adobe .pfm. Declared beyond this scan: data in a COMPRESSED
 * container (zip, gzip, a compressed PDF stream) is beyond any byte scan; inline
 * base64 is found only for the formats with a four-byte leading signature (a base64
 * EOT or PFB is not); proprietary editor sources (FontLab .vfb, Glyphs .glyphs) are
 * not parsed.
 *
 * READ WINDOWS. Each detector reads what its form needs, and no less:
 * - a signature at a fixed offset (every one in `FONT_MAGICS`, at most 36 bytes in;
 *   EOT's MagicNumber at 34, a PFB's header at 6) reads the first HEAD_BYTES (`head`),
 *   which is also the window of git's own text-or-binary test;
 * - a form that can stand ANYWHERE in a file (an sfnt table directory, an SVG font, a
 *   UFO glyph, a `data:` font URL, a base64 font, an embedded PostScript font
 *   program) is searched over the WHOLE file,
 *   every tracked file, binary or text (`fontsInFile`). The largest tracked file is
 *   14 MB, so each is read whole.
 *
 * THE URL CHECKS ARE BEST EFFORT. `nonKitFontUrls` and `fontSources` catch a
 * non-kit font URL by its extension or its context, but a static scan of source
 * can always be bypassed by one more indirection (an imported stylesheet, CSS
 * built at runtime, a fetch). A gap there is a follow-up; the bytes rule above is
 * the invariant.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const KIT_FONTS = "https://usertrust.ai/kit/fonts/";

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot|ttc|otc|dfont)$/i;

/**
 * A font file's leading bytes, by format (see the header for the sources). The ambiguous
 * four-byte sfnt versions (`\0\1\0\0`, `true`, `typ1`) count only in a binary file, since a
 * text file could start with them by chance; the text formats (PFA, Type 42, BDF, FontForge)
 * count only in a text file.
 */
const FONT_MAGICS: ReadonlyArray<{
	format: string;
	at: number;
	bytes: readonly number[];
	kind: "any" | "binary" | "text";
}> = [
	{ format: "woff2", at: 0, bytes: ascii("wOF2"), kind: "any" },
	{ format: "woff", at: 0, bytes: ascii("wOFF"), kind: "any" },
	{ format: "otf", at: 0, bytes: ascii("OTTO"), kind: "any" },
	{ format: "collection", at: 0, bytes: ascii("ttcf"), kind: "any" },
	{ format: "ttf", at: 0, bytes: [0x00, 0x01, 0x00, 0x00], kind: "binary" },
	{ format: "ttf (true)", at: 0, bytes: ascii("true"), kind: "binary" },
	{ format: "ttf (typ1)", at: 0, bytes: ascii("typ1"), kind: "binary" },
	{ format: "type1 (pfb)", at: 6, bytes: ascii("%!PS-AdobeFont-1."), kind: "binary" },
	{ format: "type1 (pfb)", at: 6, bytes: ascii("%!FontType1"), kind: "binary" },
	{ format: "type1 (pfa)", at: 0, bytes: ascii("%!PS-AdobeFont-1."), kind: "text" },
	{ format: "type1 (pfa)", at: 0, bytes: ascii("%!FontType1"), kind: "text" },
	{ format: "type1 (pfa)", at: 0, bytes: ascii("%!PS-Adobe-3.0 Resource-Font"), kind: "text" },
	{ format: "type42", at: 0, bytes: ascii("%!PS-TrueTypeFont"), kind: "text" },
	{ format: "bdf", at: 0, bytes: ascii("STARTFONT "), kind: "text" },
	{ format: "pcf", at: 0, bytes: [0x01, 0x66, 0x63, 0x70], kind: "any" },
	{ format: "pfr", at: 0, bytes: ascii("PFR0"), kind: "any" },
	{ format: "pfr", at: 0, bytes: ascii("PFR1"), kind: "any" },
	{ format: "fontforge", at: 0, bytes: ascii("SplineFontDB:"), kind: "text" },
];

function ascii(text: string): number[] {
	return [...text].map((c) => c.charCodeAt(0));
}

/** The EOT versions the submission defines (section 3.1 to 3.3). */
const EOT_VERSIONS = new Set([0x00010000, 0x00020001, 0x00020002]);

/**
 * Whether `bytes` is an EOT header for a file of `size` bytes: MagicNumber `LP` (0x504C,
 * little-endian) at offset 34, a defined Version at offset 8, and sizes that fit: FontDataSize
 * (offset 4) is inside EOTSize (offset 0), which is inside the file. Not EOTSize == size: an
 * EOT with bytes appended after it is still one. All little-endian.
 */
function isEot(bytes: Uint8Array, size: number): boolean {
	if (bytes.length < 36) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return (
		bytes[34] === 0x4c &&
		bytes[35] === 0x50 &&
		EOT_VERSIONS.has(view.getUint32(8, true)) &&
		view.getUint32(4, true) > 0 &&
		view.getUint32(4, true) < view.getUint32(0, true) &&
		view.getUint32(0, true) <= size
	);
}

/**
 * An SVG font (SVG 1.1, chapter 20): `<svg>`, a `<font>` element, and its `<glyph>`,
 * `<font-face>` or `<missing-glyph>`, anywhere in the text. Three presence tests, so the
 * search is linear in the file's length.
 */
function hasSvgFont(text: string): boolean {
	return (
		/<svg\b/i.test(text) &&
		/<font[\s>]/i.test(text) &&
		/<(?:glyph|font-face|missing-glyph)\b/i.test(text)
	);
}

/** A UFO glyph (UFO 3, GLIF): a `<glyph>` with an `<outline>` of `<contour>`s, anywhere. */
function hasUfoGlyph(text: string): boolean {
	return /<glyph\b/.test(text) && /<outline>/.test(text) && /<contour\b/.test(text);
}

/** The sfnt versions a table directory starts with (OpenType spec; Apple's `true`, `typ1`). */
const SFNT_VERSIONS = [[0x00, 0x01, 0x00, 0x00], ascii("OTTO"), ascii("true"), ascii("typ1")];

/**
 * Every offset in `bytes` where an sfnt TABLE DIRECTORY starts (OpenType spec, "Organization
 * of an OpenType font"): a version word, then numTables (1 to 64), then searchRange,
 * entrySelector and rangeShift exactly as the spec derives them from numTables, then that
 * many 16-byte table records whose tags are four printable characters and include `cmap`
 * and `head`, which every TrueType and OpenType font has. Searched over the whole file, so
 * sfnt data inside any uncompressed container (a Mac .dfont, a suitcase, any binary) is
 * found. A version word alone is not a directory.
 */
export function sfntDirectories(bytes: Uint8Array): number[] {
	const found: number[] = [];
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (const version of SFNT_VERSIONS) {
		const word = Buffer.from(version);
		for (let at = buffer.indexOf(word); at !== -1; at = buffer.indexOf(word, at + 1)) {
			if (at + 12 > buffer.length) break;
			const tables = buffer.readUInt16BE(at + 4);
			if (tables < 1 || tables > 64 || at + 12 + tables * 16 > buffer.length) continue;
			const power = 2 ** Math.floor(Math.log2(tables));
			if (
				buffer.readUInt16BE(at + 6) !== power * 16 ||
				buffer.readUInt16BE(at + 8) !== Math.log2(power) ||
				buffer.readUInt16BE(at + 10) !== tables * 16 - power * 16
			) {
				continue;
			}
			const tags: string[] = [];
			for (let t = 0; t < tables; t += 1) {
				const tag = buffer.subarray(at + 12 + t * 16, at + 16 + t * 16);
				if (!tag.every((c) => c >= 0x20 && c <= 0x7e)) break;
				tags.push(tag.toString("latin1"));
			}
			if (tags.length === tables && tags.includes("cmap") && tags.includes("head")) {
				found.push(at);
			}
		}
	}
	return found.sort((a, b) => a - b);
}

/**
 * A PostScript font program anywhere in a text: a Type 1 or Type 42 font embedded in a
 * PostScript or EPS document (file(1)'s Type 1 signatures and Adobe TN 5012's Type 42 one).
 */
const POSTSCRIPT_FONT =
	/%!(?:PS-AdobeFont-1\.|FontType1|PS-TrueTypeFont|PS-Adobe-3\.0 Resource-Font)/;

/** How much of a file `head` reads: the window of every fixed-offset signature. */
const HEAD_BYTES = 8000;

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

/** Whether `bytes` is text: no NUL byte in its first HEAD_BYTES, the test git itself uses. */
function isText(bytes: Uint8Array): boolean {
	return !bytes.subarray(0, HEAD_BYTES).includes(0);
}

/**
 * The font format a file is, from its leading `bytes` (its first HEAD_BYTES, as `head` reads
 * them) and its `size`, or null. FIXED-OFFSET signatures only: a form that can stand anywhere
 * in a file is `inlineFonts`'s, over the whole file. See the header for the sources.
 */
export function fontMagic(bytes: Uint8Array, size: number = bytes.length): string | null {
	const text = isText(bytes);
	for (const { format, at, bytes: magic, kind } of FONT_MAGICS) {
		if (bytes.length < Math.max(12, at + magic.length)) continue;
		if (!magic.every((b, i) => bytes[at + i] === b)) continue;
		if ((kind === "binary" && text) || (kind === "text" && !text)) continue;
		return format;
	}
	if (!text && isEot(bytes, size)) return "eot";
	return null;
}

/**
 * The fonts `text` holds ANYWHERE in it, which no URL check and no leading signature sees: a
 * `data:` URL of a font type (`data:font/...`, `data:application/font...`,
 * `data:application/x-font...`, or any type naming woff), a base64 run of at least
 * MIN_FONT_BASE64 characters that starts as a font does, an SVG font, and an embedded
 * PostScript font program. Its window is the whole of `text`: pass it the whole file.
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
	if (hasSvgFont(text)) found.push("svg font");
	if (hasUfoGlyph(text)) found.push("ufo glyph");
	const program = POSTSCRIPT_FONT.exec(text);
	if (program) found.push(`postscript font program (${program[0]})`);
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
	const add = (url: string) => {
		if (!offenders.includes(url)) offenders.push(url);
	};
	for (const m of text.matchAll(/['"(`]([^'"()`\s]+)['")`]/g)) {
		const url = m[1] ?? "";
		const path = url.replace(/[?#].*$/, "");
		if (FONT_FILE.test(path) && !path.startsWith(KIT_FONTS)) add(url);
	}
	// A font source by its CONTEXT, whatever its name: it must be the kit's.
	for (const url of fontSources(text)) {
		if (!url.replace(/[?#].*$/, "").startsWith(KIT_FONTS)) add(url);
	}
	return offenders;
}

/** The URL inside a CSS `url(...)`, quoted or not. */
const CSS_URL = /url\(\s*(["']?)([^"')]*?)\1\s*\)/gi;

/**
 * Every URL `text` uses AS A FONT, known by where it stands rather than by its name (an
 * endpoint such as `https://cdn.example/font?id=123` has no font extension):
 * - every `url()` inside an `@font-face` block;
 * - every `url()` followed by a `format()` hint, wherever it is;
 * - the `href` of a `<link>` with `as="font"`;
 * - the first argument of a `preload(…, { as: "font" })` call. A literal is taken as it is; an
 *   identifier is followed to the string (`const x = "…"`) or the array of strings
 *   (`for (const x of LIST)`, `const LIST = [ "…", … ]`) it names in the same text, and one
 *   that cannot be followed is reported as `<unresolved: x>`: a font source that cannot be
 *   checked is never passed.
 */
export function fontSources(text: string): string[] {
	const found: string[] = [];
	for (const block of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
		for (const m of (block[1] ?? "").matchAll(CSS_URL)) found.push(m[2] ?? "");
	}
	for (const m of text.matchAll(/url\(\s*(["']?)([^"')]*?)\1\s*\)\s*format\(/gi))
		found.push(m[2] ?? "");
	for (const tag of text.matchAll(/<link\b[^>]*>/gi)) {
		const attrs = tag[0];
		if (!/\bas\s*=\s*\{?\s*["'`]font["'`]/i.test(attrs)) continue;
		const href = /\bhref\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/i.exec(attrs);
		found.push(href?.[1] ?? "<unresolved: href>");
	}
	for (const call of preloadCalls(text)) {
		if (/\bas\s*:\s*["'`]font["'`]/.test(call.rest))
			found.push(...resolveStrings(text, call.first));
	}
	return found;
}

/**
 * Every `preload(` call: its first argument, and the rest of its arguments, split at the first
 * comma outside brackets, to the call's own closing paren. A scan, not a pattern, so an
 * argument that is itself a call (`preload(pick(), …)`) is read whole.
 */
function preloadCalls(text: string): Array<{ first: string; rest: string }> {
	const calls: Array<{ first: string; rest: string }> = [];
	for (const m of text.matchAll(/\bpreload\(/g)) {
		const from = (m.index ?? 0) + m[0].length;
		let depth = 0;
		let comma = -1;
		let at = from;
		for (; at < text.length; at += 1) {
			const c = text[at];
			if (c === "(" || c === "[" || c === "{") depth += 1;
			else if (c === ")" || c === "]" || c === "}") {
				if (depth === 0) break;
				depth -= 1;
			} else if (c === "," && depth === 0 && comma === -1) comma = at;
		}
		if (comma === -1) continue;
		calls.push({ first: text.slice(from, comma).trim(), rest: text.slice(comma + 1, at) });
	}
	return calls;
}

/** The strings an argument names: a literal, or an identifier followed one step (see above). */
function resolveStrings(text: string, arg: string): string[] {
	const literal = /^["'`]([^"'`]*)["'`]$/.exec(arg);
	if (literal) return [literal[1] ?? ""];
	if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return [`<unresolved: ${arg}>`];
	const value = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*["'\`]([^"'\`]*)["'\`]`).exec(text);
	if (value) return [value[1] ?? ""];
	const loop = new RegExp(
		`\\bfor\\s*\\(\\s*const\\s+${arg}\\s+of\\s+([A-Za-z_$][\\w$]*)\\s*\\)`,
	).exec(text);
	const list = loop
		? new RegExp(`\\bconst\\s+${loop[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text)
		: null;
	if (list) {
		const strings = [...(list[1] ?? "").matchAll(/["'`]([^"'`]*)["'`]/g)].map((s) => s[1] ?? "");
		if (strings.length > 0) return strings;
	}
	return [`<unresolved: ${arg}>`];
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
			"k/brand.dfont",
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
			"k/brand.dfont",
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
	// Outside a font context, a name that only CONTAINS a font extension is not a font.
	assert.deepEqual(nonKitFontUrls('const doc = "/fonts/X.woff2.md";'), []);
	assert.deepEqual(nonKitFontUrls('const doc = "/fonts/X.woff2x?v=1";'), []);
	// Inside one (here a format() hint), it is a font source whatever its name.
	assert.deepEqual(local("/fonts/X.woff2.md"), ["/fonts/X.woff2.md"]);
});

/** This guard's own source names every pattern it looks for, so it is the one file not scanned. */
const SELF = "site/scripts/no-font-files.test.mts";

/** Up to the first HEAD_BYTES of a file (repo-relative, or absolute): its signatures' window. */
function head(path: string): Uint8Array {
	const fd = openSync(resolve(REPO_ROOT, path), "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
	} finally {
		closeSync(fd);
	}
}

/**
 * The fonts a file (repo-relative, or absolute) holds, each detector over its own window: the
 * fixed-offset signatures over its head, and every anywhere-form over the WHOLE file, read as
 * bytes (latin1), so a binary file is searched too. This guard's own source names every
 * pattern, so only its signature is checked.
 */
export function fontsInFile(path: string): string[] {
	const absolute = resolve(REPO_ROOT, path);
	const found: string[] = [];
	const format = fontMagic(head(absolute), statSync(absolute).size);
	if (format !== null) found.push(format);
	const whole = readFileSync(absolute);
	for (const at of sfntDirectories(whole)) found.push(`sfnt table directory at ${at}`);
	if (path === SELF) return found;
	found.push(...inlineFonts(whole.toString("latin1")));
	return found;
}

test("no tracked file holds a font, by its BYTES, whatever its name or where in it", () => {
	const files = trackedFiles();
	// The control: the scan reaches the whole repository, text and binary.
	assert.ok(files.length > 100, "the listing is the whole repository");
	assert.ok(files.includes("site/app/layout.tsx"), "the scan reaches the root layout");
	assert.ok(
		files.some((f) => f.endsWith(".mdx")),
		"the scan reaches the MDX docs",
	);
	assert.ok(
		files.some((f) => f.startsWith("packages/")),
		"the scan reaches packages/",
	);
	assert.ok(
		files.some((f) => f.endsWith(".png")),
		"the scan reaches binary files",
	);
	const offenders = files
		.filter((path) => !Object.hasOwn(ALLOWED_FONT_FILES, path))
		.flatMap((path) => fontsInFile(path).map((found) => `${path}: ${found}`));
	assert.deepEqual(offenders, [], "font files must load from https://usertrust.ai/kit/ at runtime");
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

test("a font source is known by its CONTEXT, whatever its name, and must be the kit's", () => {
	// An extensionless @font-face source: no font extension, still a font.
	const face = `@font-face {
		font-family: X;
		src: url("https://cdn.example/font?id=123") format("woff2"), url(https://cdn.example/b);
	}`;
	assert.deepEqual(nonKitFontUrls(face), [
		"https://cdn.example/font?id=123",
		"https://cdn.example/b",
	]);
	// A url() with a format() hint, outside any @font-face (CSS built in a string).
	assert.deepEqual(nonKitFontUrls("const src = \"url(/api/face) format('woff')\";"), ["/api/face"]);
	// A preload as a font: a <link> in any attribute order, and a preload() call.
	assert.deepEqual(
		nonKitFontUrls(
			'<link href="https://cdn.example/f?id=1" crossOrigin="" as="font" rel="preload" />',
		),
		["https://cdn.example/f?id=1"],
	);
	assert.deepEqual(nonKitFontUrls('preload("https://cdn.example/f", { as: "font" });'), [
		"https://cdn.example/f",
	]);
	// A preload() of an identifier is followed to the strings it names; one that cannot be
	// followed is reported, never passed.
	const looped = `const FACES = ["https://usertrust.ai/kit/fonts/A.woff2", "https://cdn.example/b"];
		for (const href of FACES) {
			preload(href, { as: "font", crossOrigin: "anonymous" });
		}`;
	assert.deepEqual(nonKitFontUrls(looped), ["https://cdn.example/b"]);
	assert.deepEqual(nonKitFontUrls('preload(pick(), { as: "font" });'), ["<unresolved: pick()>"]);
	assert.deepEqual(nonKitFontUrls('preload(face, { as: "font" });'), ["<unresolved: face>"]);
	// The kit, with or without a query, in every context: allowed.
	const kit = "https://usertrust.ai/kit/fonts/Khand-Bold.woff2?v=2";
	assert.deepEqual(nonKitFontUrls(`@font-face { src: url("${kit}") format("woff2"); }`), []);
	assert.deepEqual(nonKitFontUrls(`<link rel="preload" as="font" href="${kit}" />`), []);
	assert.deepEqual(nonKitFontUrls(`preload("${kit}", { as: "font" });`), []);
	// The controls: an image preload and a background url() are not font sources.
	assert.deepEqual(nonKitFontUrls('<link rel="preload" as="image" href="/hero.avif" />'), []);
	assert.deepEqual(nonKitFontUrls('.hero { background: url("/hero.avif"); }'), []);
	assert.deepEqual(nonKitFontUrls('preload("/hero.avif", { as: "image" });'), []);
});

/** A stand-in file of `size` bytes: `prefix` at offset `at`, then binary filler (NULs in it). */
function fakeBinary(prefix: number[] | string, at = 0, size = 2048): Buffer {
	const bytes = Buffer.alloc(size);
	for (let i = 0; i < size; i += 1) bytes[i] = (i * 7919) % 251;
	bytes[1] = 0;
	Buffer.from(typeof prefix === "string" ? Buffer.from(prefix, "latin1") : prefix).copy(bytes, at);
	return bytes;
}

/** An EOT header (W3C submission, section 3) over a file of `size` bytes, little-endian. */
function fakeEot({
	size = 4096,
	version = 0x00020001,
	magic = 0x504c,
	eotSize = size,
	fontDataSize = size - 200,
} = {}): Buffer {
	const bytes = fakeBinary([], 0, size);
	bytes.writeUInt32LE(eotSize, 0);
	bytes.writeUInt32LE(fontDataSize, 4);
	bytes.writeUInt32LE(version, 8);
	bytes.writeUInt16LE(magic, 34);
	return bytes;
}

test("every font format is found by its bytes under a .bin name (file(1)'s formats, EOT, SVG)", () => {
	const pfbHeader = (text: string) => [0x80, 0x01, 0x10, 0x27, 0x00, 0x00, ...ascii(text)];
	const cases: Array<[string, Buffer, string]> = [
		["font.bin (woff2)", fakeBinary("wOF2"), "woff2"],
		["font.bin (woff)", fakeBinary("wOFF"), "woff"],
		["font.bin (OpenType CFF)", fakeBinary("OTTO"), "otf"],
		["font.bin (collection)", fakeBinary("ttcf"), "collection"],
		["font.bin (TrueType)", fakeBinary([0x00, 0x01, 0x00, 0x00]), "ttf"],
		["font.bin (Apple true)", fakeBinary("true"), "ttf (true)"],
		["font.bin (Apple typ1)", fakeBinary("typ1"), "ttf (typ1)"],
		["font.bin (EOT v1)", fakeEot({ version: 0x00010000 }), "eot"],
		["font.bin (EOT v2.1)", fakeEot({ version: 0x00020001 }), "eot"],
		["font.bin (EOT v2.2)", fakeEot({ version: 0x00020002 }), "eot"],
		["font.bin (Type 1 PFB)", fakeBinary(pfbHeader("%!PS-AdobeFont-1.0: X 001")), "type1 (pfb)"],
		[
			"font.bin (Type 1 PFB, FontType1)",
			fakeBinary(pfbHeader("%!FontType1-1.0: X")),
			"type1 (pfb)",
		],
		["font.bin (X11 PCF)", fakeBinary([0x01, 0x66, 0x63, 0x70]), "pcf"],
		["font.bin (PFR)", fakeBinary("PFR1"), "pfr"],
		[
			"font.bin (Type 1 PFA)",
			Buffer.from("%!PS-AdobeFont-1.0: X 001\n/FontName /X def\n"),
			"type1 (pfa)",
		],
		["font.bin (Type 1 resource)", Buffer.from("%!PS-Adobe-3.0 Resource-Font\n"), "type1 (pfa)"],
		[
			"font.bin (Type 42)",
			Buffer.from("%!PS-TrueTypeFont-1.0\n/sfnts [<00010000>] def\n"),
			"type42",
		],
		["font.bin (BDF)", Buffer.from("STARTFONT 2.1\nFONT -x-\nSIZE 16 75 75\n"), "bdf"],
		["font.bin (FontForge)", Buffer.from("SplineFontDB: 3.2\nFontName: X\n"), "fontforge"],
	];
	for (const [name, bytes, format] of cases)
		assert.equal(fontMagic(bytes, bytes.length), format, name);
});

test("EOT needs its header facts; near misses and the controls are not fonts", () => {
	// EOT: the magic alone is not enough, and neither is a header over a file of another size.
	assert.equal(fontMagic(fakeEot({ magic: 0x4c50 })), null, "MagicNumber byte-swapped");
	assert.equal(fontMagic(fakeEot({ version: 0x00030000 })), null, "an undefined Version");
	assert.equal(fontMagic(fakeEot({ eotSize: 5000 })), null, "EOTSize past the end of the file");
	assert.equal(fontMagic(fakeEot({ fontDataSize: 0 })), null, "no font data");
	assert.equal(
		fontMagic(fakeEot({ eotSize: 3000, fontDataSize: 3500 })),
		null,
		"font data past EOTSize",
	);
	// An EOT with bytes appended after its structure is still an EOT.
	assert.equal(fontMagic(fakeEot({ eotSize: 3000, fontDataSize: 2800 })), "eot", "a padded EOT");
	// A plain binary (an image, a build artifact) and plain text are not fonts.
	assert.equal(fontMagic(fakeBinary([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
	assert.equal(fontMagic(fakeBinary("GIF89a")), null);
	assert.equal(fontMagic(Buffer.from("# Notes\n\nThe font is loaded from the kit.\n")), null);
	// An ordinary SVG icon is not a font; `<font` without glyphs is not either.
	assert.equal(fontMagic(Buffer.from('<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>')), null);
	assert.equal(fontMagic(Buffer.from("<svg><text><font>legacy</font></text></svg>")), null);
	// A text format's signature in a binary file, and a binary one's in text, do not count.
	assert.equal(fontMagic(fakeBinary("STARTFONT ")), null);
	assert.equal(fontMagic(Buffer.from("typ1 is a word\n")), null);
});

test("a form that can stand anywhere is found anywhere: each one at byte 50,000, through the real read", () => {
	const dir = mkdtempSync(join(tmpdir(), "no-font-files-"));
	const at = (name: string, before: string | Buffer, font: string) => {
		const path = join(dir, name);
		const lead = typeof before === "string" ? Buffer.from(before) : before;
		writeFileSync(path, Buffer.concat([lead, Buffer.from(font)]));
		return fontsInFile(path);
	};
	const icons = `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0h1v1z"/>'.repeat(2400)}`;
	const prose = `${"The face loads from the kit. ".repeat(1750)}\n`;
	const binary = fakeBinary("GIF89a", 0, 50_000);
	const woff2 = fakeBinary("wOF2").toString("base64");
	for (const lead of [icons, prose]) assert.ok(Buffer.byteLength(lead) >= 50_000);
	// Each anywhere-form, past the old 8,000-byte window, in a text file and in a binary one.
	const cases: Array<[string, string | Buffer, string, string]> = [
		[
			"icons.svg",
			icons,
			'<defs><font id="x"><font-face font-family="X"/><glyph unicode="a" d="M0 0"/></font></defs></svg>',
			"svg font",
		],
		["page.md", prose, `src: url(data:font/woff2;base64,${woff2.slice(0, 40)})`, "data:font/woff2"],
		["face.ts", prose, `export const FACE = "${woff2}";`, "base64 d09GM"],
		[
			"figure.eps",
			prose,
			"%%BeginResource: font X\n%!PS-AdobeFont-1.0: X 001\n",
			"postscript font program",
		],
		["blob.bin", binary, `<svg><font><glyph d="M0 0"/></font></svg>`, "svg font"],
		["blob2.bin", binary, `x"${woff2}"`, "base64 d09GM"],
	];
	for (const [name, before, font, expected] of cases) {
		const found = at(name, before, font);
		assert.ok(
			found.some((f) => f.startsWith(expected)),
			`${name}: ${JSON.stringify(found)}`,
		);
	}
	// The controls: the same files without the font hold none.
	assert.deepEqual(at("icons-plain.svg", icons, "</svg>"), []);
	assert.deepEqual(at("page-plain.md", prose, "The end.\n"), []);
	assert.deepEqual(at("blob-plain.bin", binary, "trailer"), []);
});

/** An sfnt table directory (OpenType spec) for `tags`, with the header fields derived as the spec says. */
function sfntDirectory(
	version: number[] | string,
	tags: string[],
	{ searchRange }: { searchRange?: number } = {},
): Buffer {
	const n = tags.length;
	const power = n === 0 ? 1 : 2 ** Math.floor(Math.log2(n));
	const bytes = Buffer.alloc(12 + n * 16);
	Buffer.from(typeof version === "string" ? ascii(version) : version).copy(bytes, 0);
	bytes.writeUInt16BE(n, 4);
	bytes.writeUInt16BE(searchRange ?? power * 16, 6);
	bytes.writeUInt16BE(Math.log2(power), 8);
	bytes.writeUInt16BE(Math.max(0, n * 16 - power * 16), 10);
	tags.forEach((tag, i) => {
		Buffer.from(tag, "latin1").copy(bytes, 12 + i * 16);
		bytes.writeUInt32BE(0x1234_5678, 16 + i * 16);
		bytes.writeUInt32BE(256 + i * 64, 20 + i * 16);
		bytes.writeUInt32BE(64, 24 + i * 16);
	});
	return bytes;
}

const TRUETYPE_TAGS = ["cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"];

test("sfnt data is found by its table directory anywhere in a file: embedded, a .dfont, an OpenType CFF", () => {
	const dir = mkdtempSync(join(tmpdir(), "no-font-files-sfnt-"));
	const write = (name: string, bytes: Buffer) => {
		const path = join(dir, name);
		writeFileSync(path, bytes);
		return fontsInFile(path);
	};
	// TrueType tables embedded 1,000 bytes into an arbitrary binary.
	const lead = fakeBinary("GIF89a", 0, 1000);
	const tail = fakeBinary([0, 0], 0, 3000);
	assert.deepEqual(
		write("blob.bin", Buffer.concat([lead, sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS), tail])),
		["sfnt table directory at 1000"],
	);
	// A Mac .dfont: a resource fork whose font resource holds the sfnt data after a length word.
	const fork = Buffer.alloc(260);
	fork.writeUInt32BE(256, 0);
	fork.writeUInt32BE(4096, 256);
	assert.deepEqual(
		write("brand.dfont", Buffer.concat([fork, sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS), tail])),
		["sfnt table directory at 260"],
	);
	// An OpenType CFF font's directory, embedded.
	assert.deepEqual(
		write(
			"cff.bin",
			Buffer.concat([
				lead,
				sfntDirectory("OTTO", [
					"CFF ",
					"OS/2",
					"cmap",
					"head",
					"hhea",
					"hmtx",
					"maxp",
					"name",
					"post",
				]),
				tail,
			]),
		),
		["sfnt table directory at 1000"],
	);
});

test("an sfnt directory must be one: near misses and plain files hold none", () => {
	const lead = fakeBinary("GIF89a", 0, 1000);
	const at = (bytes: Buffer) =>
		sfntDirectories(Buffer.concat([lead, bytes, fakeBinary([0], 0, 600)]));
	// The control: the real thing is found.
	assert.deepEqual(at(sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS)), [1000]);
	// A version word alone, with what follows not a directory.
	assert.deepEqual(at(Buffer.from([0, 1, 0, 0, 0x7f, 0x13, 0x22, 0x01, 0, 0, 0, 0])), []);
	// A directory without cmap or head is not a font's.
	assert.deepEqual(at(sfntDirectory([0, 1, 0, 0], ["glyf", "hhea", "loca", "maxp"])), []);
	assert.deepEqual(at(sfntDirectory([0, 1, 0, 0], ["cmap", "glyf", "loca"])), []);
	// searchRange not as the spec derives it (nine tables: 8 * 16 = 0x80, not 0x40).
	assert.deepEqual(at(sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS, { searchRange: 0x40 })), []);
	// No tables, too many, or records cut off by the end of the file.
	assert.deepEqual(at(sfntDirectory([0, 1, 0, 0], [])), []);
	const many = sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS);
	many.writeUInt16BE(200, 4);
	assert.deepEqual(at(many), []);
	assert.deepEqual(
		sfntDirectories(
			Buffer.concat([lead, sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS).subarray(0, 60)]),
		),
		[],
	);
	// Tags that are not printable.
	const binaryTags = sfntDirectory([0, 1, 0, 0], TRUETYPE_TAGS);
	binaryTags[12] = 0x01;
	assert.deepEqual(at(binaryTags), []);
	// Plain files: noise, an image header, text.
	assert.deepEqual(sfntDirectories(fakeBinary("GIF89a", 0, 50_000)), []);
	assert.deepEqual(sfntDirectories(Buffer.from("cmap head glyf ".repeat(1000))), []);
});

test("a UFO glyph (outline source) is found; a glyph with no outline is not", () => {
	const glif =
		'<?xml version="1.0" encoding="UTF-8"?>\n<glyph name="a" format="2"><advance width="500"/><outline><contour><point x="0" y="0" type="line"/></contour></outline></glyph>\n';
	assert.deepEqual(inlineFonts(glif), ["ufo glyph"]);
	assert.deepEqual(
		inlineFonts('<glyph name="space" format="2"><advance width="250"/></glyph>'),
		[],
	);
});
