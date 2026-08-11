/**
 * fleet-collector.mts — the fleet-ledger collector CLI (Task 5).
 *
 *   npm run fleet:collect                # full run: scan → pre-flight → replay → verify → rollup
 *   npm run fleet:collect -- --dry-parse # parse + report only (no journal/vault writes)
 *   npm run fleet:collect -- --publish   # full run + publish gate + copy artifacts to site/public/fleet/
 *
 * PIPELINE (spec Component 1/2): allowlisted `~/.claude/projects/` dirs →
 * parse (allowlist extraction, mtime quiescence) → global dedupe by
 * messageId → PRE-FLIGHT → month routing → `replayMonth` (WAL journal +
 * dry-run mint, Task 4) → workspace `usertrust-verify` per touched vault →
 * rollup (`fleet-summary.json`) → optional publish behind the gate.
 *
 * PRE-FLIGHT (r2/C1; capture-evidence.mts J1 precedent): before ANY vault
 * write, abort listing offenders if a new record's model resolves to the
 * fallback sentinel — the reference-equality probe
 * `getModelRates(model) === FALLBACK_RATE`, which unlike a key lookup also
 * honors the table's prefix matching — or its `speed` is not "standard"
 * (fast-mode rates are not in the table). This guarantees no fallback-priced
 * or wrong-modifier receipt can ever exist in a fleet vault.
 *
 * PUBLISH GATE (spec Component 2): journal clean (no INTENT without DONE) +
 * every DONE auditHash present in the month chain + `usertrust-verify` exit 0
 * over the published month — refusing otherwise. The verify transcript
 * published beside the chain is the transcript of THAT gate run.
 *
 * The PROJECT_DIRS allowlist is machine-specific BY DESIGN (Phase 1 meters
 * exactly one machine: the one that builds usertrust). The scan report
 * publishes dirs scanned AND usertrust-looking candidate dirs skipped, so
 * allowlist gaps are visible rather than silent (r1/M4).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_RATE, getModelRates } from "usertrust/pricing";
import { type Journal, openJournal } from "./fleet/journal.mts";
import { type FleetRecord, parseTranscriptFile } from "./fleet/parse.mts";
import { replayMonth } from "./fleet/replay.mts";
import {
	buildFleetSummary,
	type FleetStoreLine,
	readReceiptStore,
	renderFleetSummary,
} from "./fleet/rollup.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET_DIR = join(REPO_ROOT, ".usertrust-fleet");
const VAULT_ROOT = join(FLEET_DIR, "vault");
const SITE_FLEET_DIR = join(REPO_ROOT, "site", "public", "fleet");
export const VERIFY_CLI = join(REPO_ROOT, "packages", "verify", "dist", "cli.js");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * The real filesystem roots whose Claude Code sessions get metered: the main
 * repo checkout and the WebstormProjects clone (each with its `.worktrees/`
 * variants). Phase 1 is single-machine; other machines are a ledgered
 * follow-up, and anything usertrust-shaped OUTSIDE this list is counted in
 * `candidateDirsSkipped`, never silently ignored.
 */
const PROJECT_ROOTS: readonly string[] = [
	join(homedir(), "usertrust"),
	join(homedir(), "WebstormProjects", "usertrust"),
];

// ── ~/.claude/projects name-mangling ──

/** Newer Claude Code mangling: slash → dash, dots kept. */
const mangleKeepDots = (path: string): string => path.replaceAll("/", "-");
/** Older mangling: every non-alphanumeric → dash. */
const mangleAll = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Compute the allowlisted `~/.claude/projects/` directory names from the real
 * paths. Both historical manglings are covered (both exist on disk today),
 * and worktrees match by PREFIX so transcripts of since-deleted worktrees
 * still ingest — the work happened; the ledger does not forget it.
 */
export function projectDirAllowlist(roots: readonly string[]): {
	exact: Set<string>;
	prefixes: string[];
} {
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const root of roots) {
		exact.add(mangleKeepDots(root));
		exact.add(mangleAll(root));
		const worktrees = `${root}/.worktrees/`;
		for (const prefix of new Set([mangleKeepDots(worktrees), mangleAll(worktrees)])) {
			prefixes.push(prefix);
		}
	}
	return { exact, prefixes };
}

// ── scan ──

export interface ScanResult {
	records: FleetRecord[];
	dirsScanned: number;
	candidateDirsSkipped: number;
	deferredIds: number;
	filesParsed: number;
}

/**
 * Scan every allowlisted project dir RECURSIVELY for `*.jsonl` transcripts —
 * subagent (sidechain) transcripts live in nested `<session>/subagents/`
 * dirs, and the corpus is ~87% sidechain fan-out (r1/M3), so a flat glob
 * would miss most of the fleet. Non-transcript JSONL files are harmless: the
 * parser's allowlist admits only assistant lines with a usage block.
 */
export function scanTranscripts(
	projectsDir: string,
	allow: { exact: Set<string>; prefixes: string[] },
	nowMs: number,
): ScanResult {
	const result: ScanResult = {
		records: [],
		dirsScanned: 0,
		candidateDirsSkipped: 0,
		deferredIds: 0,
		filesParsed: 0,
	};
	for (const entry of readdirSync(projectsDir, { withFileTypes: true }).sort((a, b) =>
		a.name < b.name ? -1 : 1,
	)) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const allowed = allow.exact.has(name) || allow.prefixes.some((p) => name.startsWith(p));
		if (!allowed) {
			// A dir that LOOKS like usertrust work but is not allowlisted is the
			// honest gap in "completeness is not claimed" — count it, loudly.
			if (name.toLowerCase().includes("usertrust")) result.candidateDirsSkipped += 1;
			continue;
		}
		result.dirsScanned += 1;
		const base = join(projectsDir, name);
		const files = readdirSync(base, { recursive: true, encoding: "utf8" })
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
		for (const file of files) {
			const { records, deferred } = parseTranscriptFile(join(base, file), nowMs);
			result.records.push(...records);
			result.deferredIds += deferred;
			result.filesParsed += 1;
		}
	}
	return result;
}

/**
 * Global dedupe by messageId, latest `occurredAt` wins (continued sessions
 * re-emit earlier messages into new transcript files; per-file dedupe alone
 * would double-mint them). Output is occurredAt-sorted — `replayMonth`
 * expects pre-sorted records.
 */
export function dedupeRecords(records: FleetRecord[]): FleetRecord[] {
	const compare = (a: FleetRecord, b: FleetRecord): number => {
		if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
		if (a.messageId === b.messageId) return 0;
		return a.messageId < b.messageId ? -1 : 1;
	};
	const byId = new Map<string, FleetRecord>();
	for (const record of [...records].sort(compare)) byId.set(record.messageId, record);
	return [...byId.values()].sort(compare);
}

// ── pre-flight ──

/**
 * Fail-loud pre-flight over records about to mint (r2/C1). Detection matches
 * `capture-evidence.mts`'s J1 pre-flight in intent — no silently
 * fallback-priced receipt — via the reference-equality probe against the
 * fallback sentinel: `getModelRates` returns the FALLBACK_RATE object itself
 * iff no table row (exact or prefix) matched.
 */
export function preFlight(records: FleetRecord[]): void {
	const offenders = records
		.map((record) => {
			const reasons: string[] = [];
			if (getModelRates(record.model) === FALLBACK_RATE) {
				reasons.push(`model "${record.model}" resolves to FALLBACK_RATE (not in PRICING_TABLE)`);
			}
			if (record.speed !== "standard") {
				reasons.push(
					`speed "${record.speed}" is not "standard" (modifier rates are not in the table)`,
				);
			}
			return { record, reasons };
		})
		.filter(({ reasons }) => reasons.length > 0);
	if (offenders.length === 0) return;
	const lines = offenders.map(
		({ record, reasons }) => `  ${record.messageId} (${record.occurredAt}): ${reasons.join("; ")}`,
	);
	throw new Error(
		`fleet pre-flight failed for ${offenders.length} record(s) — aborting before any vault write:\n` +
			`${lines.join("\n")}\n` +
			"add the REAL published rates to packages/core/src/ledger/pricing.ts (never guess) or " +
			"resolve the speed modifier before collecting.",
	);
}

// ── collect (month routing + replay) ──

/**
 * Route deduped records to their billing-month vaults and replay them.
 * Pre-flight runs over every UNSEEN record across ALL months BEFORE the
 * first `replayMonth` call — one offender anywhere aborts the whole run
 * with zero vault writes.
 */
export async function collectRecords(opts: {
	records: FleetRecord[];
	fleetDir: string;
	vaultRoot: string;
}): Promise<{ months: string[]; minted: number; recovered: number }> {
	const deduped = dedupeRecords(opts.records);
	const byMonth = new Map<string, FleetRecord[]>();
	for (const record of deduped) {
		const month = record.occurredAt.slice(0, 7);
		if (!/^\d{4}-\d{2}$/.test(month)) {
			throw new Error(
				`fleet collect: record ${record.messageId} has unusable occurredAt ` +
					`${JSON.stringify(record.occurredAt)} — cannot route to a billing month`,
			);
		}
		const bucket = byMonth.get(month);
		if (bucket) bucket.push(record);
		else byMonth.set(month, [record]);
	}

	const months = [...byMonth.keys()].sort();
	const journals = new Map<string, Journal>();
	const unseen: FleetRecord[] = [];
	for (const month of months) {
		const journal = openJournal(opts.fleetDir, month);
		journals.set(month, journal);
		const seen = journal.seen();
		for (const record of byMonth.get(month) ?? []) {
			if (!seen.has(record.messageId)) unseen.push(record);
		}
	}

	preFlight(unseen); // throws BEFORE any vault write

	let minted = 0;
	let recovered = 0;
	for (const month of months) {
		const journal = journals.get(month);
		if (!journal) throw new Error("fleet collect: unreachable — journal opened above");
		const result = await replayMonth({
			month,
			records: byMonth.get(month) ?? [],
			vaultRoot: opts.vaultRoot,
			journal,
			receiptStorePath: join(opts.fleetDir, "receipts", `${month}.jsonl`),
		});
		minted += result.minted;
		recovered += result.recovered;
	}
	return { months, minted, recovered };
}

// ── chain reading (membership + published chain.jsonl) ──

interface OrderedChain {
	/** Raw event lines, ordered by the persisted global `sequence`. */
	rawLines: string[];
	hashes: Set<string>;
}

/**
 * Read every audit segment of a month vault, ordered by the persisted global
 * `sequence` (the same ordering `verifyVault` walks). Only an unterminated,
 * unparseable FINAL line of a segment is tolerated (torn tail); anything
 * else malformed throws.
 */
function readOrderedChain(vaultBase: string): OrderedChain {
	const auditDir = join(vaultBase, ".usertrust", "audit");
	const chain: OrderedChain = { rawLines: [], hashes: new Set() };
	if (!existsSync(auditDir)) return chain;
	const parsed: { sequence: number; raw: string; hash: string }[] = [];
	for (const file of readdirSync(auditDir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(auditDir, file);
		const raw = readFileSync(path, "utf-8");
		const lines = raw.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = (lines[i] ?? "").trim();
			if (line === "") continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				const isFinalLine = i === lines.length - 1 && !raw.endsWith("\n");
				if (isFinalLine) continue; // torn tail: not a committed event
				throw new Error(`fleet collect: unparseable audit line at ${path}:${i + 1}`);
			}
			const { hash, sequence } = event as { hash?: unknown; sequence?: unknown };
			if (typeof hash !== "string" || typeof sequence !== "number") {
				throw new Error(`fleet collect: audit event without hash/sequence at ${path}:${i + 1}`);
			}
			parsed.push({ sequence, raw: line, hash });
		}
	}
	parsed.sort((a, b) => a.sequence - b.sequence);
	for (const event of parsed) {
		chain.rawLines.push(event.raw);
		chain.hashes.add(event.hash);
	}
	return chain;
}

/** DONE auditHashes read RAW from the WAL file (the journal API hides them). */
function readDoneHashes(journalPath: string): { messageId: string; auditHash: string }[] {
	const done: { messageId: string; auditHash: string }[] = [];
	for (const line of readFileSync(journalPath, "utf-8").split("\n")) {
		if (line.trim() === "") continue;
		const entry = JSON.parse(line) as { type?: unknown; messageId?: unknown; auditHash?: unknown };
		if (entry.type === "DONE" && typeof entry.messageId === "string") {
			done.push({ messageId: entry.messageId, auditHash: String(entry.auditHash) });
		}
	}
	return done;
}

// ── verify + publish gate ──

interface VerifyTranscript {
	command: string;
	lines: string[];
	exitCode: 0;
}

/** Run the workspace verifier over a month vault; throw on non-zero exit. */
function runVerify(vaultBase: string, verifyCli: string, month: string): VerifyTranscript {
	if (!existsSync(verifyCli)) {
		throw new Error(`${verifyCli} missing — run \`npx tsc -b packages/verify\` first`);
	}
	let out: string;
	try {
		out = execFileSync("node", [verifyCli, join(vaultBase, ".usertrust")], { encoding: "utf-8" });
	} catch (error) {
		const failed = error as { status?: number | null; stdout?: string; stderr?: string };
		throw new Error(
			`publish gate: usertrust-verify exited ${failed.status ?? "?"} for ${month}:\n` +
				`${[failed.stdout, failed.stderr].filter(Boolean).join("\n").trim()}`,
		);
	}
	return {
		command: "npx usertrust-verify .usertrust",
		lines: out
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR sequences from real CLI output
			.replace(/\[[0-9;]*m/g, "")
			.trimEnd()
			.split("\n"),
		exitCode: 0,
	};
}

/**
 * The publish gate (spec Component 2). Refuses unless, in order:
 *  1. the month journal exists and has NO pending INTENT (a crash between
 *     INTENT and DONE means the vault and the WAL may disagree — recover
 *     first by re-running the collector);
 *  2. every DONE auditHash is literally an event in the month chain
 *     (capture-evidence membership precedent — the WAL may never claim a
 *     mint the chain cannot show);
 *  3. the workspace `usertrust-verify` exits 0 over the month vault.
 * Returns the verify transcript of gate run — the one that gets published.
 */
export function assertPublishable(opts: {
	fleetDir: string;
	month: string;
	vaultRoot: string;
	verifyCli: string;
}): { transcript: VerifyTranscript } {
	const { fleetDir, month, vaultRoot, verifyCli } = opts;
	const journalPath = join(fleetDir, "journal", `${month}.jsonl`);
	if (!existsSync(journalPath)) {
		throw new Error(`publish gate: no journal for ${month} — nothing has been collected`);
	}

	// 1. Journal clean. (openJournal also repairs/reports a torn tail first.)
	const journal = openJournal(fleetDir, month);
	const pending = journal.pendingIntents();
	if (pending.length > 0) {
		throw new Error(
			`publish gate: journal has ${pending.length} pending INTENT(s) without DONE — ` +
				`re-run the collector to recover before publishing: ` +
				pending.map((p) => p.messageId).join(", "),
		);
	}

	// 2. DONE-hash chain membership.
	const vaultBase = join(vaultRoot, month);
	const chain = readOrderedChain(vaultBase);
	const missing = readDoneHashes(journalPath).filter((d) => !chain.hashes.has(d.auditHash));
	if (missing.length > 0) {
		throw new Error(
			`publish gate: ${missing.length} DONE auditHash(es) not found in the ${month} chain: ` +
				missing.map((d) => `${d.messageId} (${d.auditHash.slice(0, 12)}…)`).join(", "),
		);
	}

	// 3. Verifier exit 0.
	return { transcript: runVerify(vaultBase, verifyCli, month) };
}

// ── publish ──

function publishArtifacts(opts: {
	fleetDir: string;
	month: string;
	vaultRoot: string;
	verifyCli: string;
	siteFleetDir: string;
	summaryPath: string;
}): void {
	const { transcript } = assertPublishable(opts);
	const chain = readOrderedChain(join(opts.vaultRoot, opts.month));
	mkdirSync(opts.siteFleetDir, { recursive: true });
	writeFileSync(join(opts.siteFleetDir, "chain.jsonl"), `${chain.rawLines.join("\n")}\n`);
	writeFileSync(
		join(opts.siteFleetDir, "fleet-summary.json"),
		readFileSync(opts.summaryPath, "utf-8"),
	);
	writeFileSync(
		join(opts.siteFleetDir, "verify-transcript.json"),
		`${JSON.stringify(transcript, null, "\t")}\n`,
	);
	console.log(
		`published ${opts.month}: chain.jsonl (${chain.rawLines.length} events), ` +
			`fleet-summary.json, verify-transcript.json → ${opts.siteFleetDir}`,
	);
}

// ── report helpers ──

function tally(records: FleetRecord[], key: (r: FleetRecord) => string): [string, number][] {
	const counts = new Map<string, number>();
	for (const record of records) {
		const k = key(record);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printScanReport(scan: ScanResult, deduped: FleetRecord[]): void {
	console.log("── fleet scan report ──");
	console.log(`dirs scanned:            ${scan.dirsScanned}`);
	console.log(`candidate dirs skipped:  ${scan.candidateDirsSkipped}`);
	console.log(`transcript files parsed: ${scan.filesParsed}`);
	console.log(`records (per-file dedup): ${scan.records.length}`);
	console.log(`records (global dedup):  ${deduped.length}`);
	console.log(`ids deferred (active):   ${scan.deferredIds}`);
	console.log("by model:");
	for (const [model, count] of tally(deduped, (r) => r.model)) {
		console.log(`  ${model}: ${count}`);
	}
	console.log("by month:");
	for (const [month, count] of tally(deduped, (r) => r.occurredAt.slice(0, 7)).sort()) {
		console.log(`  ${month}: ${count}`);
	}
	const nonStandard = deduped.filter((r) => r.speed !== "standard");
	console.log(`non-standard speed records: ${nonStandard.length}`);
	const fallback = deduped.filter((r) => getModelRates(r.model) === FALLBACK_RATE);
	console.log(`fallback-rate models: ${fallback.length}`);
}

// ── main ──

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	for (const arg of args) {
		if (arg !== "--dry-parse" && arg !== "--publish") {
			console.error(`unknown flag ${arg} — usage: fleet-collector [--dry-parse | --publish]`);
			process.exit(1);
		}
	}
	const dryParse = args.includes("--dry-parse");
	const publish = args.includes("--publish");
	if (dryParse && publish) {
		console.error("--dry-parse and --publish are mutually exclusive");
		process.exit(1);
	}
	if (!existsSync(join(REPO_ROOT, "packages/core/dist/index.js"))) {
		console.error(
			"packages/core/dist missing — run `npm ci && npx tsc -b` at the repo root first.",
		);
		process.exit(1);
	}

	const nowMs = Date.now();
	const scan = scanTranscripts(PROJECTS_DIR, projectDirAllowlist(PROJECT_ROOTS), nowMs);
	const deduped = dedupeRecords(scan.records);
	printScanReport(scan, deduped);
	if (dryParse) return;

	const { months, minted, recovered } = await collectRecords({
		records: deduped,
		fleetDir: FLEET_DIR,
		vaultRoot: VAULT_ROOT,
	});
	console.log(`replayed: minted ${minted}, recovered ${recovered} across ${months.join(", ")}`);

	// Post-run: workspace verifier over each touched month vault, fail-loud.
	for (const month of months) {
		const vaultBase = join(VAULT_ROOT, month);
		if (!existsSync(vaultBase)) continue; // nothing ever minted for this month
		runVerify(vaultBase, VERIFY_CLI, month);
		console.log(`verify ${month}: exit 0`);
	}

	// Rollup, derived from chain events + the collector's receipt store.
	const receiptsDir = join(FLEET_DIR, "receipts");
	const lines: FleetStoreLine[] = [];
	if (existsSync(receiptsDir)) {
		for (const file of readdirSync(receiptsDir).sort()) {
			if (file.endsWith(".jsonl")) lines.push(...readReceiptStore(join(receiptsDir, file)));
		}
	}
	if (lines.length === 0) {
		console.log("receipt store is empty — nothing to roll up yet");
		return;
	}
	const publishedMonth = new Date().toISOString().slice(0, 7);
	const chain = readOrderedChain(join(VAULT_ROOT, publishedMonth));
	const collectorCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	}).trim();
	const summary = buildFleetSummary({
		lines,
		chainHashes: chain.hashes,
		publishedMonth,
		scanReport: {
			dirsScanned: scan.dirsScanned,
			candidateDirsSkipped: scan.candidateDirsSkipped,
			deferredIds: scan.deferredIds,
		},
		generatedAt: new Date().toISOString(),
		collectorCommit,
	});
	const summaryPath = join(FLEET_DIR, "fleet-summary.json");
	writeFileSync(summaryPath, renderFleetSummary(summary));
	console.log(`rollup → ${summaryPath} (month ${publishedMonth}: ${summary.month.calls} calls)`);

	if (publish) {
		publishArtifacts({
			fleetDir: FLEET_DIR,
			month: publishedMonth,
			vaultRoot: VAULT_ROOT,
			verifyCli: VERIFY_CLI,
			siteFleetDir: SITE_FLEET_DIR,
			summaryPath,
		});
	}
}

// Import-safe: tests import the exported functions without running the CLI.
const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	await main();
}
