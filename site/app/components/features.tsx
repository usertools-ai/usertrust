"use client";

import { ScrollReveal } from "./scroll-reveal";

const colorStyles = {
	ut: {
		dot: "bg-ut",
		border: "hover:border-ut/25",
		label: "text-ut",
		glow: "hover:shadow-[0_0_25px_rgba(52,211,153,0.08),0_0_60px_rgba(52,211,153,0.04)]",
	},
	mem: {
		dot: "bg-mem",
		border: "hover:border-mem/25",
		label: "text-mem",
		glow: "hover:shadow-[0_0_25px_rgba(192,132,252,0.08),0_0_60px_rgba(192,132,252,0.04)]",
	},
	tim: {
		dot: "bg-tim",
		border: "hover:border-tim/25",
		label: "text-tim",
		glow: "hover:shadow-[0_0_25px_rgba(108,160,192,0.08),0_0_60px_rgba(108,160,192,0.04)]",
	},
	warning: {
		dot: "bg-warning",
		border: "hover:border-warning/25",
		label: "text-warning",
		glow: "hover:shadow-[0_0_25px_rgba(245,158,11,0.08),0_0_60px_rgba(245,158,11,0.04)]",
	},
	danger: {
		dot: "bg-danger",
		border: "hover:border-danger/25",
		label: "text-danger",
		glow: "hover:shadow-[0_0_25px_rgba(239,68,68,0.08),0_0_60px_rgba(239,68,68,0.04)]",
	},
} as const;

type ColorKey = keyof typeof colorStyles;

const ICONS = [
	// Two-phase settlement (swap/exchange arrows)
	<svg key="swap" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
		<path d="M2 5h12M10 2l3 3-3 3" />
		<path d="M14 11H2M6 8l-3 3 3 3" />
	</svg>,
	// Policy engine (shield with check)
	<svg key="shield" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M8 1.5L2.5 4v4c0 3.5 2.5 5.5 5.5 6.5 3-1 5.5-3 5.5-6.5V4L8 1.5z" />
		<path d="M5.5 8l2 2 3.5-3.5" />
	</svg>,
	// Hash-chained audit (chain links)
	<svg key="chain" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
		<rect x="1" y="5" width="5" height="6" rx="1" />
		<rect x="10" y="5" width="5" height="6" rx="1" />
		<path d="M6 8h4" />
	</svg>,
	// Bring your own keys (key)
	<svg key="key" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="5" cy="8" r="3" />
		<path d="M8 8h6M12 6v4" />
	</svg>,
	// Apache 2.0 licensed (open lock)
	<svg key="lock" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<rect x="3" y="7" width="10" height="7" rx="1.5" />
		<path d="M5.5 7V5a2.5 2.5 0 015 0" />
	</svg>,
	// Three lines to ship (terminal/code brackets)
	<svg key="code" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
		<path d="M4 4L1 8l3 4" />
		<path d="M12 4l3 4-3 4" />
		<path d="M10 2L6 14" />
	</svg>,
];

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
			"Every transaction links to its predecessor via SHA-256. Tamper-evident by construction.",
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
						<p className="text-xs font-medium text-ut uppercase tracking-widest">What you get</p>
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
									className={`group flex flex-col gap-4 p-6 rounded-xl border border-white/[0.06] ${s.border} ${s.glow} hover:bg-white/[0.02] hover:-translate-y-0.5 transition-all duration-300`}
								>
									<div className="flex items-center gap-2.5">
										<span className={`${s.label} opacity-50`}>
											{ICONS[i]}
										</span>
										<span
											className={`text-[10px] tracking-[0.12em] uppercase ${s.label} opacity-60`}
										>
											{card.subtitle}
										</span>
									</div>
									<div className="flex flex-col gap-2">
										<h3 className="font-semibold text-white text-base">{card.title}</h3>
										<p className="text-sm text-white/50 leading-relaxed">
											{card.description.split("trust()").map((part, j, arr) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: static split
												<span key={j}>
													{part}
													{j < arr.length - 1 && <code className="font-mono text-ut">trust()</code>}
												</span>
											))}
										</p>
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
