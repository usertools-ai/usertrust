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

test("no site source points at a local font file; every font URL is the kit's", () => {
	const sources = trackedFiles().filter(
		(f) =>
			f.startsWith("site/") &&
			/\.(?:tsx?|mts|mjs|js|css)$/.test(f) &&
			!/\.test\.(?:tsx?|mts)$/.test(f),
	);
	assert.ok(sources.includes("site/app/layout.tsx"), "the scan reaches the root layout");
	const offenders: string[] = [];
	for (const file of sources) {
		const text = readFileSync(join(REPO_ROOT, file), "utf8");
		for (const m of text.matchAll(/['"(`]([^'"()`\s]*\.(?:woff2?|ttf|otf|eot))['")`]/gi)) {
			if (!m[1]?.startsWith(KIT_FONTS)) offenders.push(`${file}: ${m[1]}`);
		}
	}
	assert.deepEqual(offenders, []);
});
