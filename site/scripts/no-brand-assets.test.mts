/**
 * No brand image is tracked in this repository, bar one settled exception (`BRAND_EXCEPTIONS`). Brand assets (the mascot, the posters, the
 * favicon mark, the lattice and the kit's other files) load at runtime from the brand kit,
 * https://usertrust.ai/kit/, which serves them with `access-control-allow-origin: *`; the site keeps
 * their URLs in `app/lib/kit-images.ts`. Anything tracked here would read as Apache-licensed.
 *
 * What this guard catches, over every path `git ls-files` lists from the repository root:
 * - a tracked path with a DIRECTORY named `brand` (any case), and a tracked file whose name
 *   starts with `mascot` (any case), except the EXACT paths in `BRAND_EXCEPTIONS`;
 * - an EXACT copy of a kit file, by its bytes: no tracked file may hash (sha256) to any entry
 *   of `KIT_SHA256`, whatever its name or path.
 *
 * What it does NOT catch: a MODIFIED copy. A brand image that is resized, cropped,
 * re-encoded or re-compressed has new bytes and a new hash, and passes this guard. Such a
 * file still breaks the rule, so any image added to the repository needs a person's review.
 * The exception is settled and narrow: the one logo `usertrust-ui` displays, and the licence that says
 * it is not Apache-2.0. A third file in that folder, a second mark anywhere, or the same name in another
 * case fails. Its bytes are pinned by `packages/ui/tests/brand-mark.test.ts`. Fonts have their own guard and are not listed here. The marks drawn in code (SVG and CSS in
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
 * (served at https://usertrust.ai/kit/<path>). A new kit file adds its line here. The email-signature
 * PNGs are kit files too: mail clients load them from the kit, and none may be committed here. When
 * the kit replaces a file, the old bytes stay listed as `(retired)` and the new bytes get their own
 * row, as the five earlier email-signature PNGs are.
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
		kit: "images/favicon.svg (retired)",
	},
	{
		sha256: "875022ea41c74041947a74cd611d0d4e084975a71e534c681e146a4612a1f98f",
		kit: "images/favicon.svg",
	},
	{
		sha256: "653c4d87654b7aeaaedaef4c68aeef3cd7054f4fccab5483c1545c0d33ede3e9",
		kit: "images/brand-mark-usertools-signature-4x.png",
	},
	{
		sha256: "c29cd1b3eb7c50e2d188a62a3f053498a983cdcd5c1e7cca25e6f5ac915ca187",
		kit: "images/brand-mark-usertools-signature-2x.png",
	},
	{
		sha256: "6110931e1bfaea749872b3d4cea5c17eea752bf8fe2757240cf39b89202d2e98",
		kit: "images/brand-mark-usertrust-signature-4x.png",
	},
	{
		sha256: "d297ac9f8df8cbef708cb979bbde35bee289efcb39e37d1372e151f43951d274",
		kit: "images/brand-mark-userintel-signature-4x.png",
	},
	{
		sha256: "4facc7e1f5bf02cfb8aeab453eb60ce04f15d15e4e9f0bc83fe41e8ac1390b3d",
		kit: "images/brand-mark-usermemory-signature-4x.png",
	},
	{
		sha256: "d6af6342077c38e93c6c1caab569cf5196327516d0d7cb85598c9e2cbb57b14d",
		kit: "images/brand-mark-userbank-signature-4x.png",
	},
	{
		sha256: "9b9c964e71fc241482abc8c6d0aa3d887f9c9de30526d50a53ac24d0ded2c6e3",
		kit: "images/brand-mark-usertokens-signature-4x.png",
	},
	{
		sha256: "6c72d72b8d53c600e629bcdd0afb2ab7515167497bf2eef149a7a8699e4d0d56",
		kit: "images/wordmark-light-email@2x.png (retired)",
	},
	{
		sha256: "034c33882acd0aa0d4ca835193458aef68188c94a0c44ac176bde244141d5c4b",
		kit: "images/wordmark-light-email@3x.png (retired)",
	},
	{
		sha256: "a69c2b0ba1c31cca818a165a67e4393514d3ac78288553dd46dcf1fd64273ac9",
		kit: "images/brand-lockup-light-24@2x.png (retired)",
	},
	{
		sha256: "5f3371f38fc6731c87bf8812906471f2ad43ca5aae1cda52d990a6d8c4313a45",
		kit: "images/brand-lockup-light-32@2x.png (retired)",
	},
	{
		sha256: "4fe9d589907615847983748b81d7ee7bb00eea493d1a2d1c6eac5186252d7877",
		kit: "images/brand-lockup-light-42@2x.png (retired)",
	},
];

/**
 * The only paths allowed under a `brand/` directory, matched EXACTLY (case-sensitively, whole path). Each
 * carries its reason. Adding a path here is a decision for the owner of the brand, never a convenience.
 */
export const BRAND_EXCEPTIONS: ReadonlyArray<{ path: string; why: string }> = [
	{
		path: "packages/ui/brand/usertrust-mark.svg",
		why: "the one logo usertrust-ui bundles into its header; not Apache-2.0, see packages/ui/brand/LICENSE",
	},
	{
		path: "packages/ui/brand/LICENSE",
		why: "states that the mark beside it is not licensed under Apache-2.0",
	},
];

/** Every path git tracks, repo-relative. Fails, never passes, if git cannot list. */
function trackedFiles(): string[] {
	const r = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
	assert.equal(r.status, 0, `git ls-files failed (status ${r.status}): ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/**
 * The paths among `paths` that sit under a directory named `brand`, or are named `mascot*`, other than the
 * exact `BRAND_EXCEPTIONS`.
 */
export function brandPaths(paths: readonly string[]): string[] {
	const allowed = new Set(BRAND_EXCEPTIONS.map((row) => row.path));
	return paths.filter((path) => {
		if (allowed.has(path)) return false;
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

test("the brand exception is exactly the mark and its licence, and nothing beside them", () => {
	assert.deepEqual(
		BRAND_EXCEPTIONS.map((row) => row.path),
		["packages/ui/brand/usertrust-mark.svg", "packages/ui/brand/LICENSE"],
	);
	// The exceptions pass...
	assert.deepEqual(
		brandPaths(BRAND_EXCEPTIONS.map((row) => row.path)),
		[],
		"the two exception paths are allowed",
	);
	// ...and everything else near them fails: a second file in the folder, another mark, the same
	// name in another case or directory, a nested path, and a mascot file inside the folder.
	const near = [
		"packages/ui/brand/second-mark.svg",
		"packages/ui/brand/usertrust-mark.png",
		"packages/ui/brand/NOTICE",
		"packages/ui/brand/usertrust-mark.svg.bak",
		"packages/ui/brand/sub/usertrust-mark.svg",
		"packages/ui/Brand/usertrust-mark.svg",
		"packages/ui/brand/Usertrust-Mark.svg",
		"packages/ui/brand/license",
		"packages/server/brand/usertrust-mark.svg",
		"brand/usertrust-mark.svg",
		"packages/ui/brand/mascot.png",
	];
	assert.deepEqual(brandPaths(near), near);
});

test("every denylist entry is a sha256 with a kit path, and the list holds the brand images", () => {
	assert.equal(KIT_SHA256.length, 26, "the kit's 20 non-font files, plus six retired files");
	assert.equal(new Set(KIT_SHA256.map((row) => row.sha256)).size, 26, "no hash listed twice");
	for (const { sha256, kit } of KIT_SHA256) {
		assert.match(sha256, /^[0-9a-f]{64}$/, `${kit}: a sha256 in hex`);
		assert.ok(kit.length > 0 && !kit.startsWith("fonts/"), `${sha256}: a non-font kit path`);
	}
	for (const image of [
		"images/mascot-panel.jpg",
		"images/intro-poster.jpg",
		"images/intro-first.jpg",
		"images/favicon.svg",
		"images/brand-mark-usertools-signature-4x.png",
		"images/brand-mark-usertools-signature-2x.png",
		"images/brand-mark-usertrust-signature-4x.png",
		"images/brand-mark-userintel-signature-4x.png",
		"images/brand-mark-usermemory-signature-4x.png",
		"images/brand-mark-userbank-signature-4x.png",
		"images/brand-mark-usertokens-signature-4x.png",
		"images/wordmark-light-email@2x.png (retired)",
		"images/wordmark-light-email@3x.png (retired)",
		"images/brand-lockup-light-24@2x.png (retired)",
		"images/brand-lockup-light-32@2x.png (retired)",
		"images/brand-lockup-light-42@2x.png (retired)",
	]) {
		assert.ok(
			KIT_SHA256.some((row) => row.kit === image),
			`${image} is denylisted`,
		);
	}

	const favicon = KIT_SHA256.find((row) => row.kit === "images/favicon.svg");
	assert.equal(
		favicon?.sha256,
		"875022ea41c74041947a74cd611d0d4e084975a71e534c681e146a4612a1f98f",
		"the kit's current favicon is denylisted",
	);
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

/**
 * The sha256 of the one logo this repository may hold, `packages/ui/brand/usertrust-mark.svg`. It is not in
 * `KIT_SHA256` (that lists the kit's files), so without this a byte-identical copy of the mark under any other name or
 * folder (say `site/public/logo.svg`) would pass the byte check. Pinned equal to the hash in
 * `packages/ui/tests/brand-mark.test.ts`.
 */
export const MARK_SHA256 = "e1136ed9518bbc08d6d92259ac9575b536c28c88c6261698ee2e250962f5c2b7";

/** Each of `paths`, other than the allowed mark itself, whose bytes are the mark's. */
export function markCopies(
	paths: readonly string[],
	hashOf: (path: string) => string = sha256Of,
): string[] {
	return paths.filter(
		(path) => path !== "packages/ui/brand/usertrust-mark.svg" && hashOf(path) === MARK_SHA256,
	);
}

test("the usertrust mark exists exactly once: no tracked file elsewhere is a byte-for-byte copy of it", () => {
	const files = trackedFiles();
	assert.ok(
		files.includes("packages/ui/brand/usertrust-mark.svg"),
		"the control: the one allowed mark is tracked and is what the scan compares against",
	);
	assert.equal(
		sha256Of("packages/ui/brand/usertrust-mark.svg"),
		MARK_SHA256,
		"the pinned hash is the mark's",
	);
	assert.deepEqual(
		markCopies(files),
		[],
		"the mark is bundled from packages/ui/brand/, never copied elsewhere",
	);
	// The control: the scan does flag a copy under another name and folder.
	assert.deepEqual(
		markCopies(["site/public/logo.svg", "packages/ui/brand/usertrust-mark.svg"], () => MARK_SHA256),
		["site/public/logo.svg"],
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
