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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const KIT_FONTS = "https://usertrust.ai/kit/fonts/";

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;

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
			"site/public/fonts/OFL.txt",
			"g.woff2.md",
			"woff2",
		]),
		["site/public/fonts/A.woff2", "B.WOFF", "packages/x/tests/fixtures/c.ttf", "d.otf", "e/f.eot"],
	);
});

test("every allowlisted font file is tracked and carries a reason", () => {
	const files = new Set(trackedFiles());
	for (const [path, reason] of Object.entries(ALLOWED_FONT_FILES)) {
		assert.ok(files.has(path), `${path} is allowlisted but not tracked; remove the entry`);
		assert.ok(reason.trim().length > 0, `${path} needs a reason`);
	}
});

/** Whether `bytes` is text: no NUL byte in its first 8000, the test git itself uses. */
function isText(bytes: Uint8Array): boolean {
	return !bytes.subarray(0, 8000).includes(0);
}

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
