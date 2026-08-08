import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import ExhibitFSpool from "./exhibit-f-spool";

const facts = factsJson as unknown as EvidenceFacts;

/**
 * Exhibit F — the gate runs before the provider is ever called. A denial
 * throws a typed error (PolicyDeniedError) and the blocked call never
 * returns a receipt. Per the ruling on file, denials write NO audit event
 * today — see exhibit-f-spool.tsx's header for why there is no "audit
 * chain" language anywhere in this exhibit.
 */
export default function ExhibitF() {
	const operators = facts.facts.policyOperators;
	return (
		<section id="exhibit-f" className="safe-x relative mx-auto max-w-6xl py-24 sm:py-32">
			<p className="section-eyebrow">exhibit f</p>
			<h2 className="font-display mt-4 leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
				BLOCKED is a feature.
			</h2>
			<p className="mt-4 max-w-xl text-white/70">
				the gate runs before the provider is ever called. a denial throws — the provider is never
				called, and no receipt is returned.
			</p>
			<p className="mt-2 font-mono text-xs text-white/70">
				{operators.value} policy operators · {operators.source}
			</p>
			<ExhibitFSpool />
		</section>
	);
}
