/**
 * Test-only harness: a §8 fixture on disk → the `PageState` the page renders.
 *
 * Shared by `rendering.test.tsx` and `components.test.tsx` so both drive the
 * components through the REAL parser (`parseResolverResponse`) rather than
 * hand-built props. That matters: a rendering test that constructs its own
 * `VerifiedState` proves the components render something, not that they render
 * what the wire actually produces. Everything here goes through `wire.ts`, so a
 * fixture that would fail R1/R4/the §4.1 algebra can never reach a component.
 *
 * Not a `*.test.*` file, so no test glob picks it up; it is imported, never run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conformingFixtures } from "./fixtures/index";
import {
	type PageState,
	parseResolverResponse,
	type VerifiedClusterState,
	type VerifiedState,
} from "./lib/wire";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface WireFixture {
	routeParamId: string;
	wire: { httpStatus: number; headers: Record<string, string>; body: unknown };
}

export function loadFixture(relPath: string): WireFixture {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf-8")) as WireFixture;
}

/** The fixture's wire response, run through the page's only door (`wire.ts`). */
export function fixtureState(fixture: WireFixture): PageState {
	const { httpStatus, headers, body } = fixture.wire;
	return parseResolverResponse({
		routeParamId: fixture.routeParamId,
		httpStatus,
		headers,
		raw: body === null ? null : typeof body === "string" ? body : JSON.stringify(body),
	});
}

/**
 * The same, narrowed to a verified SESSION receipt. Throws rather than
 * skipping: a §8.1 fixture that no longer parses green is a regression in the
 * fixture or the parser, and a rendering test must not quietly pass over it.
 * A verified CLUSTER receipt throws too — handed to a session renderer it
 * would print session claims the receipt never made.
 */
export function verifiedFixtureState(relPath: string): VerifiedState {
	const state = fixtureState(loadFixture(relPath));
	if (state.kind !== "verified" || state.scope !== "session") {
		throw new Error(notVerifiedAs(relPath, state, "session"));
	}
	return state;
}

/** The cluster counterpart (receipt-spec v0.10 §15): throws unless the fixture verifies as a cluster receipt. */
export function verifiedClusterFixtureState(relPath: string): VerifiedClusterState {
	const state = fixtureState(loadFixture(relPath));
	if (state.kind !== "verified" || state.scope !== "cluster") {
		throw new Error(notVerifiedAs(relPath, state, "cluster"));
	}
	return state;
}

function notVerifiedAs(relPath: string, state: PageState, scope: "session" | "cluster"): string {
	const got =
		state.kind === "verified"
			? `a verified ${state.scope} receipt`
			: `"${state.kind}"${"detail" in state ? `: ${state.detail}` : ""}`;
	return `${relPath} did not resolve to a verified ${scope} receipt (got ${got})`;
}

/** Every §8.1 row whose single file resolves to a 200 ladder status. */
export function conformingVerifiedRows(): { id: string; file: string; exercises: string }[] {
	const rows: { id: string; file: string; exercises: string }[] = [];
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			const state = fixtureState(loadFixture(file));
			if (state.kind === "verified") rows.push({ id: entry.id, file, exercises: entry.exercises });
		}
	}
	return rows;
}
