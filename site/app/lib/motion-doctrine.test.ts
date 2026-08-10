import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * THE AMBIENT CLASS, PINNED TO THE STYLESHEET.
 *
 * The motion doctrine says nothing on this page loops except ambient-class
 * elements, and defines that class by criteria rather than by a list: cheap
 * properties only, paused offscreen by an IntersectionObserver, static under
 * reduced motion, decorative texture that is never the content.
 *
 * "Cheap properties only" was written as `transform`/`stroke-dashoffset` when
 * the die was the only loop in existence. The fork's decision beat and outcome
 * flashes fade, so the wording was amended (2026-08-09) to name the full set —
 * `transform`, `opacity`, `stroke-dashoffset` — and this file is what keeps
 * that amendment BOUNDED. The criterion's purpose is compositor safety, and
 * opacity is the cheapest of the three: transform and opacity are the two
 * properties a compositor animates without repainting anything, while a
 * dash-offset shift re-rasterises the path every frame. Excluding the cheaper
 * property while permitting the dearer one inverted the ordering the criterion
 * exists to enforce; a fourth name — `fill`, `filter`, `box-shadow`,
 * `background-position`, a width — would not, and this test is the thing that
 * fails when someone adds one.
 *
 * The members are the loops themselves, not the elements: the die's trace
 * pulses and its specular sheen, the ledger ticker's travel, and the fork's
 * pulse/beat/flash set. (The fourth member of the class, the muted ambient
 * video, animates no CSS property at all — a video element has nothing here to
 * check.)
 */

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(SITE_ROOT, "app", "globals.css"), "utf-8");

/** The only properties an infinitely looping animation on this page may touch. */
const ALLOWED = new Set(["transform", "opacity", "stroke-dashoffset"]);

/** Every keyframe set driven by an `infinite` animation, by ambient member. */
const AMBIENT_LOOPS: Record<string, string[]> = {
	"die trace pulses": ["die-pulse"],
	"die specular sheen": ["die-sheen"],
	"ledger ticker travel": ["ledger-scroll"],
	"fork travelling pulse": ["fork-trunk-pulse", "fork-branch-pulse"],
	"fork decision beat": ["fork-beat", "fork-beat-halo"],
	"fork outcome flash": ["fork-flash", "fork-flash-halo"],
};

/**
 * Keyframes declared with `infinite` but applied to NOTHING — legacy rules from
 * before the dossier rebuild, kept out of the ambient class because no element
 * on the page carries their class. Listed here so that applying one to an
 * element fails this file rather than quietly adding a loop to the page.
 */
const UNAPPLIED_LEGACY = ["shimmer", "glow-ring"];

/** The body of `@keyframes <name> { ... }`, found by matching braces. */
function keyframeBlock(name: string): string | null {
	const at = CSS.search(new RegExp(String.raw`@keyframes\s+${name}\s*\{`));
	if (at === -1) return null;
	let depth = 0;
	for (let i = CSS.indexOf("{", at); i < CSS.length; i++) {
		if (CSS[i] === "{") depth++;
		else if (CSS[i] === "}" && --depth === 0) return CSS.slice(CSS.indexOf("{", at) + 1, i);
	}
	return null;
}

/** The property names declared anywhere inside a keyframe body. */
function animatedProperties(name: string): string[] {
	const body = keyframeBlock(name);
	assert.ok(body !== null, `@keyframes ${name} is gone from globals.css — renamed, or retired?`);
	const props = new Set<string>();
	for (const m of body.matchAll(/(^|[{;\s])([a-z-]+)\s*:\s*[^;{}]+;/g)) props.add(m[2]);
	return [...props].sort();
}

for (const [member, names] of Object.entries(AMBIENT_LOOPS)) {
	test(`${member}: animates only compositor-cheap properties`, () => {
		for (const name of names) {
			const props = animatedProperties(name);
			assert.ok(props.length > 0, `@keyframes ${name} animates nothing at all`);
			for (const prop of props) {
				assert.ok(
					ALLOWED.has(prop),
					`@keyframes ${name} animates \`${prop}\`, which is not in the ambient-class ` +
						`allowlist (${[...ALLOWED].join(", ")}). An infinite loop may not repaint or ` +
						`re-layout: amend the doctrine deliberately, or animate something cheaper.`,
				);
			}
		}
	});
}

test("opacity is IN the allowlist, and the fork is the loop that uses it", () => {
	assert.ok(ALLOWED.has("opacity"));
	assert.ok(animatedProperties("fork-flash").includes("opacity"));
	assert.deepEqual(animatedProperties("fork-flash-halo"), ["opacity", "transform"]);
});

test("the paint-cost properties an ambient loop must never touch stay out", () => {
	for (const banned of ["fill", "filter", "box-shadow", "background-position", "width", "top"]) {
		assert.ok(!ALLOWED.has(banned), `${banned} must never be animated in an infinite loop`);
	}
});

test("every `infinite` animation in the stylesheet is an accounted-for loop", () => {
	const declared = new Set([...Object.values(AMBIENT_LOOPS).flat(), ...UNAPPLIED_LEGACY]);
	// `animation: <name> <duration> ... infinite` — the shorthand form.
	for (const m of CSS.matchAll(/animation:\s*([a-z-]+)[^;]*\binfinite\b/g)) {
		assert.ok(
			declared.has(m[1]),
			`\`${m[1]}\` loops but is not declared in this file. A new loop is a new ambient-class ` +
				`member: add it above and it inherits the property allowlist, or stop it looping.`,
		);
	}
	// The longhand form spreads `animation-name` and `animation-iteration-count`
	// across sibling rules, so the name cannot be read off the loop declaration —
	// count them instead, and pin the count to the loops declared above.
	const longhand = CSS.match(/animation-iteration-count:\s*infinite/g) ?? [];
	assert.equal(
		longhand.length,
		5,
		"a longhand `animation-iteration-count: infinite` was added or removed — the ambient loops " +
			"declaring one are the die's two pulse strokes and the fork's pulse, beat and flash sets; " +
			"declare the change here",
	);
});
