/**
 * collect.mts — the fleet-ledger collector (Task 5), everything downstream of
 * the CLI entry point.
 *
 *   npm run fleet:collect                # full run: scan → pre-flight → replay → verify → rollup
 *   npm run fleet:collect -- --dry-parse # parse + report only (no journal/vault writes)
 *   npm run fleet:collect -- --publish   # full run + publish gate + copy artifacts to site/public/fleet/
 *
 * WHY THIS IS NOT THE ENTRY POINT: `usertrust/pricing` and (through
 * `replay.mts`) `usertrust` are STATIC imports, and ESM resolves those before
 * a single line of this module runs. On a clean checkout — `dist/` is
 * gitignored and `npm ci` does not build workspaces — that is an
 * ERR_MODULE_NOT_FOUND stack instead of the one-line "run npx tsc -b" the
 * operator needs. `../fleet-collector.mts` is the entry: it imports nothing
 * from the workspace, checks the build, and only then imports this module.
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
 *
 * THE LEDGER HOME IS MACHINE-SCOPED, NOT CHECKOUT-SCOPED: the WAL journal,
 * receipt store and month vaults live at `~/.usertrust-fleet` (override:
 * `USERTRUST_FLEET_DIR`). A repo-relative home would give every worktree its
 * own divergent chain and let routine worktree cleanup destroy the ledger
 * that backs the published verify transcript. `SITE_FLEET_DIR` stays
 * repo-relative — artifacts publish into the checkout being committed from.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_RATE, getModelRates } from "usertrust/pricing";
import { type Journal, openJournal } from "./journal.mts";
import { type FleetRecord, parseTranscriptFile } from "./parse.mts";
import { replayMonth, SETTLED_EVENT_KIND } from "./replay.mts";
import {
	buildFleetSummary,
	type FleetStoreLine,
	readReceiptStore,
	renderFleetSummary,
} from "./rollup.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLEET_DIR = process.env.USERTRUST_FLEET_DIR ?? join(homedir(), ".usertrust-fleet");
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
	/** Ingestable records: quiescent-file records MINUS every globally deferred id. */
	records: FleetRecord[];
	dirsScanned: number;
	candidateDirsSkipped: number;
	/** DISTINCT message ids deferred by at least one still-active file. */
	deferredIds: number;
	filesParsed: number;
	/** RECORDS refused for unusable token counters — ids, not lines (parse.mts). */
	malformedRecords: number;
	/**
	 * Quiescent-file records withheld this run because some ACTIVE file is still
	 * rewriting the same id. Reported so the difference between "the corpus
	 * shrank" and "the corpus is still being written" is never a guess.
	 */
	withheldRecords: number;
}

/**
 * Scan every allowlisted project dir RECURSIVELY for `*.jsonl` transcripts —
 * subagent (sidechain) transcripts live in nested `<session>/subagents/`
 * dirs, and the corpus is ~87% sidechain fan-out (r1/M3), so a flat glob
 * would miss most of the fleet. Non-transcript JSONL files are harmless: the
 * parser's allowlist admits only assistant lines with a usage block.
 *
 * DEFERRAL IS GLOBAL, NOT PER-FILE. The same message id appears in an old
 * transcript AND in the continuation that is still being written (a resumed
 * session re-emits earlier messages), so a per-file rule would take the OLD
 * file's superseded copy while the active file merely deferred its own — and
 * `seen()` makes that permanent. Every scanned file's deferred ids are unioned
 * FIRST; only then is the ingestable set filtered. This is the cross-file twin
 * of the A→B→A rule inside one file (spec r2/C2).
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
		malformedRecords: 0,
		withheldRecords: 0,
	};
	const ingestable: FleetRecord[] = [];
	const deferred = new Set<string>();
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
			const { records, deferredIds, malformed } = parseTranscriptFile(join(base, file), nowMs);
			ingestable.push(...records);
			for (const id of deferredIds) deferred.add(id);
			result.malformedRecords += malformed;
			result.filesParsed += 1;
		}
	}
	// The union is complete only now — a file scanned LAST can defer an id a
	// file scanned first supplied, so the filter cannot run inside the loop.
	result.records = ingestable.filter((record) => !deferred.has(record.messageId));
	result.deferredIds = deferred.size;
	result.withheldRecords = ingestable.length - result.records.length;
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
	/**
	 * Events of the SETTLED kind (`llm_call`) — one per call that actually
	 * minted a receipt, which is exactly what the receipt store must hold a
	 * row for. Failure/denial kinds are excluded (replay.mts).
	 */
	settledCalls: number;
}

/**
 * Read every audit segment of a month vault, ordered by the persisted global
 * `sequence` (the same ordering `verifyVault` walks). Only an unterminated,
 * unparseable FINAL line of a segment is tolerated (torn tail); anything
 * else malformed throws.
 */
function readOrderedChain(vaultBase: string): OrderedChain {
	const auditDir = join(vaultBase, ".usertrust", "audit");
	const chain: OrderedChain = { rawLines: [], hashes: new Set(), settledCalls: 0 };
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
			const { hash, sequence, kind } = event as {
				hash?: unknown;
				sequence?: unknown;
				kind?: unknown;
			};
			if (typeof hash !== "string" || typeof sequence !== "number") {
				throw new Error(`fleet collect: audit event without hash/sequence at ${path}:${i + 1}`);
			}
			if (kind === SETTLED_EVENT_KIND) chain.settledCalls += 1;
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
	const vaultPath = join(vaultBase, ".usertrust");
	let out: string;
	try {
		out = execFileSync("node", [verifyCli, vaultPath], { encoding: "utf-8" });
	} catch (error) {
		const failed = error as { status?: number | null; stdout?: string; stderr?: string };
		throw new Error(
			`publish gate: usertrust-verify exited ${failed.status ?? "?"} for ${month}:\n` +
				`${[failed.stdout, failed.stderr].filter(Boolean).join("\n").trim()}`,
		);
	}
	return {
		// The LITERAL invocation that produced the lines below (final-review
		// must-fix 4) — real paths, repo-root-relative for readability. A
		// leading `../` is honest: it shows the vault is local to this
		// machine, outside the published checkout.
		command: `node ${relative(REPO_ROOT, verifyCli)} ${relative(REPO_ROOT, vaultPath)}`,
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
 *  3. the month's `llm_call` event count EQUALS its receipt-store line count —
 *     the OTHER direction, and the one that catches a call missing from the
 *     rollup. The rollup refuses a store line the chain cannot show; nothing
 *     refused a chained call the store never got (a crash between the chain
 *     event and the store append), so the summary silently undercounted;
 *  4. the workspace `usertrust-verify` exits 0 over the month vault.
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

	// 3. Chain → store parity. Every settled chain event is a call that minted a
	// receipt, so the month's store must hold exactly one row per event: fewer
	// rows means a call the page would never count (the rollup only ever
	// checked the reverse), more rows means a row the chain cannot vouch for.
	// The store is partitioned by month at write time (`replayMonth` refuses a
	// record outside its month), so the month file IS the month's rows.
	const storeLines = readReceiptStore(join(fleetDir, "receipts", `${month}.jsonl`)).length;
	if (chain.settledCalls !== storeLines) {
		throw new Error(
			`publish gate: ${month} chain has ${chain.settledCalls} llm_call event(s) but the ` +
				`receipt store has ${storeLines} receipt-store line(s) — every chained call must have ` +
				`exactly one store row, or the published summary counts a different set of calls than ` +
				`the chain proves. Re-run the collector to recover before publishing.`,
		);
	}

	// 4. Verifier exit 0.
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
	console.log(`records (ingestable):    ${scan.records.length}`);
	console.log(`records (global dedup):  ${deduped.length}`);
	console.log(`ids deferred (active):   ${scan.deferredIds}`);
	// Withheld, not lost: a quiescent file's copy of an id some ACTIVE file is
	// still rewriting. It ingests on the run after that file quiesces.
	console.log(`records withheld (id active elsewhere): ${scan.withheldRecords}`);
	// Refused, never zero-filled: a record whose FINAL occurrence is missing
	// input_tokens/output_tokens cannot be metered honestly, and a fabricated
	// zero would publish as a provider-metered ~1-usertoken call (D5). Counted
	// per id, so this is records dropped — loud, so a corpus that starts
	// dropping calls is visible instead of just smaller.
	console.log(`records refused (malformed counters): ${scan.malformedRecords}`);
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

/**
 * The published month, derived from the clock captured at RUN START.
 *
 * Never `Date.now()` at rollup time: a long replay can cross a UTC month
 * boundary, and recomputing afterwards points the publish at a month the run
 * never touched — an empty or wrong summary, gated against a chain whose
 * journal was never even opened. The scan, the month routing and the publish
 * must all answer to one clock.
 */
export const publishMonthFor = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 7);

export async function main(): Promise<void> {
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
	const publishedMonth = publishMonthFor(nowMs);
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
