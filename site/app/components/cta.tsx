"use client";

import { GitHubIcon } from "./github-icon";
import { ScrollReveal } from "./scroll-reveal";

export function CTA() {
	return (
		<section className="relative py-32 sm:py-40 px-6">
			<div className="max-w-[640px] mx-auto flex flex-col items-center gap-8 text-center">
				<div className="flex flex-col gap-4">
					<ScrollReveal>
						<h2 className="text-4xl sm:text-5xl font-bold leading-tight">Read every line</h2>
					</ScrollReveal>
					<ScrollReveal delay={0.1}>
						<p className="text-base text-white/60 leading-relaxed">
							Your trust layer shouldn&apos;t be a black box. UserTrust is open source under the
							Apache 2.0 license.
						</p>
					</ScrollReveal>
				</div>

				<ScrollReveal delay={0.2}>
					<div className="flex flex-wrap items-center justify-center gap-3">
						<a
							href="https://github.com/usertools-ai/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-2.5 px-6 py-3 bg-ut text-brand-bg rounded-lg text-sm font-semibold hover:bg-ut/90 active:scale-[0.98] transition-all duration-150"
						>
							<GitHubIcon className="w-4 h-4" />
							View on GitHub
						</a>

						<a
							href="/docs"
							className="inline-flex items-center gap-2 px-6 py-3 border border-white/[0.12] rounded-lg text-sm font-medium text-white/80 hover:bg-white/[0.05] hover:text-white hover:border-white/20 transition-all duration-150"
						>
							Read the docs
						</a>
					</div>
				</ScrollReveal>
			</div>
		</section>
	);
}
