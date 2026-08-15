/**
 * The visitor card is derived, not composed. These pins keep the mockup from
 * smuggling in fields the wire does not have (token splits, capital, agent
 * names) and keep the action line scoped to what the receipt embeds.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { verifiedFixtureState } from "../fixture-harness";
import { actionHeadline, authorityRows, invoiceLines, receiptCardModel } from "./card-model";
import { receiptClaims } from "./claims";

test("actionHeadline: commit names the oid head and the disclosed repo, not the headline claim", () => {
	const state = verifiedFixtureState("commit-checkpoint.json");
	const claims = receiptClaims(state.envelope.receipt);
	const action = actionHeadline(claims.work, claims);
	const text = action.parts.map((part) => part.text).join("");
	assert.equal(text, "Committed 12283b89 to github.com/usertrust-ai/usertrust");
	assert.ok(action.byline.includes("workflow-attested"));
	assert.ok(action.byline.includes("claude-opus-4-6"));
});

test("actionHeadline: session carries no artifact claim", () => {
	const state = verifiedFixtureState("session-workflow-attested.json");
	const claims = receiptClaims(state.envelope.receipt);
	const action = actionHeadline(claims.work, claims);
	assert.equal(action.parts.map((part) => part.text).join(""), "Governed session");
});

test("authorityRows: only association, workload, models, providers — no invented credential", () => {
	const state = verifiedFixtureState("commit-checkpoint.json");
	const claims = receiptClaims(state.envelope.receipt);
	const rows = authorityRows(claims);
	assert.deepEqual(
		rows.map((row) => row.label),
		["Association", "Workload", "Models", "Providers"],
	);
	assert.ok(!rows.some((row) => /credential|policy|evaluated/i.test(row.label)));
});

test("invoiceLines: transfers + pricing + total, never a token split or a repeated number", () => {
	const state = verifiedFixtureState("commit-checkpoint.json");
	const claims = receiptClaims(state.envelope.receipt);
	const lines = invoiceLines(claims);
	assert.deepEqual(
		lines.map((line) => line.label),
		["Transfers", "Pricing", "Total"],
	);
	assert.ok(!lines.some((line) => /input|output|cache|capital/i.test(line.label)));
	assert.equal(lines.filter((line) => line.kind === "total").length, 1);
});

test("receiptCardModel: unqualified amount, live R40 caption, CLI that shipped in #106", () => {
	const state = verifiedFixtureState("commit-checkpoint.json");
	const claims = receiptClaims(state.envelope.receipt);
	const card = receiptCardModel(state, claims);
	assert.equal(card.amountUsd, claims.amountUsd);
	assert.equal(card.amountCaption, claims.amountCaption);
	assert.equal(card.verifyCommand, `npx usertrust-verify receipt ${state.receiptId}.json`);
	assert.ok(card.rungs.some((rung) => rung.id === "signed"));
	assert.ok(card.rungs.some((rung) => rung.id === "anchored" && rung.state === "pending"));
	assert.ok(!card.lines.some((line) => line.label === "Input"));
});
