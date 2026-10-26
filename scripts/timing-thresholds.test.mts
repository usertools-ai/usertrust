import assert from "node:assert/strict";
import { test } from "node:test";
import { count, type Hit, scan, TEST_FILE } from "./timing-thresholds.mts";
import { compare, failed } from "./typecheck-tests.mts";

const F = "packages/a/tests/x.test.ts";
const shapes = (source: string): string[] =>
	scan(F, source).map((h: Hit) => `${h.line}:${h.shape}${h.accepted ? "+" : ""}`);

test("TEST_FILE: tests/ directories and *.test.* files, nothing else", () => {
	assert.equal(TEST_FILE.test("packages/core/tests/harden/x.test.ts"), true);
	assert.equal(TEST_FILE.test("packages/core/tests/helpers/fixture.ts"), true);
	assert.equal(TEST_FILE.test("scripts/typecheck-tests.test.mts"), true);
	assert.equal(TEST_FILE.test("packages/core/src/ledger/engine.ts"), false);
	assert.equal(TEST_FILE.test("packages/core/tests/fixtures/data.json"), false);
});

test("sleep: a timer with a delay other than 0, and timers/promises' delay", () => {
	assert.deepEqual(shapes("await new Promise((r) => setTimeout(r, 20));"), ["1:sleep"]);
	assert.deepEqual(shapes("setInterval(tick, intervalMs);"), ["1:sleep"]);
	assert.deepEqual(shapes("await setTimeout(50);"), ["1:sleep"]);
	assert.deepEqual(shapes("await setTimeout(delayMs);"), ["1:sleep"]);
	assert.deepEqual(shapes("globalThis.setTimeout(done, 5);"), ["1:sleep"]);
});

test("sleep: a callback with no delay, or a delay of 0, is not a wait", () => {
	assert.deepEqual(shapes("setTimeout(done);"), []);
	assert.deepEqual(shapes("setTimeout(() => done(), 0);"), []);
	assert.deepEqual(shapes("await setTimeout(0);"), []);
	assert.deepEqual(shapes("setTimeout(resolve);"), []);
});

test("clock: performance.now and hrtime always; Date.now only compared or less a start", () => {
	assert.deepEqual(shapes("const t = performance.now();"), ["1:clock"]);
	assert.deepEqual(shapes("const t = process.hrtime.bigint();"), ["1:clock"]);
	assert.deepEqual(shapes("while (Date.now() < deadline) {}"), ["1:clock"]);
	assert.deepEqual(shapes("const took = Date.now() - started;"), ["1:clock"]);
	assert.deepEqual(shapes("const took = Date.now() - t0;"), ["1:clock"]);
	assert.deepEqual(shapes("const at = new Date(Date.now() - agoMs);"), []);
	assert.deepEqual(shapes("const at = Date.now() + 60_000;"), []);
	assert.deepEqual(shapes("const id = Date.now();"), []);
});

test("timeout: a numeric timeout option, or a number as a test's or hook's last argument", () => {
	assert.deepEqual(shapes('it("x", async () => {}, 30_000);'), ["1:timeout"]);
	assert.deepEqual(shapes('it.skip("x", () => {}, 5 * 1000);'), ["1:timeout"]);
	assert.deepEqual(shapes("beforeAll(async () => {}, 60_000);"), ["1:timeout"]);
	assert.deepEqual(shapes('describe("x", { timeout: 30_000 }, () => {});'), ["1:timeout"]);
	assert.deepEqual(shapes("await vi.waitFor(check, { timeout: 500 });"), ["1:timeout"]);
	assert.deepEqual(shapes("export default { test: { testTimeout: 10_000 } };"), ["1:timeout"]);
});

test("timeout: a number that is not a time budget is not a hit", () => {
	assert.deepEqual(shapes('it("x", () => { expect(n).toBe(5000); });'), []);
	assert.deepEqual(shapes('it.each([1, 2])("x %i", (n) => {});'), []);
	assert.deepEqual(shapes("const opts = { timeout: config.timeout };"), []);
	assert.deepEqual(shapes("const opts = { retries: 3 };"), []);
});

test("text in a string or a comment is not code", () => {
	assert.deepEqual(shapes('const s = "setTimeout(r, 20) performance.now()";'), []);
	assert.deepEqual(shapes("// setTimeout(r, 20)\n/* it('x', f, 9000) */"), []);
});

test("a .ts file is parsed as TypeScript: a generic arrow does not hide what follows it", () => {
	const source = "const pick = <T>(st: T) => st;\nawait vi.waitFor(check, { timeout: 500 });";
	assert.deepEqual(shapes(source), ["2:timeout"]);
	assert.deepEqual(
		scan("packages/a/tests/x.test.tsx", "const el = <div>{n}</div>;\nsetTimeout(r, 20);").map(
			(h) => `${h.line}:${h.shape}`,
		),
		["2:sleep"],
	);
});

test("a file that does not parse throws, naming it, rather than reporting nothing", () => {
	assert.throws(
		() => scan(F, "it('x', () => {\nsetTimeout(r, 20);"),
		/x\.test\.ts:\d+: does not parse/,
	);
});

test("fake timers accept sleeps and Date.now, never performance.now or a timeout", () => {
	const source = [
		"vi.useFakeTimers();",
		"setTimeout(r, 20);",
		"while (Date.now() < deadline) {}",
		"const t = performance.now();",
		'it("x", () => {}, 9000);',
	].join("\n");
	assert.deepEqual(shapes(source), ["2:sleep+", "3:clock+", "4:clock", "5:timeout"]);
});

test("a `timing:` comment with a number accepts the hit on its line or below its comment block", () => {
	assert.deepEqual(shapes("setTimeout(r, 20); // timing: 20 ms; CI max 3 ms"), ["1:sleep+"]);
	assert.deepEqual(shapes("// timing: 30 s budget; CI max 9 s\nit('x', f, 30_000);"), [
		"2:timeout+",
	]);
	assert.deepEqual(
		shapes(
			"/**\n * timing: bound 32, CI max 17.5 over 5 runs\n * more prose\n */\nconst t = performance.now();",
		),
		["5:clock+"],
	);
});

test("a `timing:` comment without a number, or not directly above, accepts nothing", () => {
	assert.deepEqual(shapes("setTimeout(r, 20); // timing: plenty of room"), ["1:sleep"]);
	assert.deepEqual(shapes("// timing: CI max 3 ms\nconst x = 1;\nsetTimeout(r, 20);"), ["3:sleep"]);
	assert.deepEqual(shapes("// timing: 3 ms\n\nsetTimeout(r, 20);"), ["3:sleep"]);
});

test("count: unaccepted hits per file and shape", () => {
	const hits = scan(
		F,
		"setTimeout(r, 20);\nsetTimeout(r, 30);\nperformance.now(); // timing: 3x CI max",
	);
	assert.deepEqual(count(hits), { [`${F} sleep`]: 2 });
});

test("positive control: a new unannotated sleep fails against the baseline; annotated, it passes", () => {
	const before = "setTimeout(r, 20);";
	const baseline = count(scan(F, before));
	assert.equal(failed(compare(baseline, count(scan(F, before)))), false);
	const added = compare(baseline, count(scan(F, `${before}\nsetTimeout(r, 40);`)));
	assert.equal(failed(added), true);
	assert.deepEqual(added.grown, [{ key: `${F} sleep`, baseline: 1, now: 2 }]);
	const fresh = compare(baseline, count(scan(F, `${before}\nit("x", f, 9000);`)));
	assert.deepEqual(fresh.added, [`${F} timeout`]);
	const annotated = `${before}\nsetTimeout(r, 40); // timing: 40 ms; CI max 4 ms over 20 runs`;
	assert.equal(failed(compare(baseline, count(scan(F, annotated)))), false);
});

test("positive control: a removed threshold fails until the baseline is tightened", () => {
	const baseline = count(scan(F, "setTimeout(r, 20);\nsetTimeout(r, 40);"));
	const c = compare(baseline, count(scan(F, "setTimeout(r, 20);")));
	assert.deepEqual(c.shrunk, [{ key: `${F} sleep`, baseline: 2, now: 1 }]);
	assert.equal(failed(c), true);
});
