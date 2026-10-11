/**
 * Every remote byte the /r page can load, enumerated, and the receipt's text
 * kept off every remote byte that is not pinned.
 *
 * The page loads two kinds of remote bytes: the kit's lattice.js, pinned by
 * Subresource Integrity (brand-assets.test.tsx), and the kit's fonts, which
 * CSS cannot pin. A replaced font could remap glyphs so that the verdict or
 * the amount LOOKS unlike the text the page renders, and no text-based test
 * could see it. So the brand fonts dress the chrome only (the nav and the
 * footer), and everything inside the receipt renders in system stacks that
 * load nothing.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { LATTICE_SRC } from "./components/lattice-field";
import StateView from "./components/state-view";
import { fixtureState, loadFixture } from "./fixture-harness";

const ROUTE_DIR = fileURLToPath(new URL(".", import.meta.url));
const CSS = readFileSync(new URL("./brand.css", import.meta.url), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

/** A brand family, named or through the chrome-only tokens that carry one. */
const BRAND = /Usertools Sans|JetBrains Mono|Geist|var\(--sans\)|var\(--mono\)/;
/** The chrome: the only selectors a brand family may reach. */
const CHROME = [
	/^\.ut-r \.ut-r-nav\b/,
	/^\.ut-r-nav\b/,
	/^\.ut-r \.brand\b/,
	/^\.ut-r footer\.site\b/,
];

interface Rule {
	selectors: string[];
	declarations: Array<[string, string]>;
}

/** brand.css's rules (an @media block's inner rules included), comments stripped. */
const RULES: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
	selectors: match[1]
		.trim()
		.split(",")
		.map((selector) => selector.trim()),
	declarations: match[2]
		.split(";")
		.map((declaration): [string, string] => {
			const colon = declaration.indexOf(":");
			return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
		})
		.filter(([property]) => property.length > 0),
}));

/** A token's value in the `.ut-r` block, `var()` followed to a literal stack. */
function resolve(value: string): string {
	return value.replace(/var\((--[a-z-]+)\)/g, (_, token: string) => {
		const declared = RULES.find((rule) => rule.selectors.includes(".ut-r"))?.declarations.find(
			([property]) => property === token,
		)?.[1];
		return declared === undefined ? assert.fail(`.ut-r declares no ${token}`) : resolve(declared);
	});
}

test("brand fonts reach the chrome only: no other selector names a brand family", () => {
	let chromeRules = 0;
	for (const rule of RULES) {
		if (rule.selectors.join() === "@font-face") continue;
		// The chrome-only tokens themselves are declared on .ut-r; declaring is not using.
		const uses = rule.declarations.filter(
			([property, value]) => property !== "--sans" && property !== "--mono" && BRAND.test(value),
		);
		if (uses.length === 0) continue;
		for (const selector of rule.selectors) {
			assert.ok(
				CHROME.some((chrome) => chrome.test(selector)),
				`${selector} { ${uses.map(([p, v]) => `${p}: ${v}`).join("; ")} } puts a brand font outside the chrome`,
			);
		}
		chromeRules += 1;
	}
	assert.ok(chromeRules >= 3, "the nav, its mark and the footer do use the brand");
});

test("the receipt's own fonts are system stacks: the route default and every font utility", () => {
	const root = RULES.find((rule) => rule.selectors.includes(".ut-r"));
	assert.ok(root, "brand.css has the .ut-r block");
	for (const property of ["font-family", "--font-sans", "--font-mono", "--font-display"]) {
		const value = root.declarations.find(([p]) => p === property)?.[1];
		assert.ok(value, `.ut-r declares ${property}`);
		const stack = resolve(value);
		assert.doesNotMatch(stack, BRAND, `${property} resolves to ${stack}`);
		assert.match(stack, /system-ui|ui-monospace/, `${property} is a system stack: ${stack}`);
	}
	const main = RULES.find((rule) => rule.selectors.includes(".ut-r .ut-r-main"));
	assert.equal(
		main?.declarations.find(([p]) => p === "font-variant-numeric")?.[1],
		"tabular-nums",
		"amounts set in tabular figures",
	);
	// The layout keeps the chrome outside the receipt's container.
	const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
	const mainAt = layout.indexOf('className="ut-r-main');
	assert.ok(
		mainAt > layout.indexOf("</nav>") && mainAt < layout.indexOf("<SiteFooter"),
		"nav | main | footer",
	);
});

test("no rendered receipt state sets a font of its own (no inline font, no chrome class)", () => {
	for (const file of [
		"cluster/first.json",
		"cluster/superseded.json",
		"session-owner-estimated.json",
		"expired.json",
		"billed-unfinalized.json",
		"not-minted.json",
	]) {
		const markup = renderToStaticMarkup(<StateView state={fixtureState(loadFixture(file))} />);
		assert.doesNotMatch(markup, /font-family/i, `${file}: no inline font`);
		for (const match of markup.matchAll(/class="([^"]*)"/g)) {
			for (const token of match[1].split(/\s+/)) {
				assert.ok(!["ut-r-nav", "brand", "site"].includes(token), `${file}: chrome class ${token}`);
			}
		}
	}
});

/** Every non-test source file of the route, as text with comments removed. */
function routeSources(): Array<[string, string]> {
	const walk = (dir: string, prefix = ""): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			if (statSync(path).isDirectory())
				return name === "fixtures" ? [] : walk(path, `${prefix}${name}/`);
			return [`${prefix}${name}`];
		});
	return walk(ROUTE_DIR)
		.filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
		.map((file) => [
			file,
			readFileSync(join(ROUTE_DIR, file), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, ""),
		]);
}

test("every external URL the route names is classified: pinned script, chrome font, link, or server read", () => {
	const KIT_FONT = /^https:\/\/usertrust\.ai\/kit\/fonts\/[A-Za-z-]+\.woff2$/;
	const LINKS = new Set([
		"https://usertrust.ai/",
		"https://usertrust.ai/#first-receipt",
		"https://usertrust.ai/docs/verify",
		"https://usertrust.ai/docs/",
		"https://github.com/usertools-ai/usertrust",
		"https://www.npmjs.com/package/usertrust",
		"https://github.com/usertools-ai/usertrust/blob/master/LICENSE",
		"https://usertools.ai",
	]);
	const SERVER = "https://api.usertools.ai/v1/receipts";
	const seen = new Set<string>();
	for (const [file, text] of routeSources()) {
		for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>,]+/g)) {
			const url = match[0];
			seen.add(url);
			const before = text.slice(Math.max(0, match.index - 40), match.index);
			if (KIT_FONT.test(url)) {
				// A font: only ever an @font-face source, whose family reaches the chrome only (above).
				assert.equal(file, "brand.css", `${url} in ${file}`);
				assert.match(before, /src:url\(['"]?$/, `${url} is an @font-face source`);
			} else if (url === LATTICE_SRC) {
				// The one script: appended with its integrity pin (brand-assets.test.tsx pins the value).
				assert.equal(file, "components/lattice-field.tsx", `${url} in ${file}`);
				assert.match(text, /script\.integrity = LATTICE_INTEGRITY;/, "the script is pinned");
				assert.match(text, /script\.crossOrigin = "anonymous";/, "fetched in CORS mode");
			} else if (LINKS.has(url)) {
				// A link loads nothing until it is followed.
				assert.match(before, /href(=|:\s*)\{?["']$/, `${url} in ${file} is an href`);
			} else if (url === SERVER) {
				// The resolver read happens on the server; no client module names it.
				assert.equal(file, "lib/resolve.ts", `${url} in ${file}`);
				assert.doesNotMatch(text, /^["']use client["']/m, "resolve.ts is server code");
			} else {
				assert.fail(
					`${file} names ${url}: classify it (pin it, keep it to the chrome, or make it a link)`,
				);
			}
		}
	}
	// The enumeration is not vacuous: it found the fonts, the script, the links and the server read.
	assert.equal([...seen].filter((url) => KIT_FONT.test(url)).length, 5);
	assert.ok(seen.has(LATTICE_SRC));
	assert.ok(seen.has(SERVER));
	assert.ok(
		[...LINKS].every((url) => seen.has(url)),
		"every link is still where it was",
	);
});
