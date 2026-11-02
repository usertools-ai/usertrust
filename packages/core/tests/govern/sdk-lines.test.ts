/**
 * The anthropic peer range is two-sided (`>=0.116.0 <2`) and CI runs the suite on both lines: the
 * 0.116 floor (every job, via the lockfile) and the 1.x line (the `sdk-1x` job). This file keeps the
 * four places that describe those lines from drifting apart: the peer range, the classified list,
 * the CI pin, and the SDK actually installed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSIFIED_SDK_VERSIONS } from "../../src/default-deny.js";

const root = join(import.meta.dirname, "../../../..");
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const corePkg = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as {
	peerDependencies: Record<string, string>;
};
const installed = (
	JSON.parse(readFileSync(join(root, "node_modules/@anthropic-ai/sdk/package.json"), "utf8")) as {
		version: string;
	}
).version;

const major = (v: string): number => Number(v.split(".")[0]);
const jobBody = (name: string): string => {
	const m = new RegExp(
		`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[a-z0-9-]+:\\n|(?![\\s\\S]))`,
		"m",
	).exec(ci);
	return m?.[1] ?? "";
};
const pin = /SDK_1X_VERSION: (\d+\.\d+\.\d+)/.exec(jobBody("sdk-1x"))?.[1];
const lines = CLASSIFIED_SDK_VERSIONS.anthropic as readonly string[];
const range = corePkg.peerDependencies["@anthropic-ai/sdk"];

describe("the anthropic SDK lines CI tests", () => {
	it("the peer range is exactly `>=<floor> <2`, and the floor is the first classified version", () => {
		const floor = lines[0];
		expect(range).toBe(`>=${floor} <2`);
	});

	it("the sdk-1x job pins one 1.x version, and that version is classified", () => {
		expect(pin, "ci.yml's sdk-1x job sets SDK_1X_VERSION").toBeDefined();
		expect(major(pin as string)).toBe(1);
		expect(lines).toContain(pin);
	});

	it("every classified version is inside the range, and the list names no 2.x", () => {
		for (const v of lines) expect(major(v)).toBeLessThan(2);
	});

	it("the sdk-1x job installs the pin and is wired into the stamp", () => {
		const body = jobBody("sdk-1x");
		expect(body).toMatch(/@anthropic-ai\/sdk@\$\{SDK_1X_VERSION\}/);
		expect(ci).toMatch(/needs: \[[^\]]*\bsdk-1x\b[^\]]*\]/);
		expect(ci).toMatch(/REQUIRED: [^\n]*\bsdk-1x\b/);
	});

	it("the SDK this run is on is the line the run claims", () => {
		if (process.env.USERTRUST_SDK_LINE === "1x") expect(installed).toBe(pin);
		else expect(major(installed)).toBe(0);
	});
});
