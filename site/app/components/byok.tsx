"use client";

import { ScrollReveal } from "./scroll-reveal";

const providers = [
	{ name: "Anthropic", detail: "Claude SDK" },
	{ name: "OpenAI", detail: "GPT SDK" },
	{ name: "Google", detail: "Gemini SDK" },
	{ name: "xAI", detail: "Grok SDK" },
	{ name: "Groq", detail: "Fast inference" },
];

export function BYOK() {
	return (
		<section className="relative py-24 sm:py-28 px-6 border-t border-b border-white/[0.06]">
			<div className="max-w-5xl mx-auto flex flex-col items-center gap-10 text-center">
				<div className="flex flex-col gap-4 max-w-lg">
					<ScrollReveal>
						<h2 className="text-3xl sm:text-4xl font-bold leading-tight" style={{ textShadow: "0 0 40px rgba(52,211,153,0.1)" }}>
							Your keys. Your billing.
							<br />
							Our trust layer.
						</h2>
					</ScrollReveal>
					<ScrollReveal delay={0.1}>
						<p className="text-base text-white/60 leading-relaxed">
							<code className="font-mono text-ut">trust()</code> wraps your existing provider
							client. No proxy. No routing. No new accounts. Just trust on top of what you already
							use.
						</p>
					</ScrollReveal>
				</div>

				{/* Provider pills */}
				<ScrollReveal delay={0.15}>
					<div className="w-12 h-px bg-gradient-to-r from-transparent via-ut/20 to-transparent mx-auto" />
				</ScrollReveal>
				<ScrollReveal delay={0.2}>
					<div className="flex flex-wrap items-center justify-center gap-3">
						{providers.map((p) => (
							<div
								key={p.name}
								className="shimmer-border flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-white/[0.08] hover:border-white/20 hover:shadow-[0_0_20px_rgba(255,255,255,0.04)] hover:-translate-y-0.5 transition-all duration-300"
								style={{ background: "rgba(255,255,255,0.03)" }}
							>
								<span className="text-sm font-medium text-white/80">{p.name}</span>
								<span className="text-xs text-white/35">{p.detail}</span>
							</div>
						))}

						<div
							className="shimmer-border flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-ut/20 hover:border-ut/40 hover:shadow-[0_0_25px_rgba(52,211,153,0.1)] hover:-translate-y-0.5 transition-all duration-300"
							style={{ background: "rgba(52,211,153,0.04)" }}
						>
							<span className="text-sm font-medium text-ut/80">+ more</span>
							<span className="text-xs text-white/35">Any provider</span>
						</div>
					</div>
				</ScrollReveal>
			</div>
		</section>
	);
}
