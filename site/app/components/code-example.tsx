"use client";

import { GovernanceReceipt } from "./governance-receipt";
import { ScrollReveal } from "./scroll-reveal";
import { TypewriterCode } from "./typewriter-code";

export function CodeExample() {
	return (
		<section id="code" className="relative py-24 sm:py-32 px-6">
			<div className="max-w-5xl mx-auto">
				<div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
					{/* Left: copy */}
					<div className="flex flex-col gap-5">
						<ScrollReveal>
							<p className="text-xs font-medium text-ut uppercase tracking-widest">One line</p>
						</ScrollReveal>
						<ScrollReveal delay={0.1}>
							<h2 className="text-3xl sm:text-4xl font-bold leading-tight">
								Wrap any client.
								<br />
								Keep your keys.
							</h2>
						</ScrollReveal>
						<ScrollReveal delay={0.2}>
							<p className="text-base text-white/60 leading-relaxed">
								Your API keys. Your billing. Your provider. <code className="text-ut">trust()</code>{" "}
								adds budget holds and audit trails on top — nothing changes except now you have
								control.
							</p>
						</ScrollReveal>

						{/* Micro-features list */}
						<ScrollReveal delay={0.3}>
							<ul className="flex flex-col gap-3 mt-2">
								<li className="flex items-start gap-3 text-sm text-white/60">
									<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
									One <code className="text-ut">await trust(client)</code> call — nothing else
									changes
								</li>
								<li className="flex items-start gap-3 text-sm text-white/60">
									<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
									Returns the same interface as the original SDK
								</li>
								<li className="flex items-start gap-3 text-sm text-white/60">
									<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
									Every response includes a <code className="text-ut">receipt</code> with
									hash-chained proof
								</li>
							</ul>
						</ScrollReveal>
					</div>

					{/* Right: code block — typewriter animation */}
					<TypewriterCode />
				</div>

				{/* Governance receipt — what you get back */}
				<div className="mt-16 lg:mt-24">
					<GovernanceReceipt />
				</div>
			</div>
		</section>
	);
}
