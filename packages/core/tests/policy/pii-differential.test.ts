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
 *   - digits glued to a word (`toolu_123…`, `…5309z`): explained when the 5.0.4 detector stops
 *     flagging the input once every digit group a letter or underscore touches is removed, a
 *     group followed by an extension (`x123`, `ext12`) excepted. The test decides that on its own;
 *     the current detector is never asked, so a loss it causes cannot excuse itself;
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
import { detectPII, redactPII } from "../../src/policy/pii.js";
import {
	detectPII as detectPII504,
	redactPII as redactPII504,
} from "../fixtures/pii-detector-5.0.4.js";

type Kind =
	| "phone"
	| "credit_card"
	| "ipv4"
	| "generic_secret"
	| "api_key"
	| "aws_key"
	| "github_token";
type Check = (s: string) => boolean;

const NBSP = String.fromCodePoint(0xa0);
const NARROW_NBSP = String.fromCodePoint(0x202f);

/** `s` in fullwidth forms: each printable ASCII character but the space moved to its U+FF01-FF5E form. */
function fullwidth(s: string): string {
	return [...s]
		.map((c) => {
			const cp = c.codePointAt(0) as number;
			return cp > 0x20 && cp < 0x7f ? String.fromCodePoint(cp + 0xfee0) : c;
		})
		.join("");
}

/** `s` with the format character `cf` (a zero-width space unless named) after every 4th character. */
function interleaved(s: string, cf = String.fromCodePoint(0x200b)): string {
	return [...s].map((c, i) => (i % 4 === 3 ? c + cf : c)).join("");
}

/** `s` half in fullwidth forms, half with zero-width joiners: both at once. */
function mixed(s: string): string {
	const half = Math.floor(s.length / 2);
	return fullwidth(s.slice(0, half)) + interleaved(s.slice(half), String.fromCodePoint(0x200d));
}

/** Every code point up to 0xFFFF that `\s` matches: the space, the ASCII controls, and the rest. */
const WHITESPACE: string[] = [];
for (let cp = 0; cp <= 0xffff; cp++) {
	const ch = String.fromCodePoint(cp);
	if (/\s/.test(ch)) WHITESPACE.push(ch);
}
const HEX64 = "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea";

/** `n` letters and digits, the same on every run for the same seed: synthetic token payloads. */
function alnum(
	n: number,
	seed: number,
	alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
): string {
	let x = seed >>> 0;
	let out = "";
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		out += alphabet[(x >>> 16) % alphabet.length];
	}
	return out;
}

/**
 * Token formats each provider documents that 5.0.4 did not detect, built at run time from their
 * parts (no token-shaped literal in this file). Each is a GAINED positive: the current detector
 * flags it, 5.0.4 did not.
 */
const GAINED: ReadonlyArray<[Kind, string]> = [
	["github_token", `github${"_pat_"}${alnum(22, 1)}_${alnum(59, 2)}`],
	["github_token", `gh${"u_"}${alnum(36, 3)}`],
	["github_token", `gh${"s_"}1234567_ey${"J"}${alnum(30, 4)}.${alnum(40, 5)}.${alnum(43, 6)}`],
	["aws_key", `AS${"IA"}${alnum(16, 7, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`],
	["api_key", `rk${"_live_"}${alnum(99, 8)}`],
	["api_key", `rk${"_test_"}${alnum(99, 9)}`],
	["api_key", `sk${"_org_"}${alnum(99, 10)}`],
	[
		"generic_secret",
		`xa${"pp-"}1-A${alnum(10, 11, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")}-${alnum(13, 12, "0123456789")}-${alnum(40, 13)}`,
	],
	["generic_secret", `xw${"fp-"}${alnum(40, 14)}`],
	["generic_secret", `xo${"xe-"}1-${alnum(140, 32)}`],
	["api_key", `AI${"za"}Sy${alnum(33, 33)}`],
	["api_key", `xa${"i-"}${alnum(80, 34)}`],
	["api_key", `gs${"k_"}${alnum(52, 35)}`],
	["api_key", `pp${"lx-"}${alnum(48, 36)}`],
	["generic_secret", `wh${"sec_"}${alnum(32, 37)}`],
	["generic_secret", `gl${"dt-"}${alnum(20, 15)}`],
	["generic_secret", `gl${"rt-"}${alnum(20, 16)}`],
	["generic_secret", `gl${"agent-"}${alnum(20, 17)}`],
	["generic_secret", `S${"G."}${alnum(19, 18)}---.${alnum(43, 19)}`],
];

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
		// Extensions: part of the number, not glue.
		"555-867-5309x123",
		"555-867-5309ext12",
		"555-867-5309 ext. 12",
		"555-867-5309#123",
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
	api_key: [
		`sk${"-ant-api03-"}${alnum(93, 20)}AA`,
		`sk${"-proj-"}${alnum(156, 21)}`,
		`sk${"_live_"}${alnum(99, 22)}`,
		`sk${"_test_"}${alnum(24, 23)}`,
		`OPENAI_API_KEY=sk${"-"}${alnum(48, 24)}`,
	],
	aws_key: [
		`AK${"IA"}${alnum(16, 25, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
		`aws_access_key_id = AK${"IA"}${alnum(16, 26, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
	],
	github_token: [
		`gh${"p_"}${alnum(36, 27)}`,
		`gh${"o_"}${alnum(36, 28)}`,
		`gh${"s_"}${alnum(36, 29)}`,
		`gh${"r_"}${alnum(76, 30)}`,
		`token=gh${"p_"}${alnum(36, 31)}`,
	],
	generic_secret: [
		HEX64,
		`sha256:${HEX64}`,
		`https://files.example/${HEX64}/raw`,
		`${"a".repeat(64)} ${HEX64}`,
		`xo${"xb-"}123456789012-abcdefghijkl`,
		`gl${"pat-"}abcdefghijklmnopqrstuvwx`,
		`npm_${"a1".repeat(18)}`,
		`SG.${"x".repeat(22)}`,
	],
};

/**
 * Values hidden from a plain pattern by fullwidth forms or format characters: the same values the
 * detector reads in its normalized view. 5.0.4 reads none of them.
 */
const NORMALIZED: Record<Kind, string[]> = {
	phone: [fullwidth("234-567-8901"), interleaved("2345678901"), mixed("+1 (234) 567-8901")],
	credit_card: [
		fullwidth("4111 1111 1111 1111"),
		interleaved("4111111111111111"),
		mixed("5500-0000-0000-0004"),
	],
	ipv4: [fullwidth("192.168.1.1"), interleaved("10.0.0.1"), mixed("host 172.16.254.1 up")],
	api_key: [
		interleaved(`sk${"-proj-"}${alnum(156, 40)}`),
		fullwidth(`sk${"-ant-api03-"}${alnum(93, 41)}AA`),
		mixed(`sk${"_live_"}${alnum(99, 42)}`),
		interleaved(`sk${"-"}${alnum(48, 43)}`, String.fromCodePoint(0xad)),
	],
	aws_key: [
		interleaved(`AK${"IA"}${alnum(16, 44, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`),
		fullwidth(`AK${"IA"}${alnum(16, 45, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`),
	],
	github_token: [
		interleaved(`gh${"p_"}${alnum(36, 46)}`, String.fromCodePoint(0xfeff)),
		fullwidth(`gh${"o_"}${alnum(36, 47)}`),
		mixed(`gh${"s_"}${alnum(36, 48)}`),
	],
	generic_secret: [
		interleaved(HEX64, String.fromCodePoint(0x2060)),
		fullwidth(`gl${"pat-"}${alnum(20, 49)}`),
		mixed(`np${"m_"}${alnum(36, 50)}`),
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

const inputsFor = (kind: Kind): string[] => [
	...CURATED[kind],
	...GAINED.filter(([k]) => k === kind).map(([, token]) => token),
	...NORMALIZED[kind],
	...FUZZ,
];
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

/**
 * The input without the digit groups that belong to a word: each group a letter or underscore
 * touches, unless what follows it is an extension (x, ext or ext., spaces, then 1-6 digits that end
 * the token), which belongs to the number before it. Written here from the rule.
 */
function dropGlued(s: string): string {
	return s.replace(/\d+/g, (group: string, at: number) => {
		const touchedBefore = at > 0 && /[A-Za-z_]/.test(s.charAt(at - 1));
		const rest = s.slice(at + group.length);
		const extension = /^(?:x|ext\.?)\s*\d{1,6}(?![A-Za-z0-9_])/i.test(rest);
		const touchedAfter = /^[A-Za-z_]/.test(rest) && !extension;
		return touchedBefore || touchedAfter ? "|" : group;
	});
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

/**
 * Which token rule explains a phone value the current detector lost, the first that does, or none.
 * Each asks only the 5.0.4 detector: does it stop flagging the input once those tokens are gone?
 */
function phoneLossRule(s: string): "glued" | "oversized" | "both" | "none" {
	const old = before("phone");
	if (!old(dropGlued(s))) return "glued";
	if (!old(dropOversized(s))) return "oversized";
	if (!old(dropGlued(dropOversized(s)))) return "both";
	return "none";
}

/** The phone values the 5.0.4 detector flagged that `current` does not, and no token rule explains. */
function unexplainedPhoneLosses(current: Check, inputs: readonly string[]): string[] {
	return lost(before("phone"), current, inputs).filter((s) => phoneLossRule(s) === "none");
}

describe("PII detector differential: 5.0.4 beside the current detector", () => {
	it("secrets: on text that only starts like a token, nothing is flagged that 5.0.4 did not flag", () => {
		// Each token prefix, then lowercase kebab-case or snake_case words, a run of dashes, or prose.
		const prefixes = [
			"sk-",
			"sk_live_",
			"rk_live_",
			"sk_org_",
			"AKIA",
			"ASIA",
			"ghp_",
			"ghu_",
			"ghs_1_",
			"github_pat_",
			"xoxb-",
			"xoxe-1-",
			"xapp-",
			"xwfp-",
			"SG.",
			"glpat-",
			"gldt-",
			"glrt-",
			"glagent-",
			"glft-",
			"npm_",
			"AIza",
			"xai-",
			"gsk_",
			"pplx-",
			"whsec_",
		];
		const words = [
			"config",
			"service",
			"production",
			"runner",
			"registration",
			"walkthrough",
			"feature",
			"toggle",
			"client",
			"library",
			"deploy",
			"token",
			"rotation",
			"policy",
			"doc",
			"guide",
			"v2",
		];
		const rand = seeded(20261019);
		const pick = () => words[Math.floor(rand() * words.length)] as string;
		const phrase = (joiner: string) => {
			let out = pick();
			while (out.length < 24 + Math.floor(rand() * 30)) out += joiner + pick();
			return out;
		};
		// A long first word, then more words: the first word alone fills a minimum run.
		const longWords = [
			"internationalization",
			"configurationmanagement",
			"responsibledisclosurepolicy",
			"webhooksigningsecretforstagingenv",
		];
		// The prefixes whose payload must hold four distinct characters: those 5.0.5 and 5.0.6 add.
		const placeholderPrefixes = [
			"rk_live_",
			"sk_org_",
			"ASIA",
			"ghu_",
			"xapp-",
			"xwfp-",
			"xoxe-1-",
			"gldt-",
			"glrt-",
			"glagent-",
			"glft-",
			"AIza",
			"xai-",
			"gsk_",
			"pplx-",
			"whsec_",
		];
		const texts: string[] = [];
		for (const prefix of prefixes) {
			for (let i = 0; i < 40; i++) {
				texts.push(prefix + phrase("-"), prefix + phrase("_"), `${prefix}${"-".repeat(20 + i)}`);
			}
			for (const word of longWords) {
				texts.push(`${prefix}${word}-${phrase("-")}`, `${prefix}${word}_${phrase("_")}`);
			}
			if (placeholderPrefixes.includes(prefix)) {
				// Placeholders: one character, repeated.
				for (const c of ["x", "X", "a", "0", "/"]) {
					for (const n of [16, 20, 32, 33, 35, 40, 52, 80]) texts.push(prefix + c.repeat(n));
				}
			}
			texts.push(
				`${prefix} is the start of a sentence about tokens.`,
				`use ${prefix}something here`,
			);
		}
		// The two GitHub formats with a structure of their own, as placeholders.
		for (const c of ["x", "X", "a", "0"]) {
			texts.push(
				`ghs_1234567_eyJ${c.repeat(30)}.${c.repeat(60)}.${c.repeat(43)}`,
				`github_pat_${c.repeat(22)}_${c.repeat(59)}`,
			);
		}
		const kinds = ["api_key", "aws_key", "github_token", "generic_secret"] as const;
		const gained = kinds.flatMap((kind) =>
			texts.filter((t) => now(kind)(t) && !before(kind)(t)).map((t) => `${kind}: ${t}`),
		);
		// With no capital rule, a name of exactly 35 letters, digits, `_` and `-` after AIza, its words
		// joined by `-` or `_`, has a Google key's shape and is reported: the one shape here that a real
		// key and a name share.
		const googleLength = (t: string) => /^api_key: AIza(?=[^-_]*[-_])[A-Za-z0-9_-]{35}$/.test(t);
		expect(gained.filter((t) => !googleLength(t))).toEqual([]);
	});

	it("redaction: two non-enumerable and two enumerable properties, a getter among them, copied as 5.0.4 copied them", () => {
		// The walk lists an object's own names once its enumerable keys are done, and copies its
		// non-enumerable data properties from that list: with a cursor of their own, not the
		// enumerable keys' cursor reset to 0, which walked the enumerable keys again and skipped names.
		const make = () => {
			const reads = { shown: 0 };
			const input: Record<string, unknown> = {};
			Object.defineProperty(input, "hidden0", { value: "plain text", enumerable: false });
			Object.defineProperty(input, "hidden1", { value: "mail bob@example.com", enumerable: false });
			Object.defineProperty(input, "email", { value: "mail alice@example.com", enumerable: true });
			Object.defineProperty(input, "shown", {
				get: () => {
					reads.shown++;
					return "visible";
				},
				enumerable: true,
			});
			return { input, reads };
		};
		const describeCopy = (copy: Record<string, unknown>) =>
			Object.getOwnPropertyNames(copy).map((name) => {
				const d = Object.getOwnPropertyDescriptor(copy, name) as PropertyDescriptor;
				return [name, d.enumerable, d.value];
			});
		const now504 = make();
		const old = describeCopy(redactPII504(now504.input).data as Record<string, unknown>);
		const current = make();
		const out = describeCopy(redactPII(current.input).data as Record<string, unknown>);
		expect(out).toEqual(old);
		// The copy defines the enumerable keys first, then the non-enumerable ones, as 5.0.4 did.
		expect(out).toEqual([
			["email", true, "[REDACTED:email]"],
			["shown", true, "visible"],
			["hidden0", false, "plain text"],
			["hidden1", false, "[REDACTED:email]"],
		]);
		expect(current.reads.shown).toBe(now504.reads.shown);
		expect(current.reads.shown).toBe(2);
	});

	it("normalized view: a value in fullwidth forms or split by format characters is a gained positive", () => {
		const notGained: string[] = [];
		for (const [kind, values] of Object.entries(NORMALIZED) as Array<[Kind, string[]]>) {
			for (const s of values) {
				if (before(kind)(s) || !now(kind)(s))
					notGained.push(`${kind}: ${JSON.stringify(s.slice(0, 24))}`);
			}
		}
		expect(notGained).toEqual([]);
	});

	it("normalized view: every gain on text the view changes is what 5.0.4 reads in that view", () => {
		// The view, written here from its rule, not imported: format characters removed; a character
		// replaced by its NFKC form if that is ASCII and the character is a fullwidth form (U+FF01 to
		// U+FF5E) or the form holds no letter or digit; any other character kept.
		const view = (s: string) =>
			[...s]
				.map((c) => {
					if (/^\p{Cf}$/u.test(c)) return "";
					const form = c.normalize("NFKC");
					const code = c.codePointAt(0) as number;
					const fullwidthForm = code >= 0xff01 && code <= 0xff5e;
					return form !== c &&
						/^[ -~\t\n\r\f\v]+$/.test(form) &&
						(fullwidthForm || !/[A-Za-z0-9]/.test(form))
						? form
						: c;
				})
				.join("");
		const kinds: Kind[] = [
			"phone",
			"credit_card",
			"ipv4",
			"generic_secret",
			"api_key",
			"aws_key",
			"github_token",
		];
		let explained = 0;
		const unexplained: string[] = [];
		for (const kind of kinds) {
			for (const s of inputsFor(kind)) {
				if (!now(kind)(s) || before(kind)(s) || view(s) === s) continue;
				if (before(kind)(view(s))) explained++;
				else unexplained.push(`${kind}: ${JSON.stringify(s.slice(0, 30))}`);
			}
		}
		expect(unexplained).toEqual([]);
		// Positive control: the rows above hold such gains, so the rule is exercised.
		expect(explained).toBeGreaterThanOrEqual(20);
	});

	it("secrets: every format each provider documents that 5.0.4 missed is a gained positive", () => {
		const notGained = GAINED.filter(([kind, token]) => !(!before(kind)(token) && now(kind)(token)));
		expect(notGained.map(([kind, token]) => `${kind}: ${token.slice(0, 14)}`)).toEqual([]);
	});

	for (const kind of [
		"credit_card",
		"ipv4",
		"generic_secret",
		"api_key",
		"aws_key",
		"github_token",
	] as const) {
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
		// Spaced, international and non-breaking-spaced numbers, and numbers with an extension:
		// flagged before, and still flagged.
		for (const s of [
			"555-867-5309x123",
			"555-867-5309ext12",
			"555-867-5309 ext. 12",
			"(555) 867-5309 x123",
			"555-867-5309#123",
			"call 555.867.5309X42 today",
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

	it("card: on lists of numbers, the current check flags exactly what 5.0.4 flagged", () => {
		// Spans of groups count only in a card's layout, so lists whose groups never fall in one add
		// nothing: space-separated pairs, a printed bit vector, four-digit numbers one per line.
		const rand = seeded(20261018);
		const digits = (n: number) => {
			let out = "";
			for (let i = 0; i < n; i++) out += String(Math.floor(rand() * 10));
			return out;
		};
		const fourDigitList = (count: number) => () =>
			Array.from({ length: count }, () => digits(4)).join(" ");
		const lists: Array<[string, () => string]> = [
			["5 four-digit numbers, space-separated", fourDigitList(5)],
			["6 four-digit numbers, space-separated", fourDigitList(6)],
			["8 four-digit numbers, space-separated", fourDigitList(8)],
			["12 four-digit numbers, space-separated", fourDigitList(12)],
			[
				"10 three-digit numbers, space-separated",
				() => Array.from({ length: 10 }, () => digits(3)).join(" "),
			],
			[
				"5 four-digit numbers, dash-separated",
				() => Array.from({ length: 5 }, () => digits(4)).join("-"),
			],
			[
				"8 four-digit numbers, dash-separated",
				() => Array.from({ length: 8 }, () => digits(4)).join("-"),
			],
			[
				"8 four-digit numbers, tab-separated",
				() => Array.from({ length: 8 }, () => digits(4)).join("\t"),
			],
			[
				"10 three-digit numbers, dash-separated",
				() => Array.from({ length: 10 }, () => digits(3)).join("-"),
			],
			[
				"10 three-digit numbers, tab-separated",
				() => Array.from({ length: 10 }, () => digits(3)).join("\t"),
			],
			[
				"10 two-digit numbers, space-separated",
				() => Array.from({ length: 10 }, () => digits(2)).join(" "),
			],
			[
				"20 two-digit numbers, space-separated",
				() => Array.from({ length: 20 }, () => digits(2)).join(" "),
			],
			[
				"16 binary digits, space-separated",
				() => `[${Array.from({ length: 16 }, () => String(Math.floor(rand() * 2))).join(" ")}]`,
			],
			[
				"8 four-digit numbers, one per line",
				() => Array.from({ length: 8 }, () => digits(4)).join("\n"),
			],
			[
				"30 numbers of 1-3 digits, one per line",
				() => Array.from({ length: 30 }, () => digits(1 + Math.floor(rand() * 3))).join("\n"),
			],
		];
		for (const [name, make] of lists) {
			const texts = Array.from({ length: 4000 }, make);
			const differ = texts.filter((t) => before("credit_card")(t) !== now("credit_card")(t));
			expect(differ.slice(0, 3), name).toEqual([]);
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
		const rows = (
			[
				"phone",
				"credit_card",
				"ipv4",
				"generic_secret",
				"api_key",
				"aws_key",
				"github_token",
			] as const
		).map((kind) => {
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
			const rule = phoneLossRule(s);
			byRule[rule] = (byRule[rule] ?? 0) + 1;
		}
		// Written only when asked for (the PR body carries it); the assertions above are the gate.
		const out = process.env.PII_DIFFERENTIAL_TABLE;
		if (out) writeFileSync(out, `${JSON.stringify({ rows, phoneLostByRule: byRule }, null, 2)}\n`);
		// Both detectors over every kind's 20,000+ inputs: about 3 s on a laptop, and 4.4 to 5.1 s
		// on CI, past vitest's default 5 s.
	}, 30_000);
});
