"use client";

import { ScrollReveal } from "./scroll-reveal";

const colorStyles = {
	ut: { dot: "bg-ut", border: "hover:border-ut/25", label: "text-ut" },
	mem: { dot: "bg-mem", border: "hover:border-mem/25", label: "text-mem" },
	tim: { dot: "bg-tim", border: "hover:border-tim/25", label: "text-tim" },
	warning: { dot: "bg-warning", border: "hover:border-warning/25", label: "text-warning" },
	danger: { dot: "bg-danger", border: "hover:border-danger/25", label: "text-danger" },
} as const;

type ColorKey = keyof typeof colorStyles;

const cards: { title: string; subtitle: string; description: string; color: ColorKey }[] = [
	{
		title: "Two-phase settlement",
		subtitle: "PENDING → POST / VOID",
		description:
			"Budget held before execution. Settled on success. Voided on failure. Like a credit card hold at a gas pump.",
		color: "ut",
	},
	{
		title: "Policy engine",
		subtitle: "12 OPERATORS · YAML RULES",
		description:
			"Spend limits, model allowlists, PII blocking, rate limits. Enforced before the call — not after.",
		color: "mem",
	},
	{
		title: "Hash-chained audit",
		subtitle: "SHA-256 · RFC 6962 MERKLE",
		description:
			"Every transaction links to its predecessor via SHA-256. Tamper-evident by construction. SOC 2 ready.",
		color: "tim",
	},
	{
		title: "Bring your own keys",
		subtitle: "ZERO MIGRATION · ZERO LOCK-IN",
		description:
			"Keep your API keys. Keep your billing. trust() wraps your existing client — nothing changes.",
		color: "warning",
	},
	{
		title: "Apache 2.0 licensed",
		subtitle: "OPEN SOURCE · NO SAAS",
		description:
			"Run locally with JSON receipts. No account needed. No SaaS dependency. Read every line of code.",
		color: "danger",
	},
	{
		title: "Three lines to ship",
		subtitle: "IMPORT · WRAP · DONE",
		description:
			"No config files, no dashboard setup, no SDK initialization ceremony. One function call.",
		color: "ut",
	},
];

export function Features() {
	return (
		<section id="features" className="relative py-24 sm:py-32 px-6">
			<div className="max-w-5xl mx-auto flex flex-col gap-12">
				{/* Header */}
				<div className="flex flex-col gap-4 max-w-xl">
					<ScrollReveal>
						<p className="text-xs font-mono font-medium text-ut uppercase tracking-widest">
							What you get
						</p>
					</ScrollReveal>
					<ScrollReveal delay={0.1}>
						<h2 className="text-3xl sm:text-4xl font-bold leading-tight">
							Not observability.
							<br />
							Governance.
						</h2>
					</ScrollReveal>
					<ScrollReveal delay={0.2}>
						<p className="text-base text-white/60 leading-relaxed">
							Observability tells you what happened. Governance prevents what shouldn&apos;t.
						</p>
					</ScrollReveal>
				</div>

				{/* Cards grid */}
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{cards.map((card, i) => {
						const s = colorStyles[card.color];
						return (
							<ScrollReveal key={card.title} delay={i * 0.1}>
								<div
									className={`group flex flex-col gap-4 p-6 rounded-xl border border-white/[0.06] ${s.border} hover:bg-white/[0.02] transition-all duration-200`}
								>
									<div className="flex items-center gap-2.5">
										<span className={`w-1.5 h-1.5 rounded-full ${s.dot} shrink-0`} />
										<span
											className={`text-[10px] font-mono tracking-[0.12em] uppercase ${s.label} opacity-60`}
										>
											{card.subtitle}
										</span>
									</div>
									<div className="flex flex-col gap-2">
										<h3 className="font-semibold text-white text-base">{card.title}</h3>
										<p className="text-sm text-white/50 leading-relaxed">{card.description}</p>
									</div>
								</div>
							</ScrollReveal>
						);
					})}
				</div>
			</div>
		</section>
	);
}
