// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * runaway-agent.ts — usertrust governance cuts off a runaway LLM agent.
 *
 * Scenario: a buggy agent is in a loop, burning tokens. Without governance
 * it would happily exhaust the entire budget. With usertrust wrapping
 * the OpenClaw stream function, it gets cut off mid-stream the moment
 * the budget is exhausted.
 *
 * Run:
 *   pnpm --filter usertrust-openclaw demo
 *
 * (or: npx tsx packages/openclaw/demo/runaway-agent.ts)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsertrustPlugin } from "../src/index.js";
import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	Model,
	StreamEvent,
	StreamFn,
} from "../src/types.js";

// ── 1. Tiny budget — 1,200 usertokens (~$0.50 at typical rates) ──
const BUDGET = 1_200;
const vaultBase = mkdtempSync(join(tmpdir(), "usertrust-runaway-"));

console.log("\n  usertrust × OpenClaw — runaway agent demo");
console.log("  -------------------------------------------");
console.log(`  budget:        ${BUDGET.toLocaleString()} usertokens (~$0.50)`);
console.log("  agent model:   claude-sonnet-4-6");
console.log("  agent:         buggy loop, ~250 usertokens per call");
console.log("");

// ── 2. The "runaway" mock streamFn — pretends to be a real LLM stream ──
const MODEL: Model = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

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
	// ~240 usertokens / call
	const message = finalMessage(500, 1500);
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

// ── 3. Wire the governance plugin ──
const plugin = createUsertrustPlugin({ budget: BUDGET, dryRun: true, vaultBase });
const governedStream = plugin.wrapStreamFn?.({
	provider: MODEL.provider,
	modelId: MODEL.id,
	streamFn: runawayStreamFn,
});
if (!governedStream) throw new Error("plugin missing wrapStreamFn");

// ── 4. Run the agent loop. Each iteration costs ~$0.10 — it gets ~5 calls. ──
const ctx: Context = {
	messages: [{ role: "user", content: "do the thing forever", timestamp: Date.now() }],
};

let call = 0;
let cutoff = false;
while (!cutoff && call < 40) {
	call += 1;
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

console.log("");
console.log("  --- final ledger ----------------------------------------");
console.log(`  successful calls:  ${call - 1}`);
console.log(`  cut off at:        call #${call}`);
console.log(`  budget exhausted:  ${cutoff ? "yes — governance enforced" : "no"}`);
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
