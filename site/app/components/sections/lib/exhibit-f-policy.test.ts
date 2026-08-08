import assert from "node:assert/strict";
import { test } from "node:test";
import { CHITS, POLICY_LINES, policyYamlText } from "./exhibit-f-policy";

// The 12 FieldOperator values from packages/core/src/shared/types.ts.
const REAL_OPERATORS = new Set([
	"exists",
	"not_exists",
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"not_in",
	"contains",
	"regex",
]);

test("rendered segments reassemble into exactly the YAML the engine validates", () => {
	const joined = POLICY_LINES.map((l) => l.segs.map((s) => s.t).join("")).join("\n");
	assert.equal(joined, policyYamlText());
	assert.ok(joined.startsWith("rules:"));
	assert.ok(joined.includes("frontier-cost-cap"));
	assert.ok(joined.includes("research-scope-guard"));
	assert.ok(joined.includes("scopePatterns"));
	assert.ok(joined.includes("timeWindows"));
});

test("every operator chip is a real FieldOperator and its text equals its token", () => {
	const chipOps = POLICY_LINES.flatMap((l) => l.segs).filter((s) => s.op !== undefined);
	assert.ok(chipOps.length >= 4, "expected at least four operator chips");
	for (const seg of chipOps) {
		assert.ok(REAL_OPERATORS.has(seg.op as string), `${seg.op} is not a real operator`);
		assert.equal(seg.t, seg.op, "chip text must equal the operator token");
	}
	const distinct = new Set(chipOps.map((s) => s.op));
	for (const required of ["eq", "gt", "in", "regex"]) {
		assert.ok(distinct.has(required as never), `missing required operator chip: ${required}`);
	}
});

test("every chit caughtBy points at an operator that exists in the YAML", () => {
	const yamlOps = new Set(POLICY_LINES.flatMap((l) => l.segs).flatMap((s) => (s.op ? [s.op] : [])));
	for (const chit of CHITS) {
		for (const line of chit.lines) {
			for (const op of line.caughtBy ?? []) {
				assert.ok(yamlOps.has(op), `${chit.id}/${line.label} references unknown op ${op}`);
			}
		}
	}
});

test("exactly one chit is the violator and it carries model + cost lines", () => {
	const blocked = CHITS.filter((c) => c.verdict === "blocked");
	assert.equal(blocked.length, 1);
	const labels = blocked[0].lines.map((l) => l.label);
	assert.ok(labels.includes("model"));
	assert.ok(labels.includes("est_cost"));
});

test("the redacted PII line never contains a digit", () => {
	for (const chit of CHITS) {
		for (const line of chit.lines) {
			if (line.redacted) assert.ok(!/\d/.test(line.value), "redacted value must hold no digits");
		}
	}
});
