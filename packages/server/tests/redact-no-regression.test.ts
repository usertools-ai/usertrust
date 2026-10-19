/**
 * No regression from 5.1.0 over this corpus: no message in it where usertrust-server 5.1.0 redacted
 * a credential in an internal error's line and this version prints it. That is all it shows: a
 * message outside the corpus can still differ. The oracle is 5.1.0's own code
 * (tests/helpers/server-5.1.0.ts, copied from the v5.1.0 tag). Each credential in a message is a
 * distinct token, and a token counts as printed when the line holds it whole.
 *
 * Inputs: every repro found while this redaction was rebuilt; 20,000 seeded messages built from
 * the classes those repros came from: markers in three letter cases, split by a character or
 * sequence sanitizing removes; separators real, doubled, made only of removed characters, or with
 * removed characters beside them; quoted, unquoted and unclosed values; a marker inside a token;
 * markers glued to the word before them or to the caller's key; removed characters and line
 * breaks between and after; seven shapes of caller's key. And 10,000 seeded messages of one class
 * the first generator rarely makes: a chain of credentials, each ended by a character or sequence
 * sanitizing removes, and the next one's marker right after it, split or whole. The comparator's
 * own positive control: a "redaction" that only sanitizes is reported as regressing.
 */
import { describe, expect, it } from "vitest";
import { scrubForStderr } from "../src/cli/scrub.js";
import { internalErrorLine } from "../src/server.js";
import { internalErrorLine510 } from "./helpers/server-5.1.0.js";

const C = (...codes: number[]): string => String.fromCharCode(...codes);
const ESC = C(0x1b);
const BEL = C(0x07);
const TAB = C(0x09);
const LF = C(0x0a);

type Line = (message: string, secrets: readonly string[]) => string;

const head: Line = (message, secrets) =>
	internalErrorLine(new Error(message), "t", "POST /v1/authorize", secrets);
const released: Line = (message, secrets) =>
	internalErrorLine510(new Error(message), "t", "POST /v1/authorize", secrets);

interface Case {
	message: string;
	secrets: readonly string[];
	/** The credentials the message holds, each a string no other part of it contains. */
	credentials: readonly string[];
}

/** The credentials `released` redacts in `c` and `line` prints. */
function regressions(line: Line, c: Case): string[] {
	const before = released(c.message, c.secrets);
	const after = line(c.message, c.secrets);
	return c.credentials.filter((token) => !before.includes(token) && after.includes(token));
}

const VALUE = "upstream-secret-XYZ";

/** Every repro so far, each with the credentials it holds. */
const REPROS: Case[] = [
	// A caller's key that would swallow a split marker.
	{ message: `tenant Bea${C(0)}rer ${VALUE}`, secrets: ["tenantBearer"], credentials: [VALUE] },
	{
		message: `tenant x-api${BEL}-key: ${VALUE}`,
		secrets: ["tenantx-api-key"],
		credentials: [VALUE],
	},
	// An OSC sequence whose terminator is inside the key.
	{
		message: `Bea${ESC}]SEC${BEL}RETKEYjunk${BEL}rer ${VALUE}`,
		secrets: ["SECRETKEY"],
		credentials: [VALUE],
	},
	// A separator made of removed characters.
	{
		message: `Authorization: Bearer${TAB}${ESC}[31m${TAB}${VALUE}`,
		secrets: [],
		credentials: [VALUE],
	},
	{ message: `Bearer${ESC}[31m${VALUE} end`, secrets: [], credentials: [VALUE] },
	// A marker right after the caller's key.
	{ message: `tenantBearer ${VALUE}`, secrets: ["tenant"], credentials: [VALUE] },
	{ message: `tenantapi_key=${VALUE}`, secrets: ["tenant"], credentials: [VALUE] },
	// What sanitizing joins to a token's end.
	{
		message: `Authorization: Bearer${TAB}partone${TAB}parttwo`,
		secrets: [],
		credentials: ["partone", "parttwo"],
	},
	{ message: `Authorization: Bearer${TAB}Bearer${TAB}${VALUE}`, secrets: [], credentials: [VALUE] },
	// A marker inside a Bearer token.
	{
		message: `Authorization: Bearer x.api_key= x-api-key: "S3CRET"`,
		secrets: [],
		credentials: ["S3CRET"],
	},
	{ message: `Bearer x.api_key=${LF}x-api-key: "S3CRET"`, secrets: [], credentials: ["S3CRET"] },
	{ message: `Bearer x.api_key= api-key: 'S3CRET'`, secrets: [], credentials: ["S3CRET"] },
	{ message: `Bearer x.api-key: x-api-key='S3CRET'`, secrets: [], credentials: ["S3CRET"] },
	{ message: `Bearer x.api_k${C(0)}ey= x-api-key: "S3CRET"`, secrets: [], credentials: ["S3CRET"] },
	{ message: `Bea${C(0)}rer x.api_key= x-api-key: "S3CRET"`, secrets: [], credentials: ["S3CRET"] },
	// A key that is, or holds, a marker.
	{ message: `B earer ${VALUE}`, secrets: ["B earer"], credentials: [VALUE] },
	{ message: `Bearer ${VALUE}`, secrets: ["Bearer"], credentials: [VALUE] },
	{ message: `x-api-key: ${VALUE}`, secrets: ["x-api-key"], credentials: [VALUE] },
	{ message: `api- key=${VALUE}`, secrets: ["api- key"], credentials: [VALUE] },
	// A caller's key split by a line break, a tab or an escape sequence, alone and after a marker.
	{
		message: `tenant${LF}key0123456789`,
		secrets: ["tenant key0123456789"],
		credentials: ["key0123456789"],
	},
	{
		message: `Bearer tenant${TAB}key0123456789`,
		secrets: ["tenant key0123456789"],
		credentials: ["key0123456789"],
	},
	{
		message: `api_key=tenant${ESC}[0mkey0123456789 x`,
		secrets: ["tenant key0123456789"],
		credentials: ["key0123456789"],
	},
	// A key inside a token or a quoted value.
	{ message: "Bearer\tsk-1 x", secrets: ["sk-1"], credentials: ["sk-1"] },
	{ message: 'api_key="sk-1 more" x', secrets: ["sk-1"], credentials: ["sk-1", "more"] },
	// A credential ended by a character sanitizing removes, then a split marker: the sanitized text
	// glues the marker to it.
	{ message: `api_key: Q${TAB}Bea${C(0)}rer TK1`, secrets: [], credentials: ["Q", "TK1"] },
	{ message: `api_key:Q${TAB}Bea${BEL}rer TK1`, secrets: ["x-api-key"], credentials: ["TK1"] },
	{ message: `api_key=K${TAB}bear${ESC}[mer TK2`, secrets: ["abc"], credentials: ["TK2"] },
	{ message: `api-key=Q${C(13)}be${BEL}arer TK1`, secrets: [], credentials: ["TK1"] },
	{
		message: `r${ESC}bearer Q${C(13)}B${ESC}[mearer${LF}TK1`,
		secrets: [],
		credentials: ["TK1"],
	},
	{
		message: `r${BEL}bearer${TAB}Q${C(13)}a${C(0x7f)}pi_key:"TK1`,
		secrets: ["Bearer"],
		credentials: ["TK1"],
	},
];

/** A seeded generator in [0, 1) (mulberry32). */
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

/** Characters and sequences sanitizing removes. */
const REMOVED = [
	C(0),
	BEL,
	TAB,
	C(0x1f),
	C(0x7f),
	C(0x85),
	`${ESC}[31m`,
	`${ESC}]0;t${BEL}`,
	`${C(0x9b)}1m`,
];
const BEARERS = ["Bearer", "bearer", "BEARER"];
const API_KEYS = ["x-api-key", "X-Api-Key", "api-key", "api_key", "API_KEY"];
const BEARER_SEPARATORS = [" ", "  ", LF, `${C(0x2028)}`, " \n "];
const API_KEY_SEPARATORS = [": ", "=", ":", " = ", '": "', "='", '="', ": '", '"="'];
const BEFORE = ["", " ", "Authorization: ", "x.", "tenant", ";", LF, "word"];
const AFTER = ["", " ", ";", ",", " end", "&x", LF];
const BETWEEN = [" ", "", LF, "; ", ", "];
const KEYS: ReadonlyArray<readonly string[]> = [
	[],
	["tenant"],
	["B earer"],
	["earer"],
	["Bear"],
	["tenantBearer"],
	["api- key"],
];

function fuzzCase(r: () => number, n: number): Case {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;
	const credentials: string[] = [];
	const segments: string[] = [];
	const count = 1 + Math.floor(r() * 4);
	for (let k = 0; k < count; k++) {
		const token = `TOK${k}q${n}Z`;
		const bearer = r() < 0.45;
		let marker = pick(bearer ? BEARERS : API_KEYS);
		if (r() < 0.25) {
			const at = 1 + Math.floor(r() * (marker.length - 1));
			marker = `${marker.slice(0, at)}${pick(REMOVED)}${marker.slice(at)}`;
		}
		let separator = pick(bearer ? BEARER_SEPARATORS : API_KEY_SEPARATORS);
		const quote = separator.endsWith('"') ? '"' : separator.endsWith("'") ? "'" : "";
		const roll = r();
		if (roll < 0.1) separator = bearer ? pick(REMOVED) : `${separator.trim()}${pick(REMOVED)}`;
		else if (roll < 0.2) separator = `${pick(REMOVED)}${separator}`;
		else if (roll < 0.3) separator = `${separator}${pick(REMOVED)}`;
		let value: string;
		if (r() < 0.15) {
			// A marker inside the token, and the credential after it.
			value = `x.${pick(API_KEYS)}${pick(["=", ":"])}`;
		} else {
			value = r() < 0.15 ? `${token}${pick(REMOVED)}tail${n}` : token;
			credentials.push(token);
		}
		const close = quote !== "" && r() < 0.8 ? quote : "";
		segments.push(`${pick(BEFORE)}${marker}${separator}${value}${close}${pick(AFTER)}`);
	}
	let message = "";
	for (const [k, segment] of segments.entries()) {
		message += k === 0 ? segment : `${r() < 0.2 ? pick(REMOVED) : pick(BETWEEN)}${segment}`;
	}
	const secrets = r() < 0.15 && credentials.length > 0 ? [credentials[0] as string] : pick(KEYS);
	return { message, secrets, credentials };
}

const FUZZ: Case[] = [];
{
	const r = seeded(20261019);
	for (let n = 0; n < 20_000; n++) FUZZ.push(fuzzCase(r, n));
}

/** Removed characters and sequences that end a credential: whitespace first, as found. */
const ENDERS = [TAB, C(13), C(0x0b), C(0x0c), ...REMOVED];

/**
 * A chain of credentials, each ended by a character or sequence sanitizing removes, the next one's
 * marker right after it (split by one, or whole), and nothing else between.
 */
function chainCase(r: () => number, n: number): Case {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;
	const credentials: string[] = [];
	let message = pick(["", "r", " ", "x ", `r${ESC}`, `r${BEL}`]);
	const count = 2 + Math.floor(r() * 3);
	for (let k = 0; k < count; k++) {
		const token = `TOK${k}q${n}Z`;
		const bearer = r() < 0.5;
		let marker = pick(bearer ? BEARERS : API_KEYS);
		if (k > 0 && r() < 0.8) {
			const at = 1 + Math.floor(r() * (marker.length - 1));
			marker = `${marker.slice(0, at)}${pick(REMOVED)}${marker.slice(at)}`;
		}
		const separator = bearer ? pick([" ", TAB, LF, "  "]) : pick(API_KEY_SEPARATORS);
		const quote = separator.endsWith('"') ? '"' : separator.endsWith("'") ? "'" : "";
		const close = quote !== "" && r() < 0.5 ? quote : "";
		message += `${marker}${separator}${token}${close}`;
		credentials.push(token);
		if (k < count - 1) message += pick(ENDERS);
	}
	message += pick(["", " end", LF, ";x"]);
	return { message, secrets: pick(KEYS), credentials };
}

const CHAINS: Case[] = [];
{
	const r = seeded(20261021);
	for (let n = 0; n < 10_000; n++) CHAINS.push(chainCase(r, n));
}

describe("no regression from 5.1.0: what 5.1.0 redacted is never printed", () => {
	it("the oracle is 5.1.0: it prints what reviewers measured 5.1.0 printing", () => {
		expect(released(`Authorization: Bearer x.api_key= x-api-key: "S3CRET"`, [])).toContain(
			'Error: Authorization: Bearer [redacted] x-api-key: "[redacted]"',
		);
		expect(released(`Authorization: Bearer${TAB}part-one${TAB}part-two`, [])).toContain(
			"Error: Authorization: Bearer [redacted]",
		);
		// And it leaks what it leaked: a marker glued to the word before it.
		expect(released(`wordBearer ${VALUE}`, [])).toContain(VALUE);
	});

	it("every repro so far", () => {
		const found = REPROS.flatMap((c) =>
			regressions(head, c).map((token) => `${JSON.stringify(c.message)}: ${token}`),
		);
		expect(found).toEqual([]);
	});

	it("20,000 seeded messages", () => {
		const found: string[] = [];
		let redactedBefore = 0;
		for (const c of FUZZ) {
			for (const token of regressions(head, c))
				found.push(`${JSON.stringify(c.message)} ${JSON.stringify(c.secrets)}: ${token}`);
			const before = released(c.message, c.secrets);
			redactedBefore += c.credentials.filter((token) => !before.includes(token)).length;
		}
		expect(found.slice(0, 10)).toEqual([]);
		expect(found).toHaveLength(0);
		// The corpus exercises the oracle: it holds thousands of credentials 5.1.0 redacted.
		expect(redactedBefore).toBeGreaterThan(10_000);
		// And the marker-inside-a-token class is in it.
		expect(
			FUZZ.filter((c) => /Bearer x\.(?:x-)?api[-_]key[=:]/i.test(c.message)).length,
		).toBeGreaterThan(50);
	}, 60_000);

	it("10,000 seeded chains: each credential ended by a removed character, the next marker after it", () => {
		const found: string[] = [];
		let redactedBefore = 0;
		for (const c of CHAINS) {
			for (const token of regressions(head, c))
				found.push(`${JSON.stringify(c.message)} ${JSON.stringify(c.secrets)}: ${token}`);
			const before = released(c.message, c.secrets);
			redactedBefore += c.credentials.filter((token) => !before.includes(token)).length;
		}
		expect(found.slice(0, 10)).toEqual([]);
		expect(found).toHaveLength(0);
		expect(redactedBefore).toBeGreaterThan(10_000);
	}, 60_000);

	it("positive control: a line that only sanitizes is reported as regressing", () => {
		const unredacted: Line = (message) => scrubForStderr(message);
		expect(REPROS.some((c) => regressions(unredacted, c).length > 0)).toBe(true);
		expect(FUZZ.filter((c) => regressions(unredacted, c).length > 0).length).toBeGreaterThan(5_000);
		expect(CHAINS.filter((c) => regressions(unredacted, c).length > 0).length).toBeGreaterThan(
			5_000,
		);
	}, 60_000);
});
