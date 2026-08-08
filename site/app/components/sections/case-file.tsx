import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";

const facts = factsJson as EvidenceFacts;

/**
 * CASE FILE 001 — dark mono incident-log frame (Addendum C2: paper retired;
 * evidence renders in the register the SDK emits). Closes UNSTAMPED.
 */
export default function CaseFile() {
	const calls = facts.facts.caseFileCalls.value.toLocaleString("en-US");
	const dollars = facts.facts.caseFileDollars.value.toLocaleString("en-US");
	return (
		<div className="mx-auto w-full max-w-md border border-white/15 bg-white/[0.03]">
			<div className="flex items-center justify-between border-b border-white/15 px-4 py-2">
				<span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-white/80">
					case file 001
				</span>
				<span className="font-mono text-[10px] uppercase tracking-widest text-white/40">
					incident log
				</span>
			</div>
			<div className="px-5 py-5 font-mono text-[13px] leading-6 text-white/70">
				<p className="text-white/45">subject: autonomous coding agent · production API key</p>
				<p className="mt-3">overnight, the agent entered a retry loop nothing was watching.</p>
				<p className="mt-2">{calls} identical completion calls. no variation. no ceiling.</p>
				<p className="mt-2">
					the spend surfaced as a ${dollars} line item on the invoice — not in any log.
				</p>
				<p className="mt-2">no budget hold. no audit chain. nothing threw.</p>
				<p className="mt-2">finding: the run left nothing behind to verify, dispute, or replay.</p>
				<p className="mt-4 font-bold text-white">no receipts existed.</p>
			</div>
			<div className="border-t border-dashed border-white/15 px-5 py-2 font-mono text-[10px] uppercase tracking-widest text-white/35">
				file closed — unstamped
			</div>
		</div>
	);
}
