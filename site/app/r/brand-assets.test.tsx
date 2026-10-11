/**
 * No brand asset lives in this public repository. The receipt page loads its
 * fonts and its lattice at runtime from the brand site's kit
 * (https://usertrust.ai/kit/), so the route must neither carry a font file or a
 * lattice copy nor point at one anywhere else.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import LatticeField, {
	appendLatticeScript,
	LATTICE_INTEGRITY,
	LATTICE_SRC,
} from "./components/lattice-field";

const ROUTE_DIR = fileURLToPath(new URL(".", import.meta.url));
const KIT = "https://usertrust.ai/kit/";

/** Every file under `dir`, recursively, as a path relative to `dir`. */
function filesUnder(dir: string, prefix = ""): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory()
			? filesUnder(path, `${prefix}${name}/`)
			: [`${prefix}${name}`];
	});
}

/** The asset files this route must never carry, by name. Exported for the mutation check. */
export function brandAssetFiles(dir: string): string[] {
	return filesUnder(dir).filter(
		(file) => /\.(woff2?|ttf|otf)$/i.test(file) || /(^|\/)lattice\.js$/.test(file),
	);
}

test("no font file and no lattice copy exists anywhere under site/app/r/", () => {
	assert.deepEqual(brandAssetFiles(ROUTE_DIR), []);
});

test("every @font-face in brand.css loads from the brand kit, with swap and a fallback stack", () => {
	const css = readFileSync(new URL("./brand.css", import.meta.url), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
	const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
	assert.equal(faces.length, 5, "Usertools Sans 400/500/700 and JetBrains Mono 400/500");
	for (const face of faces) {
		const urls = [...face.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
		assert.ok(urls.length > 0, `a src url: ${face}`);
		for (const url of urls) assert.ok(url.startsWith(`${KIT}fonts/`), `${url} is the kit's`);
		assert.match(face, /font-display:\s*swap/, "font-display: swap");
	}
	// The stacks fall back to system fonts when the kit is unreachable.
	assert.match(css, /--sans:'Usertools Sans',[^;]*sans-serif/);
	assert.match(css, /--mono:'JetBrains Mono',[^;]*monospace/);
});

test("the lattice loads from the brand kit at runtime, and the field stays a decorative canvas", () => {
	assert.equal(LATTICE_SRC, `${KIT}lattice.js`);
	const html = renderToStaticMarkup(<LatticeField />);
	assert.match(html, /<canvas /);
	assert.match(html, /id="field"/);
	assert.match(html, /data-network/);
	assert.match(html, /data-accent="gold"/);
	assert.match(html, /data-mode="wave-once"/);
	assert.match(html, /aria-hidden="true"/);
	const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
	assert.ok(layout.includes("<LatticeField />"), "the route layout renders the field");
});

test("the kit's lattice script is appended once, in the usertrust (gold) theme", () => {
	type FakeScript = {
		src: string;
		async: boolean;
		integrity: string;
		crossOrigin: string | null;
		dataset: Record<string, string>;
	};
	const appended: FakeScript[] = [];
	const doc = {
		querySelector: (selector: string) =>
			appended.find((script) => selector === `script[src="${script.src}"]`) ?? null,
		createElement: (): FakeScript => ({
			src: "",
			async: false,
			integrity: "",
			crossOrigin: null,
			dataset: {},
		}),
		body: { appendChild: (script: FakeScript) => appended.push(script) },
	} as unknown as Document;
	appendLatticeScript(doc);
	appendLatticeScript(doc);
	assert.equal(appended.length, 1, "appended once, however often the field mounts");
	assert.equal(appended[0]?.src, LATTICE_SRC);
	assert.equal(appended[0]?.async, true);
	assert.equal(appended[0]?.dataset.theme, "usertrust", "gold, never the settlement spectrum");
	// Pinned: the browser runs these bytes or nothing.
	assert.equal(appended[0]?.integrity, LATTICE_INTEGRITY);
	assert.equal(
		appended[0]?.crossOrigin,
		"anonymous",
		"a CORS fetch, so the integrity check can run",
	);
});

test("the lattice's integrity pin is the reviewed sha384 of the kit's lattice.js", () => {
	// The hash of the 27,327-byte file the kit served when this pin was set.
	// A kit update must change this line, and so this test, in review.
	assert.equal(
		LATTICE_INTEGRITY,
		"sha384-7yb4l6jM/tzLwkgPjiRrtn1uHNkOZ8hLcY+Z5WE/A7SzN6uozT02+rYtRhKK2oNg",
	);
	assert.match(LATTICE_INTEGRITY, /^sha384-[A-Za-z0-9+/]{64}$/);
});

test("no source under site/app/r/ points at a local font or a vendored lattice", () => {
	for (const file of filesUnder(ROUTE_DIR)) {
		if (!/\.(tsx?|css)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
		const text = readFileSync(join(ROUTE_DIR, file), "utf8");
		assert.doesNotMatch(text, /vendor\/lattice/, `${file}: no vendored lattice`);
		// Every font path any source names, in CSS url() or a TS string, is the kit's.
		for (const m of text.matchAll(/['"(]([^'"()\s]*\.(?:woff2?|ttf|otf))['")]/g)) {
			assert.ok(m[1].startsWith(`${KIT}fonts/`), `${file}: ${m[1]} is not the kit's`);
		}
	}
});
