// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The detector as released in 5.0.4 (tests/fixtures/pii-detector-5.0.4.ts) and the current one, run
 * side by side over the same inputs. The rows in pii.test.ts show where the current detector finds
 * more; this shows the other half: every value the 5.0.4 detector flagged that the current one
 * does not.
 *
 * - credit_card, ipv4, generic_secret: the current checks only look at more candidates, so no
 *   value the 5.0.4 detector flagged may be lost.
 * - phone: two losses are intended, both tokens, and each is accepted only when its own check
 *   explains it:
 *   - digits glued to a word (`toolu_123…`, `…5309z`): explained when the current detector flags
 *     the same input once every letter or underscore touching a digit is spaced apart from it;
 *   - a group of 16 or more digits (an id, a card): explained when the 5.0.4 detector stops
 *     flagging the input once those groups are removed.
 *   Both rules applied together explain an input that holds both kinds of token. Any other loss
 *   fails, by name.
 *
 * Inputs: a curated set per detector, and 20,000 seeded strings over the characters these checks
 * read, every JavaScript whitespace character included. And every one of those characters, alone,
 * as the spacing of several phone shapes.
 */

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectPII } from "../../src/policy/pii.js";
import { detectPII as detectPII504 } from "../fixtures/pii-detector-5.0.4.js";

type Kind = "phone" | "credit_card" | "ipv4" | "generic_secret";
type Check = (s: string) => boolean;

const NBSP = String.fromCodePoint(0xa0);
const NARROW_NBSP = String.fromCodePoint(0x202f);

/** Every code point up to 0xFFFF that `\s` matches: the space, the ASCII controls, and the rest. */
const WHITESPACE: string[] = [];
for (let cp = 0; cp <= 0xffff; cp++) {
	const ch = String.fromCodePoint(cp);
	if (/\s/.test(ch)) WHITESPACE.push(ch);
}
const HEX64 = "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea";

const CURATED: Record<Kind, string[]> = {
	phone: [
		"234-567-8901",
		"(234) 567-8901",
		"234.567.8901",
		"2345678901",
		"+1-234-567-8901",
		"+1 (234) 567-8901",
		"call 555 867 5309 today",
		"call 555  867   5309 today",
		"5 5 5 8 6 7 5 3 0 9",
		"tel:5558675309",
		"phone: +1 555 867 5309.",
		"+44 20 7946 0958",
		"+44 (0)20 7946 0958",
		"+44-20-7946-0958",
		"+33 1 42 68 53 00",
		"+33 1.42.68.53.00",
		"+49 30 901820",
		"+49 30 9018 2000",
		"+61 2 9374 4000",
		"+61 412 345 678",
		"+91 98765 43210",
		"+81 3-1234-5678",
		"+86 10 1234 5678",
		"+55 11 91234-5678",
		"+7 495 123-45-67",
		"+34 912 34 56 78",
		"ring me on +44 20 7946 0958, thanks",
		'{"phone":"+33 1 42 68 53 00"}',
		"(+61 2 9374 4000)",
		"Phone:\n+44 20 7946 0958\nEmail: none",
		["555", "867", "5309"].join(NBSP),
		["+44", "20", "7946", "0958"].join(NARROW_NBSP),
		["+33", "1", "42", "68", "53", "00"].join(NBSP),
		// Dial strings: an access prefix before a number of up to 15 digits makes a longer group.
		"Call 0114915123456789",
		"0114915123456789",
		"00491512345678901",
		"0011 61 2 9374 4000",
		"001161293744000",
		// The intended losses: the differential must see these, or it sees nothing.
		"0012345678901234567",
		"toolu_1234567890123abc",
		"call_12345678901",
		"ref-5558675309z",
		"SKU12 555 867 5309",
		'order_id: "12345678901234567890"',
		"4111111111111111",
	],
	credit_card: [
		"4111111111111111",
		"4111 1111 1111 1111",
		"4111-1111-1111-1111",
		"5500 0000 0000 0004",
		"3782 822463 10005",
		"6011 1111 1111 1117",
		"4222222222222",
		"card 4111 1111 1111 1111 exp 12/29",
		"4111-1111-1111-1111 12/29",
		'{"card":"5500-0000-0000-0004"}',
		"pay with 6011111111111117.",
		"(4111 1111 1111 1111)",
		"12 4111 1111 1111 1111",
	],
	ipv4: [
		"192.168.1.1",
		"10.0.0.1",
		"0.0.0.0",
		"255.255.255.255",
		"host 10.0.0.1:8080 is up",
		"http://172.16.254.1/admin",
		"ip=8.8.8.8;",
		"1.2.3.256 192.168.1.1",
		"from 203.0.113.7 to 198.51.100.2",
	],
	generic_secret: [
		HEX64,
		`sha256:${HEX64}`,
		`https://files.example/${HEX64}/raw`,
		`${"a".repeat(64)} ${HEX64}`,
		"xoxb-123456789012-abcdefghijkl",
		"glpat-abcdefghijklmnopqrstuvwx",
		`npm_${"a1".repeat(18)}`,
		`SG.${"x".repeat(22)}`,
	],
};

/** A seeded generator, so the fuzz set is the same on every run. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Strings of 8-47 characters over what these checks read, digits weighted heavily. */
function fuzz(seed: number, count: number): string[] {
	const rand = seeded(seed);
	const alphabet = [..."0123456789".repeat(4), ..."-.+()_:abcdefxXz", ...WHITESPACE];
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const length = 8 + Math.floor(rand() * 40);
		let s = "";
		for (let j = 0; j < length; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
		out.push(s);
	}
	return out;
}

const FUZZ = fuzz(20261018, 20_000);

const inputsFor = (kind: Kind): string[] => [...CURATED[kind], ...FUZZ];
const before =
	(kind: Kind): Check =>
	(s) =>
		detectPII504(s).types.includes(kind);
const now =
	(kind: Kind): Check =>
	(s) =>
		detectPII(s).types.includes(kind);

function lost(old: Check, current: Check, inputs: readonly string[]): string[] {
	return inputs.filter((s) => old(s) && !current(s));
}

/** The input with every letter or underscore that touches a digit spaced apart from it. */
function unglue(s: string): string {
	return s.replace(/(?<=[A-Za-z_])(?=\d)|(?<=\d)(?=[A-Za-z_])/g, " ");
}

/**
 * The input without its groups of 16 or more digits, but for a dial string: 00, 011, 010 or 0011,
 * then at most 15 digits. Written here from the rule, not imported, so a detector that drops dial
 * strings is not excused by its own definition of one.
 */
function dropOversized(s: string): string {
	return s.replace(/\d{16,}/g, (group) =>
		/^(?:0011|011|010|00)/.test(group) && group.replace(/^(?:0011|011|010|00)/, "").length <= 15
			? group
			: " ",
	);
}

/** Which token rule explains a phone value lost by `current`, the first that does, or none. */
function phoneLossRule(current: Check, s: string): "glued" | "oversized" | "both" | "none" {
	if (current(unglue(s))) return "glued";
	if (!before("phone")(dropOversized(s))) return "oversized";
	if (current(unglue(dropOversized(s)))) return "both";
	return "none";
}

/** The phone values the 5.0.4 detector flagged that `current` does not, and no token rule explains. */
function unexplainedPhoneLosses(current: Check, inputs: readonly string[]): string[] {
	return lost(before("phone"), current, inputs).filter((s) => phoneLossRule(current, s) === "none");
}

describe("PII detector differential: 5.0.4 beside the current detector", () => {
	for (const kind of ["credit_card", "ipv4", "generic_secret"] as const) {
		it(`${kind}: no value the 5.0.4 detector flagged is lost`, () => {
			const inputs = inputsFor(kind);
			// A set the old detector never flags proves nothing.
			expect(inputs.filter(before(kind)).length).toBeGreaterThan(CURATED[kind].length / 2);
			expect(lost(before(kind), now(kind), inputs)).toEqual([]);
		});
	}

	it("phone: every lost value is explained by a token rule, and nothing else is lost", () => {
		const inputs = inputsFor("phone");
		expect(unexplainedPhoneLosses(now("phone"), inputs)).toEqual([]);
		// The intended losses are among the losses, so the differential can see a loss.
		const losses = lost(before("phone"), now("phone"), inputs);
		for (const token of [
			"toolu_1234567890123abc",
			"call_12345678901",
			"ref-5558675309z",
			'order_id: "12345678901234567890"',
			"4111111111111111",
			"0012345678901234567",
		]) {
			expect(losses).toContain(token);
		}
		// Spaced, international and non-breaking-spaced numbers: flagged before, and still flagged.
		for (const s of [
			"+44 20 7946 0958",
			"+33 1 42 68 53 00",
			"+49 30 901820",
			"+61 2 9374 4000",
			"+91 98765 43210",
			"5 5 5 8 6 7 5 3 0 9",
			["555", "867", "5309"].join(NBSP),
			["+44", "20", "7946", "0958"].join(NARROW_NBSP),
		]) {
			expect(before("phone")(s), `5.0.4: ${JSON.stringify(s)}`).toBe(true);
			expect(now("phone")(s), `current: ${JSON.stringify(s)}`).toBe(true);
		}
	});

	it("phone: spaced with any whitespace character, the two detectors agree", () => {
		// 5.0.4 removed every \s before matching, so a narrower whitespace class in the current check
		// loses the numbers spaced with what it leaves out. Each character, in each shape.
		expect(WHITESPACE.length).toBeGreaterThanOrEqual(25);
		const shapes = (ws: string): string[] => [
			["555", "867", "5309"].join(ws),
			["+44", "20", "7946", "0958"].join(ws),
			["+33", "1", "42", "68", "53", "00"].join(ws),
			`call 234.${ws}567.${ws}8901 today`,
			`(234)${ws}567-8901`,
		];
		const disagree: string[] = [];
		for (const ws of WHITESPACE) {
			for (const s of shapes(ws)) {
				const old = before("phone")(s);
				if (!old || old !== now("phone")(s)) {
					disagree.push(
						`U+${ws.codePointAt(0)?.toString(16).padStart(4, "0")}: ${JSON.stringify(s)}`,
					);
				}
			}
		}
		expect(disagree).toEqual([]);
	});

	it("phone: the differential fails a stricter check that drops formats 5.0.4 found", () => {
		// Positive control: a pattern that needs each group's digits together, and nothing word-like
		// on either side. It drops spaced and international numbers, and the differential names them.
		const strict = /(?<![\w+])(?:\+?\d{1,3}[-.\s()]*)?\(?\d{3}\)?[-.\s]*\d{3}[-.\s]*\d{4}(?!\w)/;
		const unexplained = unexplainedPhoneLosses((s) => strict.test(s), inputsFor("phone"));
		expect(unexplained).toEqual(
			expect.arrayContaining(["+44 20 7946 0958", "+33 1 42 68 53 00", "5 5 5 8 6 7 5 3 0 9"]),
		);
	});

	it("the table: inputs, flagged before and now, lost and gained, per detector", () => {
		const rows = (["phone", "credit_card", "ipv4", "generic_secret"] as const).map((kind) => {
			const inputs = inputsFor(kind);
			const old = before(kind);
			const current = now(kind);
			return {
				kind,
				inputs: inputs.length,
				before: inputs.filter(old).length,
				now: inputs.filter(current).length,
				lost: lost(old, current, inputs).length,
				gained: lost(current, old, inputs).length,
			};
		});
		expect(rows.every((row) => row.inputs > 20_000)).toBe(true);
		const phoneLosses = lost(before("phone"), now("phone"), inputsFor("phone"));
		const byRule: Record<string, number> = {};
		for (const s of phoneLosses) {
			const rule = phoneLossRule(now("phone"), s);
			byRule[rule] = (byRule[rule] ?? 0) + 1;
		}
		// Written only when asked for (the PR body carries it); the assertions above are the gate.
		const out = process.env.PII_DIFFERENTIAL_TABLE;
		if (out) writeFileSync(out, `${JSON.stringify({ rows, phoneLostByRule: byRule }, null, 2)}\n`);
	});
});
