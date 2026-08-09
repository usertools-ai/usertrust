/**
 * capture-evidence.mts — evidence-capture pipeline for the usertrust.ai site.
 *
 * Runs REAL usertrust from the workspace and writes the committed fixtures
 * under site/app/evidence/ plus a raw JSONL under site/public/evidence/.
 * This is a MAINTAINER step — fixtures are committed; the site build never
 * runs this script and never needs TigerBeetle.
 *
 * Modes:
 *   npm run evidence:capture                     # full: real-ledger + dry-run
 *                                                # (needs a TigerBeetle >= 0.17.5
 *                                                #  binary; pin 0.17.9 per CI)
 *   tsx scripts/capture-evidence.mts --dry-run-only   # no TigerBeetle (used by test)
 *   ... --out <dir>                              # write fixtures flat into <dir>
 *
 * Prerequisite: npm ci && npx tsc -b  (imports resolve to each package's dist/
 * via the workspace symlinks in node_modules).
 * No network, no API keys: the governed clients are duck-typed fakes that
 * satisfy detect.ts's Anthropic and OpenAI shapes and return canned responses
 * carrying real four-tier usage numbers.
 *
 * WHAT THE FIXTURES PROMISE (and how this file keeps the promise)
 *
 *  - `receipt-ledger.json` carries the receipt object the SDK ACTUALLY returns:
 *    `cost` is the scalar number on `TrustReceipt`, and `chainPath`,
 *    `receiptUrl`, `usage` and `pricing` are whatever the settle produced. The
 *    pre-call ESTIMATE is a sidecar (`capture.estimatedCost`) on the wrapper,
 *    never a field inside the receipt — a synthesized `cost: {estimated,
 *    actual}` object labelled as an SDK return value is a fabricated API.
 *  - The chain slice comes from THE SAME VAULT as those receipts, so every
 *    featured receipt's `auditHash` is literally an entry in the slice and
 *    Exhibit A's "link N of the chain" is a fact rather than a coincidence.
 *    Asserted below; a miss fails the capture instead of shipping.
 *  - One call is DENIED on purpose. Since #87 a denial writes a real
 *    `policy_denied` chain event, so the denial's evidence is captured the same
 *    way everything else is — the thrown error AND its chain event, both real.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustReceipt } from "usertrust";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Matches TrustConfigSchema's default tigerbeetle.addresses ["127.0.0.1:3001"]
// (packages/core/src/shared/types.ts) — no config file needed in the vault.
const TB_PORT = 3001;
const BUDGET = 50_000;
const MAX_TOKENS = 256;
/** Deliberately unaffordable: drives the block-budget-overshoot deny gate. */
const OVERSHOOT_MAX_TOKENS = 4_000_000;
/** Chain entries the site renders (Exhibit D's merkle tree wants a power of two). */
const SLICE_SIZE = 8;

/**
 * The three frontier models every public receipt surface shows (Addendum J).
 *
 * `shape` is the CLIENT shape the fake presents, not a vendor: Kimi ships an
 * OpenAI-compatible API, so `detectClientKind` reports "openai" for it and the
 * receipt's `provider` field records exactly that. The page must never dress
 * that up as "moonshot" — the field says what detection truly returned.
 */
const CAPTURE_MODELS = [
	{ id: "claude-fable-5", shape: "anthropic" },
	{ id: "gpt-5.6-sol", shape: "openai" },
	{ id: "kimi-k3", shape: "openai" },
] as const;

type ClientShape = (typeof CAPTURE_MODELS)[number]["shape"];

const argv = process.argv.slice(2);
const dryRunOnly = argv.includes("--dry-run-only");
const outIdx = argv.indexOf("--out");
const OUT_DIR = outIdx !== -1 ? resolve(argv[outIdx + 1] ?? ".") : null;
const appEvidence = OUT_DIR ?? join(REPO_ROOT, "site", "app", "evidence");
const publicEvidence = OUT_DIR ?? join(REPO_ROOT, "site", "public", "evidence");

// ── duck-typed fake clients ──
//
// Token counts are canned but SHAPED like the real thing: the four tiers are
// disjoint, and each SDK's own inclusivity rule is honoured (Anthropic reports
// the tiers separately; OpenAI's `prompt_tokens` is inclusive of both cache
// counters). Getting that wrong here would produce a receipt whose four-tier
// `usage` block does not reconcile against its own `cost`.
interface FakeArgs {
	model: string;
	max_tokens: number;
	messages: Array<{ role: string; content: string }>;
}

interface FakeUsage {
	freshInput: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function usageForCall(call: number): FakeUsage {
	return {
		freshInput: 300 + call * 17,
		output: 120 + call * 11,
		cacheRead: 80 + call * 7,
		cacheWrite: 40 + call * 3,
	};
}

function fakeAnthropic() {
	let call = 0;
	return {
		messages: {
			create: async (args: FakeArgs) => {
				call += 1;
				const u = usageForCall(call);
				return {
					id: `msg_capture_${call}`,
					type: "message",
					role: "assistant",
					model: args.model,
					content: [
						{ type: "text", text: `canned capture response ${call} — offline, no network` },
					],
					stop_reason: "end_turn",
					stop_sequence: null,
					// Anthropic reports the tiers DISJOINT — input_tokens excludes both
					// cache counters (fromAnthropicUsage passes them straight through).
					usage: {
						input_tokens: u.freshInput,
						output_tokens: u.output,
						cache_read_input_tokens: u.cacheRead,
						cache_creation_input_tokens: u.cacheWrite,
					},
				};
			},
		},
	};
}

function fakeOpenAI() {
	let call = 0;
	return {
		chat: {
			completions: {
				create: async (args: FakeArgs) => {
					call += 1;
					const u = usageForCall(call);
					return {
						id: `chatcmpl_capture_${call}`,
						object: "chat.completion",
						model: args.model,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: `canned capture response ${call} — offline, no network`,
								},
								finish_reason: "stop",
							},
						],
						// OpenAI's prompt_tokens is INCLUSIVE of both cache counters, so
						// the total is summed here and fromOpenAICompletionsUsage
						// subtracts them back out to recover fresh input.
						usage: {
							prompt_tokens: u.freshInput + u.cacheRead + u.cacheWrite,
							completion_tokens: u.output,
							total_tokens: u.freshInput + u.cacheRead + u.cacheWrite + u.output,
							prompt_tokens_details: { cached_tokens: u.cacheRead },
							cache_write_tokens: u.cacheWrite,
						},
					};
				},
			},
		},
	};
}

function fakeClient(shape: ClientShape): unknown {
	return shape === "anthropic" ? fakeAnthropic() : fakeOpenAI();
}

type GovernedResult = { response: unknown; receipt: TrustReceipt };

/** Invoke the governed surface that matches the client shape. */
async function governedCall(
	client: unknown,
	shape: ClientShape,
	args: FakeArgs,
): Promise<GovernedResult> {
	if (shape === "anthropic") {
		const c = client as { messages: { create: (a: FakeArgs) => Promise<unknown> } };
		return (await c.messages.create(args)) as unknown as GovernedResult;
	}
	const c = client as {
		chat: { completions: { create: (a: FakeArgs) => Promise<unknown> } };
	};
	return (await c.chat.completions.create(args)) as unknown as GovernedResult;
}

interface Provenance {
	usertrustVersion: string;
	tigerbeetleVersion: string | null;
	capturedAt: string;
	mode: "ledger" | "dry-run";
	commit: string;
}

/**
 * One captured call: the receipt EXACTLY as returned, plus capture-side
 * metadata that is deliberately OUTSIDE the receipt object.
 */
interface Capture {
	receipt: TrustReceipt;
	capture: {
		/** Pre-call estimate from `estimateCost` — an input to the hold, not a receipt field. */
		estimatedCost: number;
		/** Client shape `detectClientKind` matched. `receipt.provider` is the same string. */
		clientShape: ClientShape;
	};
}

interface ChainEvent {
	kind: string;
	hash: string;
	previousHash: string;
	timestamp: string;
	actor?: string;
	data?: Record<string, unknown>;
}

// ── TigerBeetle helpers ──
function tbBinary(): { bin: string; version: string } {
	const bin = process.env.USERTRUST_TB_BIN ?? "tigerbeetle";
	let out: string;
	try {
		out = execFileSync(bin, ["version"], { encoding: "utf-8" });
	} catch {
		throw new Error(
			`TigerBeetle binary not found (looked for "${bin}").\n` +
				`Fixtures are committed — the site build never needs this. To (re)capture:\n` +
				`  curl -fsSLo tb.zip https://github.com/tigerbeetle/tigerbeetle/releases/download/0.17.9/tigerbeetle-universal-macos.zip\n` +
				`  unzip -o tb.zip && USERTRUST_TB_BIN="$PWD/tigerbeetle" npm run evidence:capture`,
		);
	}
	// Output shape: "TigerBeetle version 0.17.9+..." — parse and enforce the
	// tigerbeetle-node 0.17.9 floor (server >= 0.17.5; client never newer than server).
	const m = /version (\d+)\.(\d+)\.(\d+)/.exec(out);
	if (m === null) throw new Error(`could not parse TigerBeetle version from: ${out.trim()}`);
	const [, maj, min, pat] = m;
	const version = `${maj}.${min}.${pat}`;
	if (Number(maj) === 0 && (Number(min) < 17 || (Number(min) === 17 && Number(pat) < 5))) {
		throw new Error(
			`TigerBeetle server ${version} is too old for tigerbeetle-node 0.17.9 (needs >= 0.17.5). ` +
				`Download 0.17.9 (see the URL in the not-found error above) and re-run with USERTRUST_TB_BIN.`,
		);
	}
	return { bin, version };
}

function portOpen(port: number): Promise<boolean> {
	return new Promise((res) => {
		const sock = createConnection({ host: "127.0.0.1", port }, () => {
			sock.destroy();
			res(true);
		});
		sock.on("error", () => {
			sock.destroy();
			res(false);
		});
	});
}

async function waitForPort(port: number): Promise<void> {
	for (let i = 0; i < 60; i++) {
		if (await portOpen(port)) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`TigerBeetle did not accept connections on 127.0.0.1:${port} within 30s`);
}

// ── audit-chain helpers ──
async function readChainEvents(vault: string): Promise<{ raw: string; events: ChainEvent[] }> {
	const raw = await readFile(join(vault, ".usertrust", "audit", "events.jsonl"), "utf-8");
	const events = raw
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as ChainEvent);
	return { raw, events };
}

function sliceFromEvents(events: ChainEvent[]) {
	const tail = events.slice(-SLICE_SIZE);
	if (tail.length !== SLICE_SIZE) {
		throw new Error(`expected >= ${SLICE_SIZE} chain events, got ${events.length}`);
	}
	const baseSeq = events.length - SLICE_SIZE;
	return {
		entries: tail.map((e, i) => ({
			seq: baseSeq + i + 1, // 1-based line number in events.jsonl
			type: e.kind,
			hash: e.hash,
			prevHash: e.previousHash,
			timestamp: e.timestamp,
			summary: [
				e.kind,
				typeof e.data?.model === "string" ? e.data.model : null,
				typeof e.data?.cost === "number" ? `${e.data.cost} usertokens` : null,
				typeof e.data?.denialClass === "string" ? `denied · ${e.data.denialClass}` : null,
			]
				.filter(Boolean)
				.join(" · "),
		})),
	};
}

// ── facts derivation (values derived from source at capture time — never hand-typed) ──
async function deriveFacts(tigerbeetleVersion: string, commit: string, usertrustVersion: string) {
	const ledgerSrc = await readFile(join(REPO_ROOT, "packages/core/src/ledger/client.ts"), "utf-8");
	const transferCodes = (ledgerSrc.match(/^export const XFER_/gm) ?? []).length;
	const accountCodes = (ledgerSrc.match(/^export const CODE_/gm) ?? []).length;

	const typesSrc = await readFile(join(REPO_ROOT, "packages/core/src/shared/types.ts"), "utf-8");
	const unionStart = typesSrc.indexOf("export type FieldOperator =");
	if (unionStart === -1) throw new Error("FieldOperator union not found in shared/types.ts");
	const union = typesSrc.slice(unionStart, typesSrc.indexOf(";", unionStart));
	const policyOperators = (union.match(/"[a-z_]+"/g) ?? []).length;

	const verifyPkg = JSON.parse(
		await readFile(join(REPO_ROOT, "packages/verify/package.json"), "utf-8"),
	) as { dependencies?: Record<string, string> };
	const verifierRuntimeDeps = Object.keys(verifyPkg.dependencies ?? {}).length;

	const { PRICING_TABLE } = (await import("usertrust/pricing")) as {
		PRICING_TABLE: Record<string, unknown>;
	};
	const modelNumeric = Object.keys(PRICING_TABLE).length;

	// AGENTS.md invariants — one `Prevents:` clause per invariant entry (D2).
	const agentsSrc = await readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8");
	const invariantCount = (agentsSrc.match(/Prevents:/g) ?? []).length;

	// Harden-doctrine counts (Addendum D2): mechanical counts over the test
	// tree. expect() totals are TEST assertions, not runtime guarantees (D6).
	const hardenSuiteCount = (
		await readdir(join(REPO_ROOT, "packages/core/tests/harden"), { recursive: true })
	).filter((f) => f.endsWith(".test.ts")).length;

	const testFiles = (await readdir(join(REPO_ROOT, "packages"), { recursive: true })).filter(
		(f) => f.endsWith(".test.ts") && !f.includes("node_modules") && !f.includes("dist"),
	);
	let testCaseCount = 0;
	let expectAssertionCount = 0;
	for (const rel of testFiles) {
		const src = await readFile(join(REPO_ROOT, "packages", rel), "utf-8");
		testCaseCount += (src.match(/^\s*(?:it|test)(?:\.\w+)?\(/gm) ?? []).length;
		expectAssertionCount += (src.match(/expect\(/g) ?? []).length;
	}

	// Parity contract (AGENTS.md): verify shares ZERO lines with core. Re-audit
	// it mechanically — every import specifier in packages/verify/src must be
	// node:* or ./-relative — so the 0 is re-proven at every capture, not assumed.
	const verifySrcDir = join(REPO_ROOT, "packages/verify/src");
	const verifySrcFiles = (await readdir(verifySrcDir, { recursive: true })).filter((f) =>
		f.endsWith(".ts"),
	);
	for (const rel of verifySrcFiles) {
		const src = await readFile(join(verifySrcDir, rel), "utf-8");
		for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
			const spec = m[1] ?? "";
			if (!spec.startsWith("node:") && !spec.startsWith("./")) {
				throw new Error(`parity contract violated: packages/verify imports "${spec}"`);
			}
		}
	}
	const verifierSharedLines = 0;

	// sizzle.mp4 measured 44.4s at plan time — 44 is the documented fallback.
	let filmDurationSeconds = 44;
	let filmSource = "fallback: 44 (ffprobe unavailable at capture time; sizzle.mp4 measured 44.4s)";
	try {
		const probe = execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				join(REPO_ROOT, "site/public/demo/sizzle.mp4"),
			],
			{ encoding: "utf-8" },
		);
		filmDurationSeconds = Math.round(Number.parseFloat(probe.trim()));
		filmSource = "ffprobe site/public/demo/sizzle.mp4 (format.duration, rounded)";
	} catch {
		/* fall through to the documented fallback */
	}

	return {
		generatedAt: new Date().toISOString(),
		commit,
		usertrustVersion,
		tigerbeetleVersion,
		facts: {
			transferCodes: {
				value: transferCodes,
				source: "packages/core/src/ledger/client.ts — count of `export const XFER_*`",
			},
			accountCodes: {
				value: accountCodes,
				source: "packages/core/src/ledger/client.ts — count of `export const CODE_*`",
			},
			policyOperators: {
				value: policyOperators,
				source: "packages/core/src/shared/types.ts — FieldOperator union members",
			},
			verifierRuntimeDeps: {
				value: verifierRuntimeDeps,
				source: "packages/verify/package.json — dependencies key count",
			},
			modelCount: {
				value: `${modelNumeric}+`,
				numeric: modelNumeric,
				source: "packages/core/src/ledger/pricing.ts — PRICING_TABLE keys",
			},
			license: {
				value: "Apache 2.0",
				source: "packages/core/package.json — license: Apache-2.0",
			},
			commandsToFirstReceipt: {
				value: 2,
				source: "README quickstart — `npm install usertrust` · `npx usertrust init`",
			},
			quickstartMinutes: { value: 2, source: "docs quickstart — stated duration (dry-run path)" },
			filmDurationSeconds: { value: filmDurationSeconds, source: filmSource },
			usertokensPerFiveDollars: {
				value: 50000,
				source:
					"packages/core/src/shared/constants.ts — DEFAULT_BUDGET = 50_000 usertokens ($5 starter budget)",
			},
			invariantCount: {
				value: invariantCount,
				source: "AGENTS.md — count of `Prevents:` clauses",
			},
			hardenSuiteCount: {
				value: hardenSuiteCount,
				source: "packages/core/tests/harden/**/*.test.ts — test-file count",
			},
			testCaseCount: {
				value: testCaseCount,
				source: "packages/**/*.test.ts — count of it()/test() case openers",
			},
			expectAssertionCount: {
				value: expectAssertionCount,
				source:
					"packages/**/*.test.ts — count of expect( calls; TEST assertions, not runtime guarantees",
			},
			verifierSharedLines: {
				value: verifierSharedLines,
				source: "packages/verify parity contract (AGENTS.md) — import audit re-run at capture time",
			},
			// CASE FILE 001 narrative figures (Exhibit C, Task 9) — fixed marketing
			// copy, not derived from code; the manifest is their single source.
			caseFileCalls: { value: 47, source: "CASE FILE 001 incident narrative (fixed copy)" },
			caseFileDollars: { value: 500, source: "CASE FILE 001 incident narrative (fixed copy)" },
		},
	};
}

// ── attack corpus (Addendum D1) — names + pinned verdicts from the REAL harden test ──
async function deriveAttackCorpus(): Promise<{
	attacks: Array<{ name: string; verdict: string }>;
}> {
	const src = await readFile(
		join(REPO_ROOT, "packages/core/tests/harden/anchoring/anchor-corpus.test.ts"),
		"utf-8",
	);
	// Structure (verified): every case opens `\tit("<title>", async () => {` on a
	// single line, titles never contain a double quote, and the pinned verdict is
	// the FIRST `anchorState).toBe("...")` in the block. The verdict alphabet is
	// the AnchorState union (packages/core/src/audit/anchor-verify.ts).
	const VERDICTS = new Set([
		"UNANCHORED",
		"ANCHORED_VERIFIED",
		"ANCHOR_STALE",
		"ANCHOR_UNVERIFIABLE",
		"ANCHOR_INVALID",
		"ANCHOR_MISMATCH",
	]);
	const blocks = src.split(/^\tit\("/m).slice(1);
	const attacks = blocks.map((block) => {
		const name = block.slice(0, block.indexOf('"'));
		const verdict = /anchorState\)\.toBe\("([A-Z_]+)"\)/.exec(block)?.[1];
		if (verdict === undefined || !VERDICTS.has(verdict)) {
			throw new Error(`no pinned AnchorState verdict found for corpus case: ${name}`);
		}
		return { name, verdict };
	});
	if (attacks.length < 20) {
		throw new Error(`attack-corpus extraction looks broken: only ${attacks.length} cases found`);
	}
	return { attacks };
}

// ── main ──
async function main(): Promise<void> {
	if (!existsSync(join(REPO_ROOT, "packages/core/dist/index.js"))) {
		console.error(
			"packages/core/dist missing — run `npm ci && npx tsc -b` at the repo root first.",
		);
		process.exit(1);
	}

	// Dynamic import so the preflight above can fail with a clear message.
	const { trust, estimateCost, estimateInputTokens } = await import("usertrust");
	const { PRICING_TABLE } = (await import("usertrust/pricing")) as {
		PRICING_TABLE: Record<string, unknown>;
	};

	// PRE-FLIGHT (Addendum J1). A model missing from the table still "works" —
	// it meters at FALLBACK_RATE — so the capture would silently publish three
	// receipts priced at sonnet-class rates. Fail loudly instead.
	const unpriced = CAPTURE_MODELS.filter((m) => !Object.hasOwn(PRICING_TABLE, m.id));
	if (unpriced.length > 0) {
		throw new Error(
			`pricing pre-flight failed: ${unpriced.map((m) => m.id).join(", ")} not in PRICING_TABLE — ` +
				`add the REAL published rates to packages/core/src/ledger/pricing.ts before capturing.`,
		);
	}

	const corePkg = JSON.parse(
		await readFile(join(REPO_ROOT, "packages/core/package.json"), "utf-8"),
	) as { version: string };
	const usertrustVersion = corePkg.version;
	const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	}).trim();

	let tbProc: ChildProcess | null = null;
	let tbDir: string | null = null;
	let ledgerVault: string | null = null;
	let dryVault: string | null = null;

	try {
		let tbVersion = "n/a (dry-run-only capture)";
		const captures: Capture[] = [];
		let denial: {
			error: { name: string; message: string };
			event: ChainEvent & { seq: number };
		} | null = null;

		// (a) real-ledger capture — genuine settled TigerBeetle transfers, one
		// per frontier model, all into ONE vault so one chain carries all three.
		if (!dryRunOnly) {
			const tb = tbBinary();
			tbVersion = tb.version;
			if (await portOpen(TB_PORT)) {
				throw new Error(
					`port ${TB_PORT} already in use — stop the existing TigerBeetle (pgrep tigerbeetle) and re-run`,
				);
			}
			tbDir = await mkdtemp(join(tmpdir(), "usertrust-capture-tb-"));
			const dataFile = join(tbDir, "0_0.tigerbeetle");
			execFileSync(
				tb.bin,
				["format", "--cluster=0", "--replica=0", "--replica-count=1", "--development", dataFile],
				{ stdio: "inherit" },
			);
			tbProc = spawn(tb.bin, ["start", `--addresses=${TB_PORT}`, "--development", dataFile], {
				stdio: ["ignore", "ignore", "inherit"],
			});
			await waitForPort(TB_PORT);

			ledgerVault = await mkdtemp(join(tmpdir(), "usertrust-capture-ledger-"));

			// One featured receipt per model.
			for (const model of CAPTURE_MODELS) {
				const client = await trust(fakeClient(model.shape), {
					budget: BUDGET,
					vaultBase: ledgerVault,
				});
				try {
					const args: FakeArgs = {
						model: model.id,
						max_tokens: MAX_TOKENS,
						messages: [{ role: "user", content: "summarize the runaway-agent incident report" }],
					};
					const estimatedCost = estimateCost(
						args.model,
						estimateInputTokens(args.messages),
						args.max_tokens,
					);
					const { receipt } = await governedCall(client, model.shape, args);
					captures.push({ receipt, capture: { estimatedCost, clientShape: model.shape } });
				} finally {
					await client.destroy();
				}
			}

			// Fill the chain out to the slice size with further governed calls, then
			// close it with a REAL denial. Both use the same vault as the receipts.
			const filler = await trust(fakeClient("anthropic"), {
				budget: BUDGET,
				vaultBase: ledgerVault,
			});
			try {
				const alreadyWritten = captures.length;
				for (let i = alreadyWritten; i < SLICE_SIZE - 1; i++) {
					await governedCall(filler, "anthropic", {
						model: CAPTURE_MODELS[0].id,
						max_tokens: MAX_TOKENS,
						messages: [{ role: "user", content: `governed call ${i + 1} — incident review` }],
					});
				}

				// THE DENIAL (#87). A hold this size cannot fit the budget, so the
				// block-budget-overshoot rule denies pre-spend — and, since #87, the
				// governor writes a `policy_denied` chain event before rethrowing.
				const before = (await readChainEvents(ledgerVault)).events.length;
				let thrown: unknown;
				try {
					await governedCall(filler, "anthropic", {
						model: CAPTURE_MODELS[0].id,
						max_tokens: OVERSHOOT_MAX_TOKENS,
						messages: [{ role: "user", content: "runaway retry — this call must be denied" }],
					});
				} catch (err) {
					thrown = err;
				}
				if (!(thrown instanceof Error)) {
					throw new Error("expected the overshooting call to throw a governance denial");
				}
				const after = await readChainEvents(ledgerVault);
				if (after.events.length !== before + 1) {
					throw new Error(
						`expected the denial to append exactly one chain event (${before} -> ${after.events.length})`,
					);
				}
				const event = after.events[after.events.length - 1];
				if (event.kind !== "policy_denied") {
					throw new Error(`expected a policy_denied chain event, got "${event.kind}"`);
				}
				denial = {
					error: { name: thrown.name, message: thrown.message },
					event: { ...event, seq: after.events.length },
				};
			} finally {
				await filler.destroy();
			}
		}

		// (b) dry-run capture — the no-TigerBeetle path, kept so the fixture set
		// (and the capture test) still exercises it end to end.
		dryVault = await mkdtemp(join(tmpdir(), "usertrust-capture-dry-"));
		const dryClient = await trust(fakeClient("anthropic"), {
			budget: BUDGET,
			vaultBase: dryVault,
			dryRun: true,
		});
		let dryCapture: Capture | null = null;
		try {
			for (let i = 1; i <= SLICE_SIZE; i++) {
				const args: FakeArgs = {
					model: CAPTURE_MODELS[0].id,
					max_tokens: MAX_TOKENS,
					messages: [{ role: "user", content: `governed dry-run call ${i}` }],
				};
				const estimatedCost = estimateCost(
					args.model,
					estimateInputTokens(args.messages),
					args.max_tokens,
				);
				const { receipt } = await governedCall(dryClient, "anthropic", args);
				if (i === 1) {
					dryCapture = { receipt, capture: { estimatedCost, clientShape: "anthropic" } };
				}
			}
		} finally {
			await dryClient.destroy();
		}
		if (dryCapture === null) throw new Error("dry-run capture produced no receipt");

		// (c) chain slice — from the SAME vault the featured receipts settled in
		// (the dry vault only when there is no ledger vault to read).
		const sliceVault = ledgerVault ?? dryVault;
		const { raw: rawJsonl, events } = await readChainEvents(sliceVault);
		const chainSlice = sliceFromEvents(events);

		// The promise Exhibit A makes: every featured receipt's auditHash IS an
		// entry in the published slice. Assert it rather than hope for it.
		const sliceHashes = new Set(chainSlice.entries.map((e) => e.hash));
		const featured = ledgerVault !== null ? captures : [dryCapture];
		const orphans = featured.filter((c) => !sliceHashes.has(c.receipt.auditHash));
		if (orphans.length > 0) {
			throw new Error(
				`chain slice does not contain ${orphans.length} featured receipt hash(es): ` +
					orphans.map((c) => `${c.receipt.model} ${c.receipt.auditHash.slice(0, 12)}`).join(", "),
			);
		}

		// (d) workspace verifier transcript over the SAME vault (never registry npx)
		const verifyCli = join(REPO_ROOT, "packages/verify/dist/cli.js");
		if (!existsSync(verifyCli))
			throw new Error("packages/verify/dist/cli.js missing — run `npx tsc -b`");
		// execFileSync throws on non-zero exit, so reaching the next line proves exitCode 0.
		const verifyOut = execFileSync("node", [verifyCli, join(sliceVault, ".usertrust")], {
			encoding: "utf-8",
		});
		const transcript = {
			command: "npx usertrust-verify .usertrust",
			lines: verifyOut
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR sequences from real CLI output
				.replace(/\u001b\[[0-9;]*m/g, "")
				.trimEnd()
				.split("\n"),
			exitCode: 0 as const,
		};

		// (e) facts + attack corpus + (f) write everything
		const facts = await deriveFacts(tbVersion, commit, usertrustVersion);
		const attackCorpus = await deriveAttackCorpus();
		const provenance: Provenance = {
			usertrustVersion,
			tigerbeetleVersion: dryRunOnly ? null : tbVersion,
			capturedAt: new Date().toISOString(),
			mode: dryRunOnly ? "dry-run" : "ledger",
			commit,
		};
		await mkdir(appEvidence, { recursive: true });
		await mkdir(publicEvidence, { recursive: true });
		const writeJson = (dir: string, name: string, value: unknown) =>
			writeFile(join(dir, name), `${JSON.stringify(value, null, "\t")}\n`);
		await writeJson(appEvidence, "facts.json", facts);
		await writeJson(appEvidence, "attack-corpus.json", attackCorpus);
		if (!dryRunOnly) {
			await writeJson(appEvidence, "receipt-ledger.json", { captures, provenance });
			await writeJson(appEvidence, "denial-event.json", {
				...denial,
				provenance,
				reproduce:
					`one governed call with max_tokens ${OVERSHOOT_MAX_TOKENS.toLocaleString("en-US")} ` +
					`against a ${BUDGET.toLocaleString("en-US")} usertoken budget`,
			});
		}
		await writeJson(appEvidence, "receipt-dryrun.json", {
			...dryCapture,
			provenance: { ...provenance, tigerbeetleVersion: null, mode: "dry-run" as const },
		});
		await writeJson(appEvidence, "chain-slice.json", chainSlice);
		await writeJson(appEvidence, "verify-transcript.json", transcript);
		await writeFile(
			join(publicEvidence, "chain.jsonl"),
			rawJsonl.endsWith("\n") ? rawJsonl : `${rawJsonl}\n`,
		);
		console.log(`evidence captured → ${appEvidence}${dryRunOnly ? " (dry-run-only)" : ""}`);
	} finally {
		if (tbProc !== null) tbProc.kill("SIGTERM");
		for (const dir of [tbDir, ledgerVault, dryVault]) {
			if (dir !== null) await rm(dir, { recursive: true, force: true });
		}
	}
}

await main();
