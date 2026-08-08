import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import TerminalFrame from "../terminal-frame";

const facts = factsJson as EvidenceFacts;

/**
 * CASE FILE 001 — dark mono incident-log frame (Addendum C2: paper retired;
 * evidence renders in the register the SDK emits). Closes UNSTAMPED.
 *
 * Renders through the shared TerminalFrame: the two-part header (case
 * number + "incident log" caption, `justify-between`) is a `ReactNode`
 * title, and the dashed "unstamped" footer is the frame's `footer` slot —
 * unstyled by the frame itself, so the dashed border and small-caps
 * treatment stay this surface's own choice rather than a generic look
 * every footer would otherwise share.
 */
export default function CaseFile() {
	const calls = facts.facts.caseFileCalls.value.toLocaleString("en-US");
	const dollars = facts.facts.caseFileDollars.value.toLocaleString("en-US");
	return (
		<TerminalFrame
			className="mx-auto w-full max-w-md text-white/70"
			title={
				<div className="flex w-full items-center justify-between">
					<span className="font-bold text-white/80">case file 001</span>
					<span className="text-white/40">incident log</span>
				</div>
			}
			footer={
				<div className="border-t border-dashed border-white/15 px-4 py-2 font-mono text-[12px] uppercase tracking-widest text-white/35">
					file closed — unstamped
				</div>
			}
		>
			<p className="text-white/45">subject: autonomous coding agent · production API key</p>
			<p className="mt-3">overnight, the agent entered a retry loop nothing was watching.</p>
			<p className="mt-2">{calls} identical completion calls. no variation. no ceiling.</p>
			<p className="mt-2">
				the spend surfaced as a ${dollars} line item on the invoice — not in any log.
			</p>
			<p className="mt-2">no budget hold. no audit chain. nothing threw.</p>
			<p className="mt-2">finding: the run left nothing behind to verify, dispute, or replay.</p>
			<p className="mt-4 font-bold text-white">no receipts existed.</p>
		</TerminalFrame>
	);
}
