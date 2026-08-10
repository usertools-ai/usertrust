// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * runaway-agent.ts — usertrust governance cuts off a runaway LLM agent.
 *
 * Scenario: a buggy agent is in a loop, burning tokens. Without governance
 * it would happily exhaust the entire budget. With usertrust wrapping the
 * OpenClaw stream function, the policy gate refuses the first call whose
 * pre-spend hold no longer fits in what is left — so the loop stops with
 * budget still on the table, rather than after it is gone.
 *
 * Run:
 *   pnpm --filter usertrust-openclaw demo
 *
 * (or: npx tsx packages/openclaw/demo/runaway-agent.ts)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCost } from "usertrust";
import { createUsertrustPlugin } from "../src/index.js";
import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	Model,
	StreamEvent,
	StreamFn,
} from "../src/types.js";

// Presentation-only pacing between calls (DEMO_PACE_MS=700 for recordings);
// 0 = off. Never affects governance behavior.
const PACE_MS = Number(process.env.DEMO_PACE_MS ?? 0) || 0;
const pace = () =>
	PACE_MS > 0 ? new Promise<void>((r) => setTimeout(r, PACE_MS)) : Promise.resolve();

// ── 1. The model the runaway agent is calling ──
const MODEL: Model = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	// USD per million tokens, matching the published rates the usertrust
	// pricing table was built from (packages/core/src/ledger/pricing.ts).
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

/** What the mock provider reports for every call. */
const CALL_USAGE = { input: 500, output: 1500 } as const;

/**
 * What one call actually settles at, priced by the SAME table governance
 * uses. Never a typed-in number: a hand-written conversion is exactly how
 * this demo came to print a budget worth four times its real value.
 */
const PER_CALL_UT = estimateCost(MODEL.id, CALL_USAGE.input, CALL_USAGE.output);

/**
 * USD per usertoken — the repo-wide invariant (AGENTS.md; also
 * `packages/core/src/govern.ts`): 1 usertoken = $0.0001, one basis point of a
 * cent. `~` appears only when the cent figure is a rounding of the real value.
 */
const UT_TO_USD = 0.0001;
function usd(usertokens: number): string {
	const exact = usertokens * UT_TO_USD;
	const cents = exact.toFixed(2);
	return `${Number(cents) === exact ? "" : "~"}$${cents}`;
}

/**
 * ── 2. A tiny budget ──
 *
 * Sized against the pre-spend hold, not against the settled cost. `authorize()`
 * holds a conservative estimate (the model's default max output), so the gate
 * fires while there is still real budget left — the loop settles three calls
 * and the fourth is refused before it can spend.
 */
const BUDGET = 4_000;
const vaultBase = mkdtempSync(join(tmpdir(), "usertrust-runaway-"));

console.log("\n  usertrust × OpenClaw — runaway agent demo");
console.log("  -------------------------------------------");
console.log(`  budget:        ${BUDGET.toLocaleString()} usertokens (${usd(BUDGET)})`);
console.log(`  agent model:   ${MODEL.id}`);
console.log(`  agent:         buggy loop, ${PER_CALL_UT.toLocaleString()} usertokens per call`);
console.log("");

// ── 3. The "runaway" mock streamFn — pretends to be a real LLM stream ──

function finalMessage(input: number, output: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const runawayStreamFn: StreamFn = (): AssistantMessageEventStreamLike => {
	const message = finalMessage(CALL_USAGE.input, CALL_USAGE.output);
	const events = (async function* (): AsyncGenerator<StreamEvent> {
		yield { type: "start", partial: message };
		yield { type: "text_start", contentIndex: 0, partial: message };
		for (let i = 0; i < 25; i++) {
			yield { type: "text_delta", contentIndex: 0, delta: `tok-${i} ` };
		}
		yield { type: "text_end", contentIndex: 0, content: "", partial: message };
		yield { type: "done", reason: "stop", message };
	})();

	return {
		[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
		result: async () => message,
	};
};

// ── 4. Wire the governance plugin ──
const plugin = createUsertrustPlugin({ budget: BUDGET, dryRun: true, vaultBase });
const governedStream = plugin.wrapStreamFn?.({
	provider: MODEL.provider,
	modelId: MODEL.id,
	streamFn: runawayStreamFn,
});
if (!governedStream) throw new Error("plugin missing wrapStreamFn");

// ── 5. Run the agent loop. Every iteration settles the same amount; the loop
//       ends when the next call's hold no longer fits in what is left. ──
const ctx: Context = {
	messages: [{ role: "user", content: "do the thing forever", timestamp: Date.now() }],
};

let call = 0;
let cutoff = false;
while (!cutoff && call < 40) {
	call += 1;
	await pace();
	try {
		let chunks = 0;
		for await (const _e of await governedStream(MODEL, ctx)) {
			chunks += 1;
		}
		console.log(`  call #${String(call).padStart(2)}  OK     chunks=${chunks}  → call settled`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  call #${String(call).padStart(2)}  BLOCK  ${msg.split("\n")[0]}`);
		cutoff = true;
	}
}

await pace();
console.log("");
console.log("  --- final ledger ----------------------------------------");
console.log(`  successful calls:  ${call - 1}`);
console.log(`  cut off at:        call #${call}`);
// Not "budget exhausted": the gate refuses the next HOLD, so the loop stops
// with real budget still unspent. Saying otherwise would misdescribe the
// product on the one surface that is meant to demonstrate it.
console.log(`  settled spend:     ${((call - 1) * PER_CALL_UT).toLocaleString()} usertokens`);
console.log(
	`  stopped by:        ${cutoff ? "the gate, before the spend" : "nothing — loop ran out"}`,
);
console.log("  ---------------------------------------------------------");
console.log("  Without usertrust, the buggy loop would have run forever.");
console.log("");

// cleanup
const { shutdown } = await import("../src/index.js");
await shutdown();
try {
	rmSync(vaultBase, { recursive: true, force: true });
} catch {
	// best effort
}
