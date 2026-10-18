// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Each secret pattern against the token formats its provider documents, one row per format, the
 * source named in the row. Every value is synthetic and built here at run time from its parts, so
 * no token-shaped string sits in this file for a secret scanner to flag.
 */

import { describe, expect, it } from "vitest";
import { detectPII } from "../../src/policy/pii.js";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${UPPER}${UPPER.toLowerCase()}0123456789`;
const URLSAFE = `${ALNUM}_-`;

/** `n` characters of `alphabet`, the same on every run for the same seed. */
function chars(n: number, seed: number, alphabet = ALNUM): string {
	let x = seed >>> 0;
	let out = "";
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		out += alphabet[(x >>> 16) % alphabet.length];
	}
	return out;
}

const types = (text: string): string[] => detectPII({ text }).types;

const GITHUB =
	"docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github";
const AWS = "docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html";
const STRIPE = "docs.stripe.com/keys";
const SLACK = "docs.slack.dev/authentication/tokens";
const GITLAB = "docs.gitlab.com/security/tokens";
const NPM = "github.blog/changelog/2021-09-23-npm-has-a-new-access-token-format";
const SENDGRID = "twilio.com/docs/sendgrid/ui/account-and-settings/api-keys";
const ANTHROPIC = "platform.claude.com/docs/en/manage-claude/authentication";

/** A JWT's shape: three base64url segments, the header starting `eyJ` (`{"`). */
const jwt = (seed: number): string =>
	`ey${"J"}${chars(30, seed, URLSAFE)}.${chars(60, seed + 1, URLSAFE)}.${chars(43, seed + 2, URLSAFE)}`;

describe("GitHub tokens, by the prefixes GitHub documents", () => {
	const rows: Array<[string, string]> = [
		["classic personal access token (ghp_)", `gh${"p_"}${chars(36, 1)}`],
		["OAuth access token (gho_)", `gh${"o_"}${chars(36, 2)}`],
		["user access token for a GitHub App (ghu_)", `gh${"u_"}${chars(36, 3)}`],
		["installation access token (ghs_)", `gh${"s_"}${chars(36, 4)}`],
		["refresh token for a GitHub App (ghr_)", `gh${"r_"}${chars(76, 5)}`],
		[
			"fine-grained personal access token (github_pat_, 22 + _ + 59)",
			`github${"_pat_"}${chars(22, 6)}_${chars(59, 7)}`,
		],
		["stateless installation token (ghs_<app id>_<JWT>)", `gh${"s_"}1234567_${jwt(8)}`],
	];
	for (const [name, token] of rows) {
		it(`${name}, per ${GITHUB}`, () => {
			for (const text of [
				token,
				`token=${token}`,
				JSON.stringify({ authorization: `token ${token}` }),
			]) {
				expect(types(text), text.slice(0, 40)).toContain("github_token");
			}
		});
	}

	it("a fine-grained token's first segment one short is not a GitHub token", () => {
		expect(types(`github${"_pat_"}${chars(21, 6)}_${chars(59, 7)}`)).not.toContain("github_token");
	});

	it("an undocumented gh?_ prefix is not a GitHub token", () => {
		expect(types(`gh${"x_"}${chars(36, 9)}`)).not.toContain("github_token");
	});
});

describe("AWS access key ids, by the prefixes AWS documents", () => {
	it(`AKIA (access key) and ASIA (temporary STS access key id), per ${AWS}`, () => {
		for (const prefix of ["AK", "AS"]) {
			const key = `${prefix}IA${chars(16, 10, `${UPPER}234567`)}`;
			expect(types(`aws_access_key_id = ${key}`), prefix).toContain("aws_key");
		}
	});

	it("an IAM unique id that is not a key (AIDA, an IAM user) is not an AWS key", () => {
		expect(types(`AI${"DA"}${chars(16, 11, `${UPPER}234567`)}`)).not.toContain("aws_key");
	});
});

describe("Stripe keys, by the prefixes Stripe documents", () => {
	for (const prefix of ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "sk_org_"]) {
		it(`${prefix} (secret, restricted or organization key), per ${STRIPE}`, () => {
			const key = `${prefix.slice(0, 2)}${prefix.slice(2)}${chars(99, 12)}`;
			expect(types(`STRIPE_KEY=${key}`)).toContain("api_key");
		});
	}

	it("a publishable key (pk_live_), which Stripe documents as safe to expose, is not an API key", () => {
		expect(types(`pk${"_live_"}${chars(99, 13)}`)).not.toContain("api_key");
	});
});

describe("Slack tokens, by the prefixes Slack documents", () => {
	const rows: Array<[string, string]> = [
		[
			"bot token (xoxb-)",
			`xo${"xb-"}${chars(12, 14, "0123456789")}-${chars(13, 15, "0123456789")}-${chars(24, 16)}`,
		],
		[
			"user token (xoxp-)",
			`xo${"xp-"}${chars(12, 17, "0123456789")}-${chars(13, 18, "0123456789")}-${chars(32, 19)}`,
		],
		[
			"app-level token (xapp-)",
			`xa${"pp-"}1-A${chars(10, 20, UPPER)}-${chars(13, 21, "0123456789")}-${chars(64, 22, "0123456789abcdef")}`,
		],
		[
			"rotating app-level token (xoxe.xapp-)",
			`xo${"xe.xapp-"}1-A${chars(10, 23, UPPER)}-${chars(13, 24, "0123456789")}-${chars(40, 25)}`,
		],
		["workflow token (xwfp-)", `xw${"fp-"}${chars(40, 26)}`],
	];
	for (const [name, token] of rows) {
		it(`${name}, per ${SLACK}`, () => {
			expect(types(`SLACK_TOKEN=${token}`)).toContain("generic_secret");
		});
	}

	it("a word that only starts like an app-level token (xapp-config) is not a secret", () => {
		expect(types(`xa${"pp-"}config`)).not.toContain("generic_secret");
	});
});

describe("GitLab tokens, by the prefixes GitLab documents", () => {
	const prefixes = [
		"glpat-",
		"gloas-",
		"gldt-",
		"glrt-",
		"glrtr-",
		"glcbt-",
		"glptt-",
		"glft-",
		"glimt-",
		"glagent-",
		"glwt-",
		"glsoat-",
		"glffct-",
	];
	for (const prefix of prefixes) {
		it(`${prefix}, per ${GITLAB}`, () => {
			const token = `${prefix.slice(0, 2)}${prefix.slice(2)}${chars(20, 27, URLSAFE)}`;
			expect(types(`GITLAB_TOKEN=${token}`)).toContain("generic_secret");
		});
	}
});

describe("npm, SendGrid, Anthropic and OpenAI keys", () => {
	it(`npm access token (npm_, then 36: 30 random and a 6-character checksum), per ${NPM}`, () => {
		expect(types(`//registry.npmjs.org/:_authToken=np${"m_"}${chars(36, 28)}`)).toContain(
			"generic_secret",
		);
	});

	it(`SendGrid API key (SG., 69 characters in all; the page gives the length, not the prefix), per ${SENDGRID}`, () => {
		const key = `S${"G."}${chars(22, 29, URLSAFE)}.${chars(43, 30, URLSAFE)}`;
		expect(key).toHaveLength(69);
		expect(types(`SENDGRID_API_KEY=${key}`)).toContain("generic_secret");
	});

	it(`Anthropic API key (sk-ant-api03-), per ${ANTHROPIC}`, () => {
		const key = `sk${"-ant-api03-"}${chars(93, 31, URLSAFE)}AA`;
		expect(types(`ANTHROPIC_API_KEY=${key}`)).toContain("api_key");
	});

	it("OpenAI project key (sk-proj-; OpenAI's public docs do not give the format, so the prefix is the one its dashboard issues)", () => {
		const key = `sk${"-proj-"}${chars(156, 32, URLSAFE)}`;
		expect(types(`OPENAI_API_KEY=${key}`)).toContain("api_key");
	});
});

describe("keys and tokens in standard formats", () => {
	it("PEM private keys: PKCS #8, encrypted PKCS #8, RSA, EC and OpenSSH (RFC 7468, RFC 5915, OpenSSH PROTOCOL.key)", () => {
		for (const label of [
			"PRIVATE KEY",
			"ENCRYPTED PRIVATE KEY",
			"RSA PRIVATE KEY",
			"EC PRIVATE KEY",
			"OPENSSH PRIVATE KEY",
		]) {
			const pem = `-----${"BEGIN"} ${label}-----\n${chars(64, 33, `${ALNUM}+/`)}\n-----END ${label}-----`;
			expect(types(pem), label).toContain("private_key");
		}
	});

	it("a JWT (RFC 7519): three base64url segments", () => {
		expect(types(`id_token=${jwt(34)}`)).toContain("jwt");
	});

	it("a bearer token (RFC 6750 b64token: letters, digits and - . _ ~ + /, then =)", () => {
		const token = `${chars(30, 35)}-._~+/${chars(10, 36)}==`;
		expect(types(`Authorization: Bearer ${token}`)).toContain("bearer_token");
	});
});

describe("payloads that end in - or _, then any delimiter (the closing-boundary class)", () => {
	// A pattern that ends at a word boundary misses a token whose last characters are not word
	// characters: no boundary is there. Each format whose payload may hold - or _ is checked with
	// payloads ending in them, then each common delimiter.
	const endings = ["-", "--", "---", "_", "-_", "_-", "a-"];
	const after = ["", " ", "\n", '"', ",", ".", ")", ";", "-"];
	const formats: Array<[string, string, number, (payload: string) => string]> = [
		["api_key", "Anthropic sk-ant-api03-", 95, (p) => `sk${"-ant-api03-"}${p}`],
		["api_key", "OpenAI sk-proj-", 156, (p) => `sk${"-proj-"}${p}`],
		["api_key", "Stripe sk_live_", 99, (p) => `sk${"_live_"}${p}`],
		["api_key", "Stripe rk_live_", 99, (p) => `rk${"_live_"}${p}`],
		["api_key", "Stripe sk_org_", 99, (p) => `sk${"_org_"}${p}`],
		["generic_secret", "SendGrid SG.", 22, (p) => `S${"G."}${p}.${chars(43, 40, URLSAFE)}`],
		["generic_secret", "GitLab glpat-", 20, (p) => `gl${"pat-"}${p}`],
		["generic_secret", "GitLab gldt-", 20, (p) => `gl${"dt-"}${p}`],
	];
	for (const [kind, name, length, token] of formats) {
		it(`${name}: a ${length}-character payload ending in - or _`, () => {
			const missed: string[] = [];
			for (const ending of endings) {
				const payload = chars(length - ending.length, 41, URLSAFE) + ending;
				for (const tail of after) {
					const text = `KEY=${token(payload)}${tail}`;
					if (!types(text).includes(kind)) missed.push(JSON.stringify(ending + tail));
				}
			}
			expect(missed).toEqual([]);
		});
	}

	it("an sk- key of the shortest length detected, 20 characters, ending ---", () => {
		// Shorter than any documented key, so it is the case a closing word boundary would cut:
		// with no word character in its last three, the boundary falls at 17.
		expect(types(`sk${"-"}${chars(17, 43)}---`)).toContain("api_key");
	});

	it("Slack app-level token (letters, digits and -) ending in -", () => {
		for (const ending of ["-", "--", "---"]) {
			const token = `xa${"pp-"}${chars(40 - ending.length, 42, `${ALNUM}-`)}${ending}`;
			expect(types(`SLACK=${token}`), ending).toContain("generic_secret");
		}
	});
});

describe("identifiers that share a new prefix", () => {
	// Short identifiers are clean. A long one that begins with a whole documented prefix is
	// flagged, as sk_live_ always has been: over-redaction is the safe direction for a secret.
	const clean: Array<[string, string]> = [
		["github_token", "ghu_id"],
		["github_token", "ghu_user_lookup"],
		["github_token", `gh${"s_"}12_notes`],
		["github_token", `gh${"s_"}1234_eyj`],
		["aws_key", "ASIAN"],
		["aws_key", "ASIA2024"],
		["aws_key", "ASIA_PACIFIC_REGION_CODE"],
		["api_key", "rk_live_mode"],
		["api_key", "rk_test_id"],
		["api_key", "sk_org_id"],
		["api_key", "sk_org_settings"],
		["generic_secret", "xapp-config"],
		["generic_secret", "xapp-configuration-v2"],
		["generic_secret", "xwfp-flag"],
		["generic_secret", "gldt-v2"],
		["generic_secret", "glrt-runner-config"],
		["generic_secret", "glft-feed"],
	];
	for (const [kind, text] of clean) {
		it(`${text} is not ${kind}`, () => {
			expect(types(`const ${text} = 1;`)).not.toContain(kind);
		});
	}

	it("a long identifier that begins with a whole documented prefix is flagged", () => {
		expect(types(`sk${"_org_"}settings_for_the_dashboard`)).toContain("api_key");
	});
});
