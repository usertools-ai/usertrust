import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import ExhibitFSpool from "./exhibit-f-spool";

const facts = factsJson as unknown as EvidenceFacts;

/**
 * Exhibit F — the gate runs before the provider is ever called. A denial
 * throws a typed error (PolicyDeniedError) and the blocked call never returns
 * a receipt; it DOES leave a `policy_denied` chain event behind, which is the
 * one thing this exhibit used to be careful to deny (correctly, at the time —
 * see exhibit-f-spool.tsx's header). Exhibit C renders the real captured event.
 */
export default function ExhibitF() {
	const operators = facts.facts.policyOperators;
	return (
		<section
			id="exhibit-f"
			data-theme="steel"
			className="section-anchor safe-x relative mx-auto max-w-6xl py-14 sm:py-20"
		>
			<p className="section-eyebrow">exhibit f</p>
			<h2 className="font-display mt-3 leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
				BLOCKED is a feature.
			</h2>
			<p className="mt-3 max-w-2xl text-white/70">
				the gate runs before the provider is ever called. a denial throws, the provider is never
				reached, and no receipt is returned — but the refusal is not silent. denials don&rsquo;t get
				receipts. they get chain events.
			</p>
			<p className="mt-2 font-mono text-xs text-white/70">
				{operators.value} policy operators · {operators.source}
			</p>
			<ExhibitFSpool />
		</section>
	);
}
