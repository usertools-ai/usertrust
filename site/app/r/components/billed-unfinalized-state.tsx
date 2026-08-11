import { BILLED_UNFINALIZED_HEADLINE, BILLED_UNFINALIZED_REGISTER_NOTE } from "../lib/shell-copy";
import type { BilledUnfinalizedState } from "../lib/wire";
import HashValue from "./hash-value";
import NonGreenMasthead from "./nongreen-masthead";
import TerminalPaperStub from "./terminal-paper-stub";

/**
 * §7 — `billedUnfinalized` (410): "NON-GREEN and loud: work was billed, the
 * artifact association was never proven ... Renders the terminal-event
 * proof summary and, after R3's cross-checks pass, the link to the
 * spend-only fallback session receipt. Danger register without the
 * integrity-failure treatment: this is a failed promise, not a forgery
 * signal."
 *
 * The `linkage` field is the whole obligation, R3/R19: `state.linkage` is
 * only ever `"verified"` here because `resolvePageState` (the page's own
 * door, `lib/resolve.ts`) runs {@link
 * import("../lib/wire").verifyBilledUnfinalizedLinkage} BEFORE this
 * component ever sees a `billedUnfinalized` state — a broken equality
 * becomes an `integrityFailure` state upstream, never reaches here. This
 * component still gates the link on `linkage === "verified"` itself, rather
 * than trusting the caller: "any mismatch → integrity-failure state, no
 * link rendered" is the receipt-spec's own rule, and a component that
 * rendered a link whenever ASKED (rather than whenever PROVEN) would be one
 * refactor away from violating it.
 */
export default function BilledUnfinalizedStateView({ state }: { state: BilledUnfinalizedState }) {
	const { terminalEvent } = state.envelope;
	return (
		<section
			data-state="billedUnfinalized"
			data-linkage={state.linkage}
			className="flex flex-col gap-6"
		>
			<NonGreenMasthead word={BILLED_UNFINALIZED_HEADLINE} register="danger">
				<p className="text-[13px] leading-relaxed text-white/70">
					{BILLED_UNFINALIZED_REGISTER_NOTE}
				</p>
			</NonGreenMasthead>

			<TerminalPaperStub
				receiptId={state.receiptId}
				statusWord="BILLED — UNFINALIZED"
				stamp={{ word: "UNPROVEN", colorClassName: "text-paper-red" }}
			/>

			<div
				className="lift-1 flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4"
				data-testid="terminal-event-proof"
			>
				<p className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
					terminal-event proof summary
				</p>
				<dl className="grid gap-3 sm:grid-cols-2">
					<div className="flex flex-col gap-1">
						<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							chain
						</dt>
						<dd className="font-mono text-[13px] text-white/85">{terminalEvent.chain}</dd>
					</div>
					<div className="flex flex-col gap-1">
						<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							profile
						</dt>
						<dd className="font-mono text-[13px] text-white/85">{terminalEvent.profile}</dd>
					</div>
					<div className="flex flex-col gap-1 sm:col-span-2">
						<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							event hash
						</dt>
						<dd>
							<HashValue value={terminalEvent.event.hash} label="terminal event hash" />
						</dd>
					</div>
					<div className="flex flex-col gap-1 sm:col-span-2">
						<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							transfer-set root
						</dt>
						<dd>
							<HashValue value={state.transferSetRoot} label="transfer-set root" />
						</dd>
					</div>
					<div className="flex flex-col gap-1">
						<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							segment / tree size
						</dt>
						<dd className="font-mono text-[13px] text-white/85">
							{terminalEvent.checkpoint.segmentId} · {terminalEvent.checkpoint.treeSize}
						</dd>
					</div>
					<div className="flex flex-col gap-1">
						<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							checkpoint published
						</dt>
						<dd className="font-mono text-[13px] text-white/85">
							{terminalEvent.checkpoint.publishedAt}
						</dd>
					</div>
				</dl>
			</div>

			{state.linkage === "verified" ? (
				<p className="text-[13px] leading-relaxed text-white/70" data-testid="fallback-link">
					this reservation billed but was never finalized into a receipt of its own. the same spend
					is recorded on a spend-only fallback session receipt:{" "}
					<a
						className="focus-ring underline decoration-white/40 underline-offset-2 hover:text-white"
						href={`/r/${state.linkedReceiptId}`}
					>
						{state.linkedReceiptId}
					</a>
				</p>
			) : null}
		</section>
	);
}
