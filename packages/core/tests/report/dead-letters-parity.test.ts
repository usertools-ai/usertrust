import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { deadLetterPath, readChainDeadLetters } from "../../src/audit/dead-letters.js";
import { parseDeadLetters } from "../../src/report/dead-letters.js";

/**
 * ONE parser for `dlq/dead-letters.jsonl`. `verify` and `health` read it through `readChainDeadLetters`; the report reads
 * it through `parseDeadLetters`. Both go through `parseDeadLetterLine`, so what counts as a readable dead letter must be
 * identical: a line the shared parser rejects is "<unreadable>" to the verifier and makes the report's queue unreadable,
 * and a line it accepts is neither.
 */
describe("the report and the verifier read dead letters identically", () => {
	let vault: string;
	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "dl-parity-"));
		mkdirSync(join(vault, "dlq"), { recursive: true });
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	const seal = (entry: Record<string, unknown>, fallback = false): string => {
		const source = fallback ? JSON.stringify(entry) : canonicalize(entry);
		const checksum = createHash("sha256").update(source).digest("hex");
		return JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });
	};
	const base = (payload: unknown) => ({
		source: "audit.chain.appendEvent",
		payload,
		error: "disk full",
		timestamp: "2026-10-08T01:00:00.000Z",
	});
	const shortfall = (tid: string) =>
		base({
			kind: "settlement_shortfall",
			actor: "local",
			data: { transferId: tid, actual: 100, posted: 60, shortfall: 40 },
		});

	const cases: Array<[string, string, boolean]> = [
		["a good entry", seal(shortfall("t1")), true],
		[
			"the NaN-fallback seal",
			seal(base({ kind: "llm_call", data: { transferId: "x", cost: Number.NaN } }), true),
			true,
		],
		[
			"a bad checksum",
			JSON.stringify({ ...JSON.parse(seal(shortfall("t2"))), checksum: "0".repeat(64) }),
			false,
		],
		["an unparseable line", "{nope", false],
		["a line that is not an object", "[1,2]", false],
		["a record with no checksum", JSON.stringify(shortfall("t3")), false],
	];

	for (const [name, line, readable] of cases) {
		it(`${name}: ${readable ? "readable" : "unreadable"} in both`, () => {
			writeFileSync(deadLetterPath(vault), `${line}\n`);
			const report = parseDeadLetters(`${line}\n`);
			const verifier = readChainDeadLetters(vault, () => undefined);
			if ("unreadable" in verifier) throw new Error("file unreadable");
			if (readable) {
				expect("shortfalls" in report, "report").toBe(true);
				expect(verifier.missingByKind["<unreadable>"] ?? 0, "verifier").toBe(0);
			} else {
				expect("unreadable" in report, "report").toBe(true);
				expect(verifier.missingByKind["<unreadable>"], "verifier").toBe(1);
			}
		});
	}

	it("a good shortfall letter yields its posted amount in the report", () => {
		const parsed = parseDeadLetters(`${seal(shortfall("t1"))}\n`);
		expect("shortfalls" in parsed && parsed.shortfalls.get("t1")).toBe(60);
	});
});
