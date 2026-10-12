/**
 * No brand image is tracked in this repository. Brand assets (the mascot, the posters, the
 * favicon mark, the lattice and the kit's other files) load at runtime from the brand kit,
 * https://usertrust.ai/kit/, which serves them with `access-control-allow-origin: *`; the site keeps
 * their URLs in `app/lib/kit-images.ts`. Anything tracked here would read as Apache-licensed.
 *
 * What this guard catches, over every path `git ls-files` lists from the repository root:
 * - a tracked path with a DIRECTORY named `brand` (any case), and a tracked file whose name
 *   starts with `mascot` (any case);
 * - an EXACT copy of a kit file, by its bytes: no tracked file may hash (sha256) to any entry
 *   of `KIT_SHA256`, whatever its name or path.
 *
 * What it does NOT catch: a MODIFIED copy. A brand image that is resized, cropped,
 * re-encoded or re-compressed has new bytes and a new hash, and passes this guard. Such a
 * file still breaks the rule, so any image added to the repository needs a person's review.
 * Fonts have their own guard and are not listed here. The marks drawn in code (SVG and CSS in
 * the site's components and stylesheets) are not files this guard can see; they are pending
 * review.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");

/**
 * The sha256 of every file the brand kit serves, except its fonts, each with its kit path
 * (served at https://usertrust.ai/kit/<path>). A new kit file adds its line here.
 */
export const KIT_SHA256: ReadonlyArray<{ sha256: string; kit: string }> = [
	{ sha256: "9d345f2669d6c32fd9c31e1b66cfebaf2f3774d051d1a8be491ea8c525ff73fd", kit: "lattice.js" },
	{
		sha256: "199c14e2491cef4338cd9a8bad2cc99e2cda68edb6cdcc67bb51f534d942a858",
		kit: "lattice.656d18469f75.js",
	},
	{
		sha256: "dae1fd07fa9d2fb3916642c52e8b68f637abf0e6ba122db902e5657ac5a12dde",
		kit: "card-frame.482f6c2af97b.svg",
	},
	{ sha256: "e004fef006e50c582d95aae2aedc5eb9d94eb211759543c98310b89babb2d324", kit: "die.js" },
	{
		sha256: "022e0a426a2715ee2a91842808d52d0aec5c8a871bd05f2d0db8444196fa1433",
		kit: "renderer.js",
	},
	{
		sha256: "615c9031caeb7f9318b46aa5d99f9c7c27718a9bf60c99c8d6dbd13a1bd3b8e9",
		kit: "quickstart.js",
	},
	{ sha256: "c927491d28894aa81ede72ead01fc59a5c182f320436021a0d3119ef717b07ed", kit: "copy.js" },
	{ sha256: "83b23235a46b3ab483d53939e7dca9e995c58187b4498246c3895ae77bc00136", kit: "copy.css" },
	{ sha256: "ca07bdea886781e502b8a62e484a6733060c23f7ee0f7d22257a477f3391cdcd", kit: "docs.css" },
	{
		sha256: "66b45677f4007640c8422c3b48d77622955f5f32a1cb230e093026efaf8053e5",
		kit: "images/mascot-panel.jpg",
	},
	{
		sha256: "9b077e5be091ecad457206f8ccec9f6613377c28050ece1f34d9fbdb8eb38388",
		kit: "images/intro-poster.jpg",
	},
	{
		sha256: "0c34b6f433b771c5eecd421ce9873211f2906a59b74692edef41852f1cdd030f",
		kit: "images/intro-first.jpg",
	},
	{
		sha256: "e7d27f0c2d7edf145ae885edea82329227eb87533bab3647344b5971e14afc22",
		kit: "images/favicon.svg",
	},
];

/** Every path git tracks, repo-relative. Fails, never passes, if git cannot list. */
function trackedFiles(): string[] {
	const r = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
	assert.equal(r.status, 0, `git ls-files failed (status ${r.status}): ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/** The paths among `paths` that sit under a directory named `brand`, or are named `mascot*`. */
export function brandPaths(paths: readonly string[]): string[] {
	return paths.filter((path) => {
		const segments = path.split("/");
		const name = segments.pop() ?? "";
		return segments.some((dir) => dir.toLowerCase() === "brand") || /^mascot/i.test(name);
	});
}

/** A file's sha256, hex. The path is repo-relative, or absolute. */
export function sha256Of(path: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(REPO_ROOT, path)))
		.digest("hex");
}

/** Each of `paths` whose bytes hash to an entry of `denylist`, with the kit file it copies. */
export function kitCopies(
	paths: readonly string[],
	denylist: ReadonlyArray<{ sha256: string; kit: string }> = KIT_SHA256,
): string[] {
	const kitBySha = new Map(denylist.map((row) => [row.sha256, row.kit]));
	return paths.flatMap((path) => {
		const kit = kitBySha.get(sha256Of(path));
		return kit === undefined ? [] : [`${path}: an exact copy of kit/${kit}`];
	});
}

test("no tracked path sits under a brand/ directory, and no tracked file is named mascot*", () => {
	const files = trackedFiles();
	// The control: this is the whole repository's listing, not an empty or partial one.
	assert.ok(files.includes("AGENTS.md"), "the listing reaches the repository root");
	assert.ok(files.includes("site/package.json"), "the listing reaches site/");
	assert.ok(
		files.some((f) => f.startsWith("packages/")),
		"the listing reaches packages/",
	);
	assert.deepEqual(
		brandPaths(files),
		[],
		"brand assets load from https://usertrust.ai/kit/ at runtime, never committed",
	);
});

test("the path rule: a brand/ directory at any depth and in any case, and a mascot* file name", () => {
	assert.deepEqual(
		brandPaths([
			"site/public/brand/mascot-panel.jpg",
			"brand/logo.svg",
			"packages/x/Brand/a.png",
			"site/public/BRAND/b/c.txt",
			"docs/Mascot.PNG",
			"site/public/img/mascot-mark.png",
			"mascots.md",
			// not caught: a FILE named brand, or a name with brand in it, or mascot later in a name
			"site/app/r/brand.css",
			"site/app/r/brand-assets.test.tsx",
			"site/brand",
			"site/branding/a.png",
			"site/public/the-mascot.png",
			"site/mascot/readme.txt",
		]),
		[
			"site/public/brand/mascot-panel.jpg",
			"brand/logo.svg",
			"packages/x/Brand/a.png",
			"site/public/BRAND/b/c.txt",
			"docs/Mascot.PNG",
			"site/public/img/mascot-mark.png",
			"mascots.md",
		],
	);
});

test("every denylist entry is a sha256 with a kit path, and the list holds the brand images", () => {
	assert.equal(KIT_SHA256.length, 13, "the kit's 13 non-font files");
	assert.equal(new Set(KIT_SHA256.map((row) => row.sha256)).size, 13, "no hash listed twice");
	for (const { sha256, kit } of KIT_SHA256) {
		assert.match(sha256, /^[0-9a-f]{64}$/, `${kit}: a sha256 in hex`);
		assert.ok(kit.length > 0 && !kit.startsWith("fonts/"), `${sha256}: a non-font kit path`);
	}
	for (const image of [
		"images/mascot-panel.jpg",
		"images/intro-poster.jpg",
		"images/intro-first.jpg",
		"images/favicon.svg",
	]) {
		assert.ok(
			KIT_SHA256.some((row) => row.kit === image),
			`${image} is denylisted`,
		);
	}
});

test("no tracked file is an exact copy of a kit file, by its bytes", () => {
	const files = trackedFiles();
	// The control: the scan reads the whole repository, text and binary.
	assert.ok(files.length > 100, "the listing is the whole repository");
	assert.ok(files.includes("site/app/layout.tsx"), "the scan reaches the root layout");
	assert.ok(
		files.some((f) => f.endsWith(".jpg") || f.endsWith(".mp4")),
		"the scan reaches binary files",
	);
	assert.deepEqual(
		kitCopies(files),
		[],
		"brand assets load from https://usertrust.ai/kit/ at runtime, never committed",
	);
});

test("an exact copy is caught by its bytes, under any name; one changed byte is not (the declared gap)", () => {
	const dir = mkdtempSync(join(tmpdir(), "no-brand-assets-"));
	const planted = Buffer.alloc(4096);
	for (let i = 0; i < planted.length; i += 1) planted[i] = (i * 7919) % 251;
	const copy = join(dir, "harmless-name.bin");
	writeFileSync(copy, planted);
	const altered = join(dir, "altered.bin");
	const changed = Buffer.from(planted);
	changed[100] = (changed[100] ?? 0) ^ 0xff;
	writeFileSync(altered, changed);
	const plain = join(dir, "plain.txt");
	writeFileSync(plain, "not a kit file\n");

	const denylist = [
		...KIT_SHA256,
		{ sha256: createHash("sha256").update(planted).digest("hex"), kit: "images/planted.jpg" },
	];
	// Through the same function the repository scan uses: the planted copy is found by its hash.
	assert.deepEqual(kitCopies([copy, altered, plain], denylist), [
		`${copy}: an exact copy of kit/images/planted.jpg`,
	]);
	// And with the real denylist, none of these is a kit file.
	assert.deepEqual(kitCopies([copy, altered, plain]), []);
});
