"use client";

import { ScrollReveal } from "./scroll-reveal";

const useCases = [
	{
		role: "AI startups",
		detail: "Ship with spend controls from day one",
	},
	{
		role: "Enterprise teams",
		detail: "Audit-ready governance without vendor lock-in",
	},
	{
		role: "Agent builders",
		detail: "Budget holds for every autonomous LLM call",
	},
	{
		role: "Platform engineers",
		detail: "Policy gates that enforce before the call, not after",
	},
];

export function BuiltFor() {
	return (
		<section className="relative py-20 sm:py-24 px-6">
			<div className="max-w-5xl mx-auto">
				<div className="text-center mb-12">
					<ScrollReveal>
						<p className="text-xs font-medium text-ut uppercase tracking-widest mb-4">Built for</p>
					</ScrollReveal>
					<ScrollReveal delay={0.1}>
						<h2 className="text-3xl sm:text-4xl font-bold leading-tight">
							Teams that ship AI responsibly
						</h2>
					</ScrollReveal>
				</div>

				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
					{useCases.map((uc, i) => (
						<ScrollReveal key={uc.role} delay={i * 0.1}>
							<div className="group flex flex-col gap-2 p-5 rounded-xl border border-white/[0.06] hover:border-ut/20 hover:bg-white/[0.02] hover:shadow-[0_0_25px_rgba(52,211,153,0.06)] hover:-translate-y-0.5 transition-all duration-300 h-full">
								<span className="text-sm font-semibold text-white">{uc.role}</span>
								<span className="text-xs text-white/40 leading-relaxed">{uc.detail}</span>
							</div>
						</ScrollReveal>
					))}
				</div>
			</div>
		</section>
	);
}
