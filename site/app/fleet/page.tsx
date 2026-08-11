import type { Metadata } from "next";
import CopyChip from "../components/copy-chip";
import { GridBackground } from "../components/grid-background";
import StageTag from "../components/stage-tag";
import TerminalFrame from "../components/terminal-frame";
import { jsonLines, tokenClass } from "../lib/receipt-json";
import {
	chainTail,
	type FleetChainEvent,
	formatMeter,
	formatUsd,
	formatUt,
	isoDay,
	latestReceipts,
	loadChainEvents,
	loadFleetSummary,
	loadVerifyTranscript,
	receiptJson,
	sessionDisplayRows,
	shortHash,
} from "./fleet-lib";

/*
 * /fleet — the fleet ledger (spec Component Three).
 *
 * Every figure on this page renders from the committed artifacts under
 * public/fleet/ through fleet-lib's formatters; the check-facts prebuild gate
 * scans every .tsx directly in this directory, so a hand-typed digit in the
 * prose fails the build. The strings in ALL-CAPS constants below are PINNED
 * (Task Seven brief) — they carry the page's honesty posture and render
 * verbatim: do not paraphrase, do not improve.
 *
 * Cross-track rule: fleet receipts are minted local-mode, so no receipt URL
 * exists and none is rendered — this page links only the /fleet/* artifacts.
 */

const CLAIM =
	"ingested Claude Code calls from the machine that builds usertrust — metered through usertrust.";
const SOURCE_LABEL =
	"provider-reported usage, recorded by the harness at call time, collected post-hoc.";
const CHAINED_VS_ASSERTED =
	"under the chain: model, meters, cost, rates, attribution tag. collector-asserted: call time, sidechain flag, cache-write tiers.";
const RECONCILIATION_SCOPE =
	"list-price equivalent of metered calls — not a bill. invoice reconciliation lands when billed-usage data does.";
const ATTESTATION =
	"this chain is self-attested by the operator. the published monthly slice is additionally timestamped by this repo's commit history.";
const SMALL_PRINT = "tamper-evident, not tamper-proof — detection, not recovery.";

export const metadata: Metadata = {
	title: "the fleet ledger — usertrust",
	description: CLAIM,
	alternates: { canonical: "/fleet" },
};

/* The artifacts are read from disk at build time; the route has no runtime inputs. */
export const dynamic = "force-static";

const ARTIFACTS = [
	{ label: "fleet-summary.json", href: "/fleet/fleet-summary.json" },
	{ label: "chain.jsonl", href: "/fleet/chain.jsonl" },
	{ label: "verify-transcript.json", href: "/fleet/verify-transcript.json" },
];

const CURL_ARTIFACT = "curl -s https://usertrust.ai/fleet/fleet-summary.json";

/** The dry-run chip — StageTag's chrome, carrying the mode label instead. */
function DryRunChip() {
	return (
		<span className="inline-flex items-center rounded-sm border border-ut/[0.08] bg-ut/[0.04] px-2 py-0.5 font-mono text-xs uppercase tracking-[0.18em] text-ut/80">
			dry-run
		</span>
	);
}

function MeterStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">{label}</dt>
			<dd className="font-mono text-lg text-white">{value}</dd>
		</div>
	);
}

/** The receipt JSON body — exhibit A's receipt rendering, server-only here. */
function ReceiptBody({ event }: { event: FleetChainEvent }) {
	return (
		<pre className="whitespace-pre-wrap break-all">
			<code>
				{jsonLines(receiptJson(event)).map((line) => (
					<span key={line.key} className="block py-px">
						{"  ".repeat(line.indent)}
						{line.tokens.map((tok) => (
							<span key={tok.key} className={tokenClass(tok.role, false)}>
								{tok.text}
							</span>
						))}
					</span>
				))}
			</code>
		</pre>
	);
}

const TH = "pb-2 pr-4 text-left font-mono text-[12px] uppercase tracking-[0.12em] text-white/70";
const TH_NUM = `${TH} text-right`;
const TD = "border-t border-white/[0.06] py-1.5 pr-4 text-white/90";
const TD_NUM = `${TD} text-right`;

export default function FleetLedger() {
	const summary = loadFleetSummary();
	const events = loadChainEvents();
	const transcript = loadVerifyTranscript();
	const tail = chainTail(events);
	const receipts = latestReceipts(events);
	const sessions = sessionDisplayRows(summary.bySession);
	const namedSessions = sessions.filter((row) => !row.isOther).length;

	return (
		<>
			<GridBackground />
			<main data-theme="emerald" className="relative safe-x pb-20">
				<div className="mx-auto flex max-w-5xl flex-col gap-14">
					{/* ── block one: header ── */}
					<header className="pt-10">
						<div className="flex items-center justify-between gap-4">
							<a
								href="/"
								data-cursor-hover
								className="focus-ring inline-flex min-h-[44px] items-center font-mono text-xs text-white/70 transition-colors duration-200 hover:text-white"
							>
								← usertrust
							</a>
							<DryRunChip />
						</div>
						<h1 className="mt-6 font-display lowercase text-5xl leading-none sm:text-7xl">
							the fleet ledger.
						</h1>
						<p className="mt-5 max-w-2xl font-mono text-sm leading-relaxed text-white/80">
							{CLAIM}
						</p>
						<p className="mt-2 max-w-2xl font-mono text-xs leading-relaxed text-white/70">
							{SOURCE_LABEL}
						</p>
						<p className="mt-4 font-mono text-xs text-white/70">
							publishing {summary.window.publishedMonth} · backfill origin{" "}
							{isoDay(summary.window.firstOccurredAt)} · generated {isoDay(summary.generatedAt)} ·
							collector {summary.collectorCommit}
						</p>
					</header>

					{/* ── block two: this month ── */}
					<section aria-label="this month">
						<TerminalFrame title={`this month · ${summary.window.publishedMonth}`}>
							<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
								<span className="text-2xl font-bold text-white sm:text-3xl">
									{formatUt(summary.month.usertokens)}
								</span>
								<span className="text-white/70">
									kernel base · {formatUsd(summary.month.kernelUsd)}
								</span>
							</div>
							<dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
								<MeterStat label="calls" value={formatMeter(summary.month.calls)} />
								<MeterStat label="input" value={formatMeter(summary.month.inputTokens)} />
								<MeterStat label="output" value={formatMeter(summary.month.outputTokens)} />
								<MeterStat label="cache read" value={formatMeter(summary.month.cacheReadTokens)} />
								<MeterStat
									label="cache write"
									value={formatMeter(summary.month.cacheWriteTokens)}
								/>
							</dl>
						</TerminalFrame>
					</section>

					{/* ── block three: per-model table ── */}
					<section aria-label="by model">
						<TerminalFrame title="by model · month-to-date">
							<div className="overflow-x-auto">
								<table className="w-full border-collapse">
									<thead>
										<tr>
											<th className={TH}>model</th>
											<th className={TH_NUM}>calls</th>
											<th className={TH_NUM}>usertokens</th>
											<th className={TH_NUM}>kernel usd</th>
											<th className={TH_NUM}>rate source</th>
										</tr>
									</thead>
									<tbody>
										{summary.byModel.map((row) => (
											<tr key={row.model}>
												<td className={TD}>{row.model}</td>
												<td className={TD_NUM}>{formatMeter(row.calls)}</td>
												<td className={TD_NUM}>{formatUt(row.usertokens)}</td>
												<td className={TD_NUM}>{formatUsd(row.kernelUsd)}</td>
												<td className={`${TD} text-right text-ut/80`}>{row.rateSource}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</TerminalFrame>
					</section>

					{/* ── block four: sessions ── */}
					<section aria-label="sessions">
						<p className="mb-4 max-w-3xl font-mono text-xs leading-relaxed text-white/70">
							attribution is chained, not asserted: every replayed call is minted under the
							cost-center tag{" "}
							<code className="text-ut/80">fleet.&lt;sessionHash&gt;.&lt;messageId&gt;</code>, so
							the split below sums over tags the chain can prove. session ids are hashed before they
							leave the machine.
						</p>
						<TerminalFrame title="sessions · by spend">
							<div className="overflow-x-auto">
								<table className="w-full border-collapse">
									<thead>
										<tr>
											<th className={TH}>session</th>
											<th className={TH_NUM}>calls</th>
											<th className={TH_NUM}>usertokens</th>
											<th className={TH_NUM}>sidechain share</th>
										</tr>
									</thead>
									<tbody>
										{sessions.map((row) => (
											<tr key={row.label}>
												<td className={`${TD} ${row.isOther ? "text-white/70" : ""}`}>
													{row.isOther ? <>other — beyond the top {namedSessions}</> : row.label}
												</td>
												<td className={TD_NUM}>{formatMeter(row.calls)}</td>
												<td className={TD_NUM}>{formatUt(row.usertokens)}</td>
												<td className={TD_NUM}>{row.share}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</TerminalFrame>
					</section>

					{/* ── block five: latest receipts ── */}
					<section aria-label="latest receipts">
						<div className="mb-4 flex flex-wrap items-center gap-3">
							<h2 className="font-display lowercase text-2xl text-white">latest receipts.</h2>
							<span className="font-mono text-xs text-white/70">
								chained fields only — the chain event is the receipt.
							</span>
						</div>
						<div className="grid gap-4 lg:grid-cols-3">
							{receipts.map((event) => (
								<TerminalFrame key={event.hash} title={`receipt · link ${event.sequence}`}>
									<ReceiptBody event={event} />
								</TerminalFrame>
							))}
						</div>
					</section>

					{/* ── block six: chain tail + verify ── */}
					<section aria-label="chain and verification">
						<div className="mb-4 flex flex-wrap items-center gap-3">
							<h2 className="font-display lowercase text-2xl text-white">the chain, verified.</h2>
							<StageTag stage="RECORD" />
							<StageTag stage="VERIFY" />
						</div>
						<div className="grid gap-4 lg:grid-cols-2">
							<TerminalFrame
								title="chain tail · ingest order"
								footer={
									<div className="border-t border-white/10 px-5 py-2.5 font-mono text-[12px] tracking-wide text-white/70">
										last {tail.length} of {events.length} events — ingest order: cross-run
										chronology may interleave; this is the order records entered the chain.
									</div>
								}
							>
								<div className="overflow-x-auto">
									<table className="w-full border-collapse">
										<thead>
											<tr>
												<th className={TH_NUM}>seq</th>
												<th className={TH}>kind</th>
												<th className={TH}>model</th>
												<th className={TH_NUM}>cost</th>
												<th className={TH}>hash</th>
											</tr>
										</thead>
										<tbody>
											{tail.map((event) => (
												<tr key={event.hash}>
													<td className={TD_NUM}>{event.sequence}</td>
													<td className={TD}>{event.kind}</td>
													<td className={TD}>{event.data.model ?? "—"}</td>
													<td className={TD_NUM}>
														{event.data.cost === undefined ? "—" : formatUt(event.data.cost)}
													</td>
													<td className={`${TD} text-white/70`}>{shortHash(event.hash)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</TerminalFrame>
							<TerminalFrame
								title="usertrust-verify"
								footer={
									<div className="border-t border-white/10 px-5 py-2.5 font-mono text-[12px] tracking-wide text-white/70">
										exit {transcript.exitCode} — the gate run whose transcript this is.
									</div>
								}
							>
								<p className="text-white/70">$ {transcript.command}</p>
								<div className="mt-2 flex flex-col gap-0.5">
									{transcript.lines.map((line) => (
										<p key={line} className="text-white/90">
											{line}
										</p>
									))}
								</div>
							</TerminalFrame>
						</div>
						<div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
							{ARTIFACTS.map((artifact) => (
								<a
									key={artifact.href}
									href={artifact.href}
									data-cursor-hover
									className="focus-ring inline-flex min-h-[44px] items-center font-mono text-sm text-white/70 underline decoration-white/30 underline-offset-4 transition-colors duration-200 hover:text-ut"
								>
									{artifact.label}
								</a>
							))}
							<CopyChip text={CURL_ARTIFACT} label="fleet curl" />
						</div>
					</section>

					{/* ── block seven: reconciliation ── */}
					<section aria-label="reconciliation">
						<TerminalFrame title="reconciliation · two priced bases">
							<div className="grid gap-6 sm:grid-cols-2">
								<div className="flex flex-col gap-1">
									<p className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
										kernel base (canonical)
									</p>
									<p className="text-2xl font-bold text-white">
										{formatUsd(summary.month.kernelUsd)}
									</p>
								</div>
								<div className="flex flex-col gap-1">
									<p className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
										api list-price equivalent (context)
									</p>
									<p className="text-2xl font-bold text-white/80">
										{formatUsd(summary.month.listPriceUsd)}
									</p>
								</div>
							</div>
							<p className="mt-5 max-w-3xl text-[12px] leading-relaxed text-ut/80">
								{RECONCILIATION_SCOPE}
							</p>
							<p className="mt-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
								residual causes, in order
							</p>
							<ol className="mt-1 list-inside list-decimal text-white/90">
								{summary.residualCauses.map((cause) => (
									<li key={cause} className="py-0.5">
										{cause}
									</li>
								))}
							</ol>
							<p className="mt-4 text-[12px] text-white/70">
								observed pricing-table versions: {summary.tableVersions.join(" · ")}
							</p>
						</TerminalFrame>
					</section>

					{/* ── block eight: small print ── */}
					<section aria-label="small print" className="border-t border-white/[0.06] pt-6">
						<div className="flex max-w-3xl flex-col gap-3 font-mono text-xs leading-relaxed text-white/70">
							<p>
								every record on this page is verifiable; whether every call reached this page is not
								claimed. scan report — project dirs scanned:{" "}
								{formatMeter(summary.scanReport.dirsScanned)} · usertrust-shaped dirs skipped:{" "}
								{formatMeter(summary.scanReport.candidateDirsSkipped)} · ids deferred as
								still-active: {formatMeter(summary.scanReport.deferredIds)}.
							</p>
							<p>
								cadence: manual — the ledger republishes when the collector runs. nightly automation
								is a ledgered follow-up.
							</p>
							<p>{CHAINED_VS_ASSERTED}</p>
							<p>
								the disclosure cuts both ways: this page publishes activity metadata about the
								fleet's own sessions — per-session spend, cadence — deliberately.
							</p>
							<p>{ATTESTATION}</p>
							<p className="text-white/80">{SMALL_PRINT}</p>
						</div>
					</section>
				</div>
			</main>
		</>
	);
}
