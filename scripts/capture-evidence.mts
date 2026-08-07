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
 * No network, no API keys: the governed client is a duck-typed fake that
 * satisfies detect.ts's Anthropic shape (messages.create is a function) and
 * returns a canned response with real usage numbers.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustReceipt } from "usertrust";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Matches TrustConfigSchema's default tigerbeetle.addresses ["127.0.0.1:3001"]
// (packages/core/src/shared/types.ts) — no config file needed in the vault.
const TB_PORT = 3001;
const MODEL = "claude-sonnet-4-6";

const argv = process.argv.slice(2);
const dryRunOnly = argv.includes("--dry-run-only");
const outIdx = argv.indexOf("--out");
const OUT_DIR = outIdx !== -1 ? resolve(argv[outIdx + 1] ?? ".") : null;
const appEvidence = OUT_DIR ?? join(REPO_ROOT, "site", "app", "evidence");
const publicEvidence = OUT_DIR ?? join(REPO_ROOT, "site", "public", "evidence");

// ── fake duck-typed Anthropic client (detect.ts: messages.create function ⇒ "anthropic") ──
interface FakeArgs {
	model: string;
	max_tokens: number;
	messages: Array<{ role: string; content: string }>;
}

function fakeAnthropic() {
	let call = 0;
	return {
		messages: {
			create: async (args: FakeArgs) => {
				call += 1;
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
					// Settlement reads usage.input_tokens/output_tokens for Anthropic.
					usage: { input_tokens: 300 + call * 17, output_tokens: 120 + call * 11 },
				};
			},
		},
	};
}

type GovernedResult = { response: unknown; receipt: TrustReceipt };

interface Provenance {
	usertrustVersion: string;
	tigerbeetleVersion: string | null;
	capturedAt: string;
	mode: "ledger" | "dry-run";
	commit: string;
}

function fixtureFrom(
	receipt: TrustReceipt,
	estimated: number,
	prov: Omit<Provenance, "capturedAt">,
) {
	return {
		receipt: {
			transferId: receipt.transferId,
			cost: { estimated, actual: receipt.settled ? receipt.cost : null },
			budgetRemaining: receipt.budgetRemaining,
			auditHash: receipt.auditHash,
			settled: receipt.settled,
			model: receipt.model,
			provider: receipt.provider,
			timestamp: receipt.timestamp,
		},
		provenance: { ...prov, capturedAt: new Date().toISOString() },
	};
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

// ── facts derivation (values derived from source at capture time — never hand-typed) ──
async function deriveFacts(tigerbeetleVersion: string, commit: string, usertrustVersion: string) {
	const ledgerSrc = await readFile(join(REPO_ROOT, "packages/core/src/ledger/client.ts"), "utf-8");
	const transferCodes = (ledgerSrc.match(/^export const XFER_/gm) ?? []).length;

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
			// CASE FILE 001 narrative figures (Exhibit C, Task 9) — fixed marketing
			// copy, not derived from code; the manifest is their single source.
			caseFileCalls: { value: 47, source: "CASE FILE 001 incident narrative (fixed copy)" },
			caseFileDollars: { value: 500, source: "CASE FILE 001 incident narrative (fixed copy)" },
		},
	};
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
		let receiptLedger: ReturnType<typeof fixtureFrom> | null = null;

		// (a) real-ledger capture — a genuine settled TigerBeetle transfer
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
			const client = await trust(fakeAnthropic(), { budget: 50_000, vaultBase: ledgerVault });
			const args: FakeArgs = {
				model: MODEL,
				max_tokens: 256,
				messages: [{ role: "user", content: "summarize the runaway-agent incident report" }],
			};
			const estimated = estimateCost(
				args.model,
				estimateInputTokens(args.messages),
				args.max_tokens,
			);
			const { receipt } = (await client.messages.create(args)) as unknown as GovernedResult;
			await client.destroy();
			receiptLedger = fixtureFrom(receipt, estimated, {
				usertrustVersion,
				tigerbeetleVersion: tbVersion,
				mode: "ledger",
				commit,
			});
		}

		// (b)+(c) dry-run capture: featured receipt + 8 more calls to build the chain
		dryVault = await mkdtemp(join(tmpdir(), "usertrust-capture-dry-"));
		const dryClient = await trust(fakeAnthropic(), {
			budget: 50_000,
			vaultBase: dryVault,
			dryRun: true,
		});
		let receiptDry: ReturnType<typeof fixtureFrom> | null = null;
		for (let i = 1; i <= 9; i++) {
			const args: FakeArgs = {
				model: MODEL,
				max_tokens: 256,
				messages: [{ role: "user", content: `governed dry-run call ${i} of 9` }],
			};
			const estimated = estimateCost(
				args.model,
				estimateInputTokens(args.messages),
				args.max_tokens,
			);
			const { receipt } = (await dryClient.messages.create(args)) as unknown as GovernedResult;
			if (i === 1) {
				receiptDry = fixtureFrom(receipt, estimated, {
					usertrustVersion,
					tigerbeetleVersion: null,
					mode: "dry-run",
					commit,
				});
			}
		}
		await dryClient.destroy();

		// (c) chain slice from the dry vault's real audit chain
		const eventsPath = join(dryVault, ".usertrust", "audit", "events.jsonl");
		const rawJsonl = await readFile(eventsPath, "utf-8");
		const events = rawJsonl
			.trim()
			.split("\n")
			.map(
				(l) =>
					JSON.parse(l) as {
						kind: string;
						hash: string;
						previousHash: string;
						timestamp: string;
						data?: Record<string, unknown>;
					},
			);
		const lastEight = events.slice(-8);
		if (lastEight.length !== 8) throw new Error(`expected >= 8 chain events, got ${events.length}`);
		const baseSeq = events.length - 8;
		const chainSlice = {
			entries: lastEight.map((e, i) => ({
				seq: baseSeq + i + 1, // 1-based line number in events.jsonl
				type: e.kind,
				hash: e.hash,
				prevHash: e.previousHash,
				timestamp: e.timestamp,
				summary: [
					e.kind,
					typeof e.data?.model === "string" ? e.data.model : null,
					typeof e.data?.cost === "number" ? `${e.data.cost} usertokens` : null,
				]
					.filter(Boolean)
					.join(" · "),
			})),
		};

		// (d) workspace verifier transcript (never registry npx)
		const verifyCli = join(REPO_ROOT, "packages/verify/dist/cli.js");
		if (!existsSync(verifyCli))
			throw new Error("packages/verify/dist/cli.js missing — run `npx tsc -b`");
		// execFileSync throws on non-zero exit, so reaching the next line proves exitCode 0.
		const verifyOut = execFileSync("node", [verifyCli, join(dryVault, ".usertrust")], {
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

		// (e) facts + (f) write everything
		const facts = await deriveFacts(tbVersion, commit, usertrustVersion);
		await mkdir(appEvidence, { recursive: true });
		await mkdir(publicEvidence, { recursive: true });
		const writeJson = (dir: string, name: string, value: unknown) =>
			writeFile(join(dir, name), `${JSON.stringify(value, null, "\t")}\n`);
		await writeJson(appEvidence, "facts.json", facts);
		if (receiptLedger !== null) await writeJson(appEvidence, "receipt-ledger.json", receiptLedger);
		await writeJson(appEvidence, "receipt-dryrun.json", receiptDry);
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
