import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `receipt-spec.md` §6a adopts the resolver companion's "Mint lifecycle"
 * section as normative **pinned by the complete digest of
 * `receipt-resolver-api.md`**, and tells the reader to "verify with
 * `shasum -a 256`".
 *
 * Nothing did. The pin was prose only — no test, and no CI job reads `docs/`
 * at all — so an edit anywhere in the companion silently detached the adopted
 * text from the digest that claims to bind it, and the spec went on asserting
 * a pin that no longer matched. That is a fail-quiet on the one mechanism
 * these two documents use to stay tied together.
 *
 * This is the missing verifier. It does exactly what §6a says to do.
 */
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const SPEC = join(REPO_ROOT, "docs/specs/receipt-spec.md");
const COMPANION = join(REPO_ROOT, "docs/specs/receipt-resolver-api.md");

/** §6a states the live pin as the FIRST bolded standalone sha256 line. The
 *  digests after it are the supersession chain and must not be matched. */
function recordedPin(spec: string): string {
	const m = spec.match(/^\*\*`sha256:([0-9a-f]{64})`\*\*$/m);
	// A regex that silently matches nothing would make this test pass on a
	// spec with no pin at all — the exact failure it exists to prevent. Throw
	// rather than assert-and-assume: the caller needs a string, and a
	// non-null assertion here would hide the very case being guarded.
	const pin = m?.[1];
	if (pin === undefined) {
		throw new Error("could not find the §6a pin line in receipt-spec.md");
	}
	return pin;
}

describe("§6a content pin", () => {
	it("the recorded digest is the actual digest of the companion", () => {
		const spec = readFileSync(SPEC, "utf-8");
		const companionBytes = readFileSync(COMPANION);
		const actual = createHash("sha256").update(companionBytes).digest("hex");

		expect(recordedPin(spec)).toBe(actual);
	});

	it("the adopted section is present and non-trivial", () => {
		// If the section were renamed or removed, the digest above would still
		// match and the pin would bind nothing. Pin the referent too.
		const companion = readFileSync(COMPANION, "utf-8");
		const start = companion.indexOf("## Mint lifecycle");
		const end = companion.indexOf("\n## ", start + 1);

		expect(start, "the adopted 'Mint lifecycle' section is missing").toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(companion.slice(start, end).split("\n").length).toBeGreaterThan(100);
	});
});
