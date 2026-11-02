// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A vault written by usertrust 5.0.0, the last release before the enforced-budget record (`effective-budget.json`):
 * every file that release's governor left in `.usertrust/`, byte for byte, with each file's SHA-256. The data is
 * synthetic: a dry-run governor, two governed calls with made-up token counts, and no prompt text (the pattern
 * memory holds only hashes).
 *
 * Produced, not hand-written: usertrust@5.0.0 installed from npm (dist.integrity
 * sha512-gPVzSYkFvhZpzpFRqCXrrMUg1qPjJ90zL33/wvx8tCR9YKwfF0I2I1EOF5sJcuCJXJuaog+AadfnbVFXnKfLTA==) into an empty
 * directory with `npm install --ignore-scripts usertrust@5.0.0`, then this script, given that install's
 * `node_modules/usertrust/dist/headless.js` and an empty directory as the vault base:
 *
 *     const [entry, vaultBase] = process.argv.slice(2);
 *     const { createGovernor } = await import(entry);
 *     const gov = await createGovernor({ dryRun: true, vaultBase, budget: 50_000 });
 *     for (let i = 0; i < 2; i++) {
 *         const auth = await gov.authorize({ model: "claude-haiku-4-5", estimatedInputTokens: 100, maxOutputTokens: 50 });
 *         await gov.settle(auth, { inputTokens: 100, outputTokens: 40 });
 *     }
 *     await gov.destroy(); // budgetRemaining() was 49_994 before it: two calls of 3 each
 *
 * The budget reached the governor only in memory (`opts.budget`, as usertrust-server passes a tenant's), so the vault
 * carries it nowhere: no config file, and no record. Each file below was then read back and printed as a string.
 */

/** One file of the vault: its path under `.usertrust/`, its SHA-256 as written, and its text. */
export interface VaultFile {
	path: string;
	sha256: string;
	text: string;
}

/** The budget the 5.0.0 governor enforced, given in memory only. */
export const VAULT_5_0_0_BUDGET = 50_000;

/** What its two calls cost: the `llm_call` events' costs and the spend ledger's `budgetSpent`. */
export const VAULT_5_0_0_SPENT = 6;

export const VAULT_5_0_0: readonly VaultFile[] = [
	{
		path: "audit/events.jsonl",
		sha256: "ae4ec7542b2b1a62964d9409b2f7ad990452a8c2de9f3693a736a0ee4381491c",
		text: '{"actor":"local","data":{"appliedRates":{"cacheReadPer1k":1,"cacheWritePer1k":12.5,"inputPer1k":10,"outputPer1k":50},"cost":3,"costBasis":"usd-proxy","endpointClass":"cloud","model":"claude-haiku-4-5","pricingTableVersion":"2026-10-11","settled":true,"source":"headless","transferId":"tx_mvfbopen_d6b874c8","usage":{"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":100,"outputTokens":40},"usageSource":"provider"},"hash":"ee0d5ec69f83ee5aa7a36541feabc084bc07c85a5683e6fa8420f16e58924b12","id":"5d816549-fe2c-45db-8133-6cbe86b84a66","kind":"llm_call","previousHash":"0000000000000000000000000000000000000000000000000000000000000000","sequence":1,"timestamp":"2026-10-19T14:01:23.639Z"}\n{"actor":"local","data":{"appliedRates":{"cacheReadPer1k":1,"cacheWritePer1k":12.5,"inputPer1k":10,"outputPer1k":50},"cost":3,"costBasis":"usd-proxy","endpointClass":"cloud","model":"claude-haiku-4-5","pricingTableVersion":"2026-10-11","settled":true,"source":"headless","transferId":"tx_mvfbopfk_927648ed","usage":{"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":100,"outputTokens":40},"usageSource":"provider"},"hash":"dd5fd7cedb1486c272b09670fc0d2c3cf03a60b1415f5c352307e7339b1dd1d9","id":"fc30a258-040a-4217-ad79-8ae9bf3997eb","kind":"llm_call","previousHash":"ee0d5ec69f83ee5aa7a36541feabc084bc07c85a5683e6fa8420f16e58924b12","sequence":2,"timestamp":"2026-10-19T14:01:23.655Z"}\n',
	},
	{
		path: "audit/events.jsonl.meta",
		sha256: "cc5e26d37b66d03935f4537440fc9831a04d38f6ccf19cbaf3f8273625c18b59",
		text: '{"lastHash":"dd5fd7cedb1486c272b09670fc0d2c3cf03a60b1415f5c352307e7339b1dd1d9","sequence":2}',
	},
	{
		path: "audit/index.json",
		sha256: "0a63de380ab55c6842dcc0094b1f35a56ca31d932d5633434c476c16bc519358",
		text: '[\n\t{\n\t\t"receiptId": "rcpt_mvfbopfi_09739306",\n\t\t"kind": "llm_call",\n\t\t"ts": "2026-10-19T14:01:23.646Z",\n\t\t"actor": "local",\n\t\t"path": "llm_call/2026-10-19/rcpt_mvfbopfi_09739306.json"\n\t},\n\t{\n\t\t"receiptId": "rcpt_mvfbopfz_23fabc0e",\n\t\t"kind": "llm_call",\n\t\t"ts": "2026-10-19T14:01:23.663Z",\n\t\t"actor": "local",\n\t\t"path": "llm_call/2026-10-19/rcpt_mvfbopfz_23fabc0e.json"\n\t}\n]',
	},
	{
		path: "audit/llm_call/2026-10-19/rcpt_mvfbopfi_09739306.json",
		sha256: "c0f199964cb3d5850806f2bdf2e3bd9006e2a7598807bbced152cbfc8a71ce5d",
		text: '{\n\t"v": 3,\n\t"ts": "2026-10-19T14:01:23.646Z",\n\t"kind": "llm_call",\n\t"subsystem": "headless",\n\t"actor": "local",\n\t"data": {\n\t\t"receiptId": "rcpt_mvfbopfi_09739306",\n\t\t"model": "claude-haiku-4-5",\n\t\t"cost": 3,\n\t\t"settled": true,\n\t\t"transferId": "tx_mvfbopen_d6b874c8"\n\t}\n}',
	},
	{
		path: "audit/llm_call/2026-10-19/rcpt_mvfbopfz_23fabc0e.json",
		sha256: "a271a46829fc3c4e5042059d8ec6c1d81926813f2def02cf2451d48f5a34daf1",
		text: '{\n\t"v": 3,\n\t"ts": "2026-10-19T14:01:23.663Z",\n\t"kind": "llm_call",\n\t"subsystem": "headless",\n\t"actor": "local",\n\t"data": {\n\t\t"receiptId": "rcpt_mvfbopfz_23fabc0e",\n\t\t"model": "claude-haiku-4-5",\n\t\t"cost": 3,\n\t\t"settled": true,\n\t\t"transferId": "tx_mvfbopfk_927648ed"\n\t}\n}',
	},
	{
		path: "patterns/memory.json",
		sha256: "21bbba79368bbb2487f59baa8d96a28e6688e4a14bfe9d1a7b5a955047471522",
		text: '[\n\t{\n\t\t"promptHash": "281b47a388a91bfdaaca0fb84b912a1c4f5e8c21197c2517a89a0ec05a9aa633",\n\t\t"model": "claude-haiku-4-5",\n\t\t"cost": 3,\n\t\t"success": true,\n\t\t"timestamp": "2026-10-19T14:01:23.647Z"\n\t},\n\t{\n\t\t"promptHash": "72ad457c96cd2512c9e769398fd25a11fdb12307fedf5a043fc5637ca6a48cfa",\n\t\t"model": "claude-haiku-4-5",\n\t\t"cost": 3,\n\t\t"success": true,\n\t\t"timestamp": "2026-10-19T14:01:23.664Z"\n\t}\n]',
	},
	{
		path: "spend-ledger.json",
		sha256: "d96dd903192b74d3f1f737708c6f7c8a994e41905dacc8d2f03f796619ed1e04",
		text: '{"budgetSpent":6,"updatedAt":"2026-10-19T14:01:23.649Z"}',
	},
];
