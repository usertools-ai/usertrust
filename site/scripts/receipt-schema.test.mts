import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * THE PUBLISHED SCHEMAS ARE A PROMISE, AND THIS IS THE TEST OF IT.
 *
 * The site serves receipt.v1 and receipt.v2 at stable $id URLs, and Exhibit A
 * renders a receipt beside the claim that it is what the SDK returns. Those
 * statements can drift silently: the fixtures are machine-written from a real
 * run, the schemas are hand-maintained, and nothing but this file makes them
 * agree.
 *
 * BOTH versions are checked, because the docs make TWO promises. v2 is the one
 * that DESCRIBES a current receipt — it adds the four-tier `usage` split and
 * the `pricing` block. v1 is FROZEN, and the versioning page states that a
 * v1-only validator keeps accepting current receipts unchanged; that only holds
 * because v1 leaves the receipt root open. So v1 is asserted here too, as the
 * backward-compatibility promise it is. Do not "fix" v1 by teaching it the new
 * fields: a frozen schema that grows properties is no longer frozen, and v2 is
 * the file that exists for exactly this.
 *
 * It caught a real defect. The fixtures used to carry a SYNTHESISED
 * `cost: { estimated, actual }` object where the schema (and the SDK) say
 * `cost` is a scalar number — a receipt shape that has never existed, rendered
 * under the words "the SDK's actual return value".
 *
 * SCOPE OF THE VALIDATOR BELOW. It is a few dozen lines, not a JSON Schema
 * implementation: it covers exactly the keywords receipt.v1 uses (type,
 * required, properties, additionalProperties, oneOf, const, enum, pattern,
 * minimum) and THROWS on any keyword it does not know, so the day the schema
 * grows a construct this cannot check, the test fails loudly instead of
 * quietly passing everything. That is the whole reason it refuses to ignore
 * unknown keywords. No new dependency: the site's dependency budget is
 * @vercel/analytics and tsx, and a validator this small is not worth spending
 * it on.
 */

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v1Path = join(SITE_ROOT, "public", "schemas", "receipt.v1.schema.json");
const v2Path = join(SITE_ROOT, "public", "schemas", "receipt.v2.schema.json");
const ledgerPath = join(SITE_ROOT, "app", "evidence", "receipt-ledger.json");
const dryRunPath = join(SITE_ROOT, "app", "evidence", "receipt-dryrun.json");

type Json = unknown;
interface Schema {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, Schema>;
	additionalProperties?: boolean;
	oneOf?: Schema[];
	const?: Json;
	enum?: Json[];
	pattern?: string;
	minimum?: number;
	// Annotations — present in the file, irrelevant to validation.
	$schema?: string;
	$id?: string;
	title?: string;
	description?: string;
	format?: string;
	examples?: Json[];
}

const ANNOTATION_KEYS = new Set(["$schema", "$id", "title", "description", "format", "examples"]);
const SUPPORTED_KEYS = new Set([
	"type",
	"required",
	"properties",
	"additionalProperties",
	"oneOf",
	"const",
	"enum",
	"pattern",
	"minimum",
]);

/**
 * JSON Schema's type names, which are not JavaScript's. "integer" is a number
 * with no fractional part, and a number is not automatically an integer — v2
 * declares the token counts as integers precisely because a fractional token
 * count would mean the usage block was computed rather than reported.
 */
function matchesType(value: Json, type: string): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number";
		default:
			return typeof value === type;
	}
}

/** Best-effort name for an error message. */
function typeOf(value: Json): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Returns the list of violations; empty means valid. */
function validate(value: Json, schema: Schema, path: string): string[] {
	for (const key of Object.keys(schema)) {
		if (!SUPPORTED_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
			throw new Error(
				`receipt-schema.test: schema uses keyword "${key}" at ${path}, which this validator does not implement — extend it rather than trusting a pass.`,
			);
		}
	}
	const errors: string[] = [];

	if (schema.oneOf) {
		const matches = schema.oneOf.filter((s) => validate(value, s, path).length === 0);
		if (matches.length !== 1) {
			errors.push(`${path}: matched ${matches.length} oneOf branches, expected exactly 1`);
		}
		return errors;
	}

	if (schema.type !== undefined) {
		const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!allowed.some((t) => matchesType(value, t))) {
			errors.push(`${path}: expected type ${allowed.join("|")}, got ${typeOf(value)}`);
		}
	}
	if (schema.const !== undefined && value !== schema.const) {
		errors.push(`${path}: expected const ${String(schema.const)}, got ${String(value)}`);
	}
	if (schema.enum !== undefined && !schema.enum.includes(value)) {
		errors.push(`${path}: ${String(value)} is not one of ${schema.enum.map(String).join(", ")}`);
	}
	if (schema.pattern !== undefined && typeof value === "string") {
		if (!new RegExp(schema.pattern).test(value)) {
			errors.push(`${path}: "${value}" does not match /${schema.pattern}/`);
		}
	}
	if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
		errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
	}

	if (typeOf(value) === "object") {
		const obj = value as Record<string, Json>;
		for (const key of schema.required ?? []) {
			if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
		}
		for (const [key, child] of Object.entries(obj)) {
			const childSchema = schema.properties?.[key];
			if (childSchema) {
				errors.push(...validate(child, childSchema, `${path}.${key}`));
			} else if (schema.additionalProperties === false) {
				errors.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
			}
		}
	}
	return errors;
}

const v1 = JSON.parse(readFileSync(v1Path, "utf-8")) as Schema;
const v2 = JSON.parse(readFileSync(v2Path, "utf-8")) as Schema;
const VERSIONS: Array<[string, Schema]> = [
	["v1", v1],
	["v2", v2],
];

for (const [name, schema] of VERSIONS) {
	test(`the published ${name} schema's own examples validate (the validator is not vacuous)`, () => {
		const examples = schema.examples ?? [];
		assert.ok(examples.length > 0, `receipt.${name} must ship at least one example`);
		for (const [i, example] of examples.entries()) {
			assert.deepEqual(validate(example, schema, `${name}.examples[${i}]`), []);
		}
	});
}

test("a receipt missing a required field is REJECTED (the validator has teeth)", () => {
	const example = (v2.examples ?? [])[0] as Record<string, Json>;
	const { cost: _dropped, ...missing } = example;
	assert.ok(validate(missing, v2, "negative").length > 0, "dropping `cost` must fail");
	// And the shape the fixtures used to publish — a cost OBJECT — must fail too.
	const objectCost = { ...example, cost: { estimated: 40, actual: 30 } };
	assert.ok(
		validate(objectCost, v2, "negative").length > 0,
		"a synthesized cost object must fail the published schema",
	);
});

test("v1 stays FROZEN: it must not have grown the v2 additions", () => {
	const v1Props = Object.keys(v1.properties ?? {});
	assert.ok(!v1Props.includes("usage"), "v1 grew `usage` — that is what v2 is for");
	assert.ok(!v1Props.includes("pricing"), "v1 grew `pricing` — that is what v2 is for");
	// And the open root is what makes the compatibility promise true at all.
	assert.notEqual(v1.additionalProperties, false);
});

for (const [name, schema] of VERSIONS) {
	test(`every captured ledger receipt validates against ${name}`, () => {
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as {
			captures: Array<{ receipt: Record<string, Json> }>;
		};
		assert.ok(ledger.captures.length > 0, "no captures to validate");
		for (const { receipt } of ledger.captures) {
			assert.deepEqual(validate(receipt, schema, `${name}:${String(receipt.model)}`), []);
		}
	});

	test(`the captured dry-run receipt validates against ${name} too`, () => {
		const dry = JSON.parse(readFileSync(dryRunPath, "utf-8")) as { receipt: Record<string, Json> };
		assert.deepEqual(validate(dry.receipt, schema, `${name}:dryRun`), []);
	});
}

test("the receipt Exhibit A renders is a scalar-cost receipt, four-tier and reconcilable", () => {
	const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as {
		captures: Array<{
			receipt: {
				cost: number;
				usageSource?: string;
				usage?: Record<string, number>;
				pricing?: { appliedRates: Record<string, number>; tableVersion: string };
			};
		}>;
	};
	for (const { receipt } of ledger.captures) {
		assert.equal(typeof receipt.cost, "number");
		assert.equal(receipt.usageSource, "provider");
		const u = receipt.usage;
		const rates = receipt.pricing?.appliedRates;
		assert.ok(u && rates, "a provider-metered receipt must publish both halves of the recompute");
		const recomputed = Math.max(
			1,
			Math.ceil(
				(u.inputTokens * rates.inputPer1k +
					u.outputTokens * rates.outputPer1k +
					u.cacheReadTokens * rates.cacheReadPer1k +
					u.cacheWriteTokens * rates.cacheWritePer1k) /
					1000,
			),
		);
		assert.equal(recomputed, receipt.cost, "four-tier recompute must reproduce the receipt cost");
	}
});
