import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DENIAL_EVENT,
	DENIAL_PROVENANCE,
	denialEventRows,
	denialThrowText,
	THROWN_DENIAL,
} from "./exhibit-c-data";

test("the captured artifact is the real PolicyDeniedError the SDK throws", () => {
	assert.equal(THROWN_DENIAL.name, "PolicyDeniedError");
	assert.match(THROWN_DENIAL.message, /^Policy denied: /);
	// the rule that actually denied the overshoot, named in the thrown message
	assert.match(THROWN_DENIAL.message, /\[block-budget-overshoot\]/);
});

test("the card renders the WHOLE throw — hint and docs line included", () => {
	assert.match(THROWN_DENIAL.message, /\n {2}Hint: /);
	assert.match(
		THROWN_DENIAL.message,
		/\n {2}Docs: https:\/\/usertrust\.ai\/docs\/errors\/policy-denied$/,
	);
	assert.equal(denialThrowText(), `${THROWN_DENIAL.name}: ${THROWN_DENIAL.message}`);
});

test("the throw itself still promises no receipt", () => {
	// A blocked call returns nothing: there is no receipt, and the error text
	// must never imply one. What CHANGED is the other half — the denial does now
	// leave a chain event, pinned separately below — so this assertion is about
	// the error text alone, not about the chain.
	assert.ok(!denialThrowText().toLowerCase().includes("receipt"));
});

test("the denial's chain event is real, and is the kind a denial writes", () => {
	assert.equal(DENIAL_EVENT.kind, "policy_denied");
	assert.equal(DENIAL_EVENT.data.decision, "deny");
	assert.equal(DENIAL_EVENT.data.denialClass, "budget_gate");
	assert.match(DENIAL_EVENT.hash, /^[a-f0-9]{64}$/);
	assert.match(DENIAL_EVENT.previousHash, /^[a-f0-9]{64}$/);
	assert.notEqual(DENIAL_EVENT.hash, DENIAL_EVENT.previousHash);
});

test("the event carries a prompt HASH and never the prompt", () => {
	const rows = denialEventRows();
	const promptRow = rows.find((r) => r.label === "promptHash");
	assert.ok(promptRow, "the denial event must publish its prompt hash");
	assert.match(promptRow.value, /^[a-f0-9]{64}$/);
	// The probe's prompt text must appear nowhere in what the page renders.
	const rendered = rows.map((r) => `${r.label} ${r.value}`).join(" ");
	assert.ok(!rendered.includes("runaway retry"), "prompt content leaked into a rendered row");
});

test("the event names the rule that denied the call and the hold that never opened", () => {
	const rows = denialEventRows();
	assert.equal(rows.find((r) => r.label === "rule")?.value, "block-budget-overshoot");
	assert.match(rows.find((r) => r.label === "transferId")?.value ?? "", /^tx_/);
});

test("provenance records the real probe and the real build", () => {
	// The probe is now a REAL LEDGER run, not the old dry-run repro — asserting
	// "dry-run" here would pin a claim the capture no longer makes.
	assert.equal(DENIAL_PROVENANCE.mode, "ledger");
	assert.match(THROWN_DENIAL.capturedFrom, /max_tokens/);
	assert.match(THROWN_DENIAL.capturedFrom, /usertoken budget/);
	assert.match(THROWN_DENIAL.capturedWith, /^usertrust \d+\.\d+\.\d+ @ [0-9a-f]{7,}$/);
});
