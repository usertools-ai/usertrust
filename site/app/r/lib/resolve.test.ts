/**
 * `resolvePageState` — R3's "the 410 `billedUnfinalized` bundle is
 * cross-checked BEFORE its link is rendered or followed." `wire.test.ts`
 * (Task 2) already proves `verifyBilledUnfinalizedLinkage` itself is
 * correct given two already-parsed `PageState`s; this file proves the
 * TRANSPORT wiring around it — that the page's own door actually performs
 * the second fetch, with the same options (`fetchImpl`/`baseUrl`) as the
 * first, and that it never chases a link past one hop.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BilledUnfinalizedMutantCase, WireHeaders } from "../fixtures/types";
import { resolvePageState } from "./resolve";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture<T>(relPath: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf-8")) as T;
}

interface WireFixture {
	routeParamId: string;
	wire: { httpStatus: number; headers: WireHeaders; body: unknown };
}

function responseFor(wire: WireFixture["wire"]): Response {
	const body = wire.body === null ? "" : JSON.stringify(wire.body);
	return new Response(body, {
		status: wire.httpStatus,
		headers: wire.headers as Record<string, string>,
	});
}

/** Answers fetch calls in ORDER — call 1 gets `first`, call 2 gets `second`, and so on. */
function sequentialFetch(...responses: Response[]): { impl: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	let i = 0;
	const impl = (async (url: string | URL) => {
		calls.push(String(url));
		const response = responses[Math.min(i, responses.length - 1)];
		i++;
		return response;
	}) as typeof fetch;
	return { impl, calls };
}

test("C21 <-> C18: the happy path fetches the linked receipt and renders a verified link", async () => {
	const bundle = loadFixture<WireFixture>("billed-unfinalized.json");
	const linked = loadFixture<WireFixture>("session-fallback.json");
	const { impl, calls } = sequentialFetch(responseFor(bundle.wire), responseFor(linked.wire));

	const state = await resolvePageState(bundle.routeParamId, { fetchImpl: impl });

	assert.equal(calls.length, 2, "the bundle AND the linked receipt are each fetched once");
	assert.equal(state.kind, "billedUnfinalized");
	if (state.kind !== "billedUnfinalized") return;
	assert.equal(state.linkage, "verified");
	assert.equal(state.linkedReceiptId, linked.routeParamId);
});

test("a non-billedUnfinalized state never triggers a second fetch", async () => {
	const fixture = loadFixture<WireFixture>("unknown.json");
	const { impl, calls } = sequentialFetch(responseFor(fixture.wire));

	const state = await resolvePageState(fixture.routeParamId, { fetchImpl: impl });

	assert.equal(calls.length, 1);
	assert.equal(state.kind, "unknownReceipt");
});

test("R3: each X1 mutant equality fails closed to integrityFailure, and the link never renders", async () => {
	const files = [
		"billed-unfinalized-mutants/linked-receipt-id-mismatch.json",
		"billed-unfinalized-mutants/source-reservation-id-mismatch.json",
		"billed-unfinalized-mutants/transfer-set-root-mismatch.json",
	];
	for (const file of files) {
		const mutant = loadFixture<BilledUnfinalizedMutantCase>(file);
		const linkedWire: WireFixture["wire"] = {
			httpStatus: 200,
			headers: {},
			body: mutant.linkedReceipt,
		};
		const { impl, calls } = sequentialFetch(responseFor(mutant.wire), responseFor(linkedWire));

		const state = await resolvePageState(mutant.routeParamId, { fetchImpl: impl });

		assert.equal(calls.length, 2, file);
		assert.equal(state.kind, "integrityFailure", file);
		if (state.kind !== "integrityFailure") continue;
		assert.ok(state.cause.source === "page" && state.cause.obligation === "R3", file);
		if (state.cause.source === "page" && state.cause.obligation === "R3") {
			assert.equal(state.cause.brokenEquality, mutant.brokenEquality, file);
		}
	}
});

test("R3: the routeBodyId mutant fails closed WITHOUT ever fetching a linked receipt", async () => {
	const mutant = loadFixture<BilledUnfinalizedMutantCase>(
		"billed-unfinalized-mutants/route-body-id-mismatch.json",
	);
	const { impl, calls } = sequentialFetch(responseFor(mutant.wire));

	const state = await resolvePageState(mutant.routeParamId, { fetchImpl: impl });

	assert.equal(calls.length, 1, "decidable from the 410 alone — no second fetch needed");
	assert.equal(state.kind, "integrityFailure");
	if (state.kind !== "integrityFailure") return;
	assert.ok(state.cause.source === "page" && state.cause.obligation === "R3");
});

test("a chain of billedUnfinalized bundles is rejected in exactly two fetches, never chased further", async () => {
	const bundle = loadFixture<WireFixture>("billed-unfinalized.json");
	// The "linked" receipt is ITSELF another billedUnfinalized bundle — a
	// resolver would never do this, but the page must still fail closed
	// rather than recurse.
	const { impl, calls } = sequentialFetch(responseFor(bundle.wire), responseFor(bundle.wire));

	const state = await resolvePageState(bundle.routeParamId, { fetchImpl: impl });

	assert.equal(calls.length, 2, "exactly one hop is ever followed");
	assert.equal(state.kind, "integrityFailure");
});
