"use client";

import { ScrollReveal } from "./scroll-reveal";

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
								Your API keys. Your billing. Your provider.{" "}
								<code className="text-ut text-sm">trust()</code> adds budget holds and audit trails
								on top — nothing changes except now you have control.
							</p>
						</ScrollReveal>

						{/* Micro-features list */}
						<ScrollReveal delay={0.3}>
							<ul className="flex flex-col gap-3 mt-2">
								<li className="flex items-start gap-3 text-sm text-white/60">
									<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
									One <code className="text-ut text-xs">await trust(client)</code> call — nothing
									else changes
								</li>
								<li className="flex items-start gap-3 text-sm text-white/60">
									<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
									Returns the same interface as the original SDK
								</li>
								<li className="flex items-start gap-3 text-sm text-white/60">
									<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
									Every response includes a <code className="text-ut text-xs">receipt</code> with
									hash-chained proof
								</li>
							</ul>
						</ScrollReveal>
					</div>

					{/* Right: code block */}
					<ScrollReveal delay={0.2}>
						<div
							className="rounded-xl border border-white/[0.08] overflow-hidden"
							style={{ background: "rgba(255,255,255,0.03)" }}
						>
							{/* Window chrome */}
							<div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06]">
								<span className="w-2.5 h-2.5 rounded-full bg-danger/60" />
								<span className="w-2.5 h-2.5 rounded-full bg-warning/60" />
								<span className="w-2.5 h-2.5 rounded-full bg-ut/60" />
								<span className="ml-3 text-xs text-white/25">example.ts</span>
							</div>
							{/* Code */}
							<pre className="p-5 text-sm font-mono leading-relaxed overflow-x-auto">
								<code>
									<span className="text-mem">import</span> <span className="text-white">{"{"}</span>{" "}
									<span className="text-white">trust</span>{" "}
									<span className="text-white">{"}"}</span> <span className="text-mem">from</span>{" "}
									<span className="text-ut">{'"usertrust"'}</span>
									{"\n"}
									<span className="text-mem">import</span>{" "}
									<span className="text-white">Anthropic</span>{" "}
									<span className="text-mem">from</span>{" "}
									<span className="text-ut">{'"@anthropic-ai/sdk"'}</span>
									{"\n\n"}
									<span className="text-white/30">
										{"// Your keys. Your billing. Now trusted."}
									</span>
									{"\n"}
									<span className="text-mem">const</span> <span className="text-white">client</span>{" "}
									<span className="text-white">=</span> <span className="text-mem">await</span>{" "}
									<span className="text-tim">trust</span>
									<span className="text-white">(</span>
									<span className="text-mem">new</span>{" "}
									<span className="text-white">Anthropic()</span>
									<span className="text-white">)</span>
									{"\n\n"}
									<span className="text-mem">const</span> <span className="text-white">{"{"}</span>{" "}
									<span className="text-white">response</span>
									<span className="text-white">,</span> <span className="text-white">receipt</span>{" "}
									<span className="text-white">{"}"}</span> <span className="text-white">=</span>{" "}
									<span className="text-mem">await</span> <span className="text-white">client</span>
									<span className="text-white">.</span>
									<span className="text-tim">messages.create</span>
									<span className="text-white">({"{"}</span>
									{"\n"}
									{"  "}
									<span className="text-white">model</span>
									<span className="text-white">:</span>{" "}
									<span className="text-ut">{'"claude-sonnet-4-20250514"'}</span>
									<span className="text-white">,</span>
									{"\n"}
									{"  "}
									<span className="text-white">messages</span>
									<span className="text-white">:</span> <span className="text-white">[{"{"}</span>{" "}
									<span className="text-white">role</span>
									<span className="text-white">:</span> <span className="text-ut">{'"user"'}</span>
									<span className="text-white">,</span> <span className="text-white">content</span>
									<span className="text-white">:</span> <span className="text-ut">{'"Hello"'}</span>{" "}
									<span className="text-white">{"}]"}</span>
									{"\n"}
									<span className="text-white">{"})"}</span>
									{"\n\n"}
									<span className="text-white">receipt</span>
									<span className="text-white">.</span>
									<span className="text-white">auditHash</span>
									{"       "}
									<span className="text-white/30">{"// SHA-256 hash-chained audit link"}</span>
									{"\n"}
									<span className="text-white">receipt</span>
									<span className="text-white">.</span>
									<span className="text-white">cost</span>
									{"            "}
									<span className="text-white/30">{"// 0.0032"}</span>
									{"\n"}
									<span className="text-white">receipt</span>
									<span className="text-white">.</span>
									<span className="text-white">settled</span>
									{"         "}
									<span className="text-white/30">{"// true"}</span>
									{"\n"}
									<span className="text-white">receipt</span>
									<span className="text-white">.</span>
									<span className="text-white">model</span>
									{"           "}
									<span className="text-white/30">{'// "claude-sonnet-4-20250514"'}</span>
								</code>
							</pre>
						</div>
					</ScrollReveal>
				</div>
			</div>
		</section>
	);
}
