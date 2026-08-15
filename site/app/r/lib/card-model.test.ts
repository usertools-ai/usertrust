/**
 * The visitor card is derived, not composed. These pins keep the mockup from
 * smuggling in fields the wire does not have (token splits, capital, agent
 * names) and keep the action line scoped to what the receipt embeds.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { verifiedFixtureState } from "../fixture-harness";
import {
	actionHeadline,
	actionVisibleText,
	authorityRows,
	invoiceLines,
	receiptCardModel,
} from "./card-model";
import { receiptClaims } from "./claims";

test("actionHeadline: commit scopes to repoId and keeps the full oid on the hash part", () => {
	const state = verifiedFixtureState("commit-checkpoint.json");
	const claims = receiptClaims(state.envelope.receipt);
	const action = actionHeadline(claims.work, claims);
	assert.equal(actionVisibleText(action), "Committed 12283b89… to github.com:R_kgDOK1x2Yw");
	const oid = action.parts.find((part) => part.kind === "hash");
	assert.ok(oid !== undefined && oid.kind === "hash");
	assert.equal(oid.full, "12283b89ad55b584c7959394a527e24da0ec1f5e");
	assert.equal(action.repoDisplayName, "github.com/usertrust-ai/usertrust");
	assert.ok(action.byline.includes("workflow-attested"));
	assert.ok(action.byline.includes("claude-opus-4-6"));
});

test("actionHeadline: a keyed repoId stays the scope, never the undisclosed label", () => {
	const state = verifiedFixtureState("pr-private.json");
	const claims = receiptClaims(state.envelope.receipt);
	const action = actionHeadline(claims.work, claims);
	assert.equal(actionVisibleText(action), "PR #412 in r1_9f2a7c31e8b4");
	assert.equal(action.repoDisplayName, undefined);
});

test("actionHeadline: session carries no artifact claim", () => {
	const state = verifiedFixtureState("session-workflow-attested.json");
	const claims = receiptClaims(state.envelope.receipt);
	const action = actionHeadline(claims.work, claims);
	assert.equal(actionVisibleText(action), "Governed session");
	assert.equal(action.repoDisplayName, undefined);
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
	assert.equal(
		card.verifyCommand,
		`npx usertrust-verify receipt ${state.receiptId}.json --trust <snapshot.json>`,
	);
	assert.ok(card.rungs.some((rung) => rung.id === "signed"));
	assert.ok(card.rungs.some((rung) => rung.id === "anchored" && rung.state === "pending"));
	assert.ok(!card.lines.some((line) => line.label === "Input"));
});
