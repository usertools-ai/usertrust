import assert from "node:assert/strict";
import { test } from "node:test";
import factsJson from "../evidence/facts.json";
import type { EvidenceFacts } from "../evidence/types";
import { computeRace, pct, raceBounds, raceDefaults } from "./budget-race";

const BUDGET = (factsJson as EvidenceFacts).facts.usertokensPerFiveDollars.value;

test("bounds derive from the manifest budget", () => {
	assert.deepEqual(raceBounds(BUDGET), {
		agentsMin: 1,
		agentsMax: 8,
		agentsStep: 1,
		costMin: 5000,
		costMax: 20000,
		costStep: 1000,
	});
});

test("defaults: 4 agents, budget/4 snapped DOWN onto the step grid", () => {
	assert.deepEqual(raceDefaults(BUDGET), { agents: 4, costPerCall: 12000 });
});

test("two-phase state at defaults: four holds land, the retry is the one BLOCKED row", () => {
	const d = raceDefaults(BUDGET);
	const r = computeRace(BUDGET, d.agents, d.costPerCall);
	assert.equal(r.holds.length, d.agents + 1);
	assert.equal(r.heldTotal, 48000);
	assert.equal(r.available, 2000);
	assert.equal(r.blockedCount, 1);
	assert.equal(r.extraDenied, 0);
	assert.equal(r.firstBlocked?.label, "agent 01 · retry");
});

test("without holds at defaults: the race settles past the cap", () => {
	const d = raceDefaults(BUDGET);
	const r = computeRace(BUDGET, d.agents, d.costPerCall);
	assert.equal(r.settledTotal, 60000);
	assert.equal(r.overshoot, 10000);
	assert.equal(r.settles[0]?.pastCap, false);
	assert.equal(r.settles.at(-1)?.pastCap, true);
});

test("the holds bar can never pass 100%: sweep every slider position", () => {
	const b = raceBounds(BUDGET);
	for (let agents = b.agentsMin; agents <= b.agentsMax; agents += b.agentsStep) {
		for (let cost = b.costMin; cost <= b.costMax; cost += b.costStep) {
			const r = computeRace(BUDGET, agents, cost);
			assert.ok(
				r.heldTotal <= BUDGET,
				`held ${r.heldTotal} > budget at agents=${agents} cost=${cost}`,
			);
			for (const row of r.holds.filter((h) => h.blocked)) {
				assert.ok(cost > row.availableBefore, "a blocked hold must actually exceed available");
			}
		}
	}
});

test("pct renders a CSS percentage", () => {
	assert.equal(pct(0.5), "50.000%");
});
