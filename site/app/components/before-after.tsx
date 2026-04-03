"use client";

import { AnimatePresence, motion, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ScrollReveal } from "./scroll-reveal";

const C = {
	kw: "text-mem",
	str: "text-ut",
	fn: "text-tim",
	txt: "text-white",
	dim: "text-white/30",
};

interface Token {
	text: string;
	color: string;
}

type Line = Token[];

interface CodeLine {
	tokens: Line;
	added?: boolean;
}

const BEFORE_LINES: CodeLine[] = [
	{
		tokens: [
			{ text: "import", color: C.kw },
			{ text: " Anthropic ", color: C.txt },
			{ text: "from", color: C.kw },
			{ text: ' "@anthropic-ai/sdk"', color: C.str },
		],
	},
	{ tokens: [] },
	{
		tokens: [
			{ text: "const", color: C.kw },
			{ text: " client = ", color: C.txt },
			{ text: "new", color: C.kw },
			{ text: " Anthropic()", color: C.txt },
		],
	},
	{ tokens: [] },
	{
		tokens: [
			{ text: "const", color: C.kw },
			{ text: " response = ", color: C.txt },
			{ text: "await", color: C.kw },
			{ text: " client.", color: C.txt },
			{ text: "messages.create", color: C.fn },
			{ text: "({", color: C.txt },
		],
	},
	{
		tokens: [
			{ text: "  model: ", color: C.txt },
			{ text: '"claude-sonnet-4-6"', color: C.str },
			{ text: ",", color: C.txt },
		],
	},
	{
		tokens: [
			{ text: "  max_tokens: ", color: C.txt },
			{ text: "1024", color: C.fn },
			{ text: ",", color: C.txt },
		],
	},
	{
		tokens: [
			{ text: "  messages: [{ role: ", color: C.txt },
			{ text: '"user"', color: C.str },
			{ text: ", content: prompt }]", color: C.txt },
		],
	},
	{ tokens: [{ text: "})", color: C.txt }] },
	{ tokens: [] },
	{ tokens: [{ text: "// No budget. No audit. No limits.", color: C.dim }] },
	{ tokens: [{ text: "// Hope for the best.", color: C.dim }] },
	{ tokens: [] },
	{ tokens: [] },
];

const AFTER_LINES: CodeLine[] = [
	{
		tokens: [
			{ text: "import", color: C.kw },
			{ text: " Anthropic ", color: C.txt },
			{ text: "from", color: C.kw },
			{ text: ' "@anthropic-ai/sdk"', color: C.str },
		],
	},
	{
		added: true,
		tokens: [
			{ text: "import", color: C.kw },
			{ text: " { ", color: C.txt },
			{ text: "trust", color: C.fn },
			{ text: " } ", color: C.txt },
			{ text: "from", color: C.kw },
			{ text: ' "usertrust"', color: C.str },
		],
	},
	{ tokens: [] },
	{
		added: true,
		tokens: [
			{ text: "const", color: C.kw },
			{ text: " client = ", color: C.txt },
			{ text: "await", color: C.kw },
			{ text: " ", color: C.txt },
			{ text: "trust", color: C.fn },
			{ text: "(", color: C.txt },
			{ text: "new", color: C.kw },
			{ text: " Anthropic())", color: C.txt },
		],
	},
	{ tokens: [] },
	{
		added: true,
		tokens: [
			{ text: "const", color: C.kw },
			{ text: " { response, receipt } =", color: C.txt },
		],
	},
	{
		added: true,
		tokens: [
			{ text: "  ", color: C.txt },
			{ text: "await", color: C.kw },
			{ text: " client.", color: C.txt },
			{ text: "messages.create", color: C.fn },
			{ text: "({", color: C.txt },
		],
	},
	{
		tokens: [
			{ text: "  model: ", color: C.txt },
			{ text: '"claude-sonnet-4-6"', color: C.str },
			{ text: ",", color: C.txt },
		],
	},
	{
		tokens: [
			{ text: "  max_tokens: ", color: C.txt },
			{ text: "1024", color: C.fn },
			{ text: ",", color: C.txt },
		],
	},
	{
		tokens: [
			{ text: "  messages: [{ role: ", color: C.txt },
			{ text: '"user"', color: C.str },
			{ text: ", content: prompt }]", color: C.txt },
		],
	},
	{ tokens: [{ text: "})", color: C.txt }] },
	{ tokens: [] },
	{
		added: true,
		tokens: [{ text: "// Budget held. Audit logged. Policy checked.", color: "text-ut/60" }],
	},
	{
		added: true,
		tokens: [{ text: "// receipt.settled === true", color: "text-ut/60" }],
	},
];

function renderTokens(tokens: Token[]) {
	return tokens.map((t, i) => (
		<span key={`${t.text}-${i}`} className={t.color}>
			{t.text}
		</span>
	));
}

function CodePanel({
	lines,
	label,
	filename,
	variant,
}: {
	lines: CodeLine[];
	label: string;
	filename: string;
	variant: "before" | "after";
}) {
	const isBefore = variant === "before";

	return (
		<div className="h-full flex flex-col">
			{/* Window chrome */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
				<div className="flex items-center gap-1.5">
					<span className="w-2.5 h-2.5 rounded-full bg-danger/60" />
					<span className="w-2.5 h-2.5 rounded-full bg-warning/60" />
					<span className="w-2.5 h-2.5 rounded-full bg-ut/60" />
					<span className="ml-3 text-xs text-white/30">{filename}</span>
				</div>
				<span
					className={`text-[10px] font-bold uppercase tracking-wider ${
						isBefore ? "text-danger/60" : "text-ut"
					}`}
				>
					{label}
				</span>
			</div>

			{/* Code lines */}
			<div className="flex flex-1">
				<div className="shrink-0 py-3 sm:py-5 pl-3 sm:pl-5 pr-2 text-right select-none border-r border-white/[0.04]">
					{lines.map((_, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static line numbers
						<div key={i} className="text-xs sm:text-sm leading-relaxed text-white/15">
							{i + 1}
						</div>
					))}
				</div>
				<pre className="py-3 sm:py-5 px-3 sm:px-5 text-xs sm:text-sm font-mono leading-relaxed overflow-x-hidden flex-1">
					<code>
						{lines.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static code lines
							<span key={i} className="flex">
								{line.added && !isBefore ? (
									<span className="w-1 shrink-0 rounded-full bg-ut mr-3" />
								) : (
									<span className="w-1 shrink-0 mr-3" />
								)}
								<span
									className={
										line.added && !isBefore ? "bg-ut/[0.08] -mx-1 px-1 rounded" : undefined
									}
								>
									{line.tokens.length > 0 ? renderTokens(line.tokens) : "\u00A0"}
								</span>
							</span>
						))}
					</code>
				</pre>
			</div>

			{/* Status bar */}
			<div
				className={`flex items-center justify-between px-4 py-2 border-t border-white/[0.04] text-[10px] ${
					isBefore ? "text-white/20" : "text-ut/40"
				}`}
			>
				<span>{isBefore ? "No governance" : "Fully governed"}</span>
				<span className="flex items-center gap-1.5">
					{isBefore ? (
						<>
							<span className="w-1.5 h-1.5 rounded-full bg-danger/40" />
							Unprotected
						</>
					) : (
						<>
							<span className="w-1.5 h-1.5 rounded-full bg-ut animate-pulse" />
							Protected
						</>
					)}
				</span>
			</div>
		</div>
	);
}

export function BeforeAfter() {
	const sectionRef = useRef<HTMLDivElement>(null);
	const inView = useInView(sectionRef, { once: true, amount: 0.2 });
	const [showAfter, setShowAfter] = useState(false);

	// Auto-flip from Before to After after 2s of being in view
	useEffect(() => {
		if (!inView) return;
		const timer = setTimeout(() => setShowAfter(true), 2000);
		return () => clearTimeout(timer);
	}, [inView]);

	return (
		<section className="relative py-24 sm:py-32 px-6">
			<div className="max-w-5xl mx-auto" ref={sectionRef}>
				{/* Section header */}
				<div className="text-center mb-14">
					<ScrollReveal>
						<p className="text-xs font-medium text-ut uppercase tracking-widest mb-4">
							Before &amp; After
						</p>
					</ScrollReveal>
					<ScrollReveal delay={0.1}>
						<h2
							className="text-3xl sm:text-4xl font-bold leading-tight"
							style={{ textShadow: "0 0 40px rgba(52,211,153,0.08)" }}
						>
							One import. One wrapper.
						</h2>
					</ScrollReveal>
					<ScrollReveal delay={0.2}>
						<p className="text-base text-white/60 mt-4 max-w-xl mx-auto">
							Everything else stays the same.
						</p>
					</ScrollReveal>
				</div>

				{/* Animated toggle pills */}
				<ScrollReveal delay={0.3}>
					<div className="flex items-center justify-center gap-2 mb-8">
						<button
							type="button"
							onClick={() => setShowAfter(false)}
							className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-300 ${
								!showAfter
									? "bg-danger/10 border border-danger/30 text-danger/80 shadow-[0_0_20px_rgba(239,68,68,0.1)]"
									: "border border-white/[0.06] text-white/30 hover:text-white/50"
							}`}
						>
							Before
						</button>
						<motion.span
							animate={{ x: showAfter ? 4 : -4 }}
							transition={{ type: "spring", stiffness: 300, damping: 20 }}
							className="text-white/20 text-lg"
						>
							→
						</motion.span>
						<button
							type="button"
							onClick={() => setShowAfter(true)}
							className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-300 ${
								showAfter
									? "bg-ut/10 border border-ut/30 text-ut shadow-[0_0_20px_rgba(52,211,153,0.1)]"
									: "border border-white/[0.06] text-white/30 hover:text-white/50"
							}`}
						>
							After
						</button>
					</div>
				</ScrollReveal>

				{/* Single panel with crossfade */}
				<div className="max-w-2xl mx-auto">
					<AnimatePresence mode="wait">
						{!showAfter ? (
							<motion.div
								key="before"
								initial={{ opacity: 0, scale: 0.97, y: 10 }}
								animate={{ opacity: 1, scale: 1, y: 0 }}
								exit={{ opacity: 0, scale: 1.02, filter: "brightness(2)" }}
								transition={{ duration: 0.5, ease: "easeInOut" }}
								className="relative rounded-xl border border-danger/20 overflow-hidden"
								style={{
									background: "rgba(239,68,68,0.02)",
									boxShadow: "0 0 30px rgba(239,68,68,0.06)",
								}}
							>
								{/* Scanning line */}
								<div className="absolute inset-0 pointer-events-none" style={{ zIndex: 2 }}>
									<div
										className="absolute left-0 right-0 h-px animate-[scan_3s_ease-in-out_infinite]"
										style={{
											background:
												"linear-gradient(90deg, transparent, rgba(239,68,68,0.3), transparent)",
											boxShadow: "0 0 15px rgba(239,68,68,0.2)",
										}}
									/>
								</div>
								<CodePanel
									lines={BEFORE_LINES}
									label="Without usertrust"
									filename="before.ts"
									variant="before"
								/>
							</motion.div>
						) : (
							<motion.div
								key="after"
								initial={{ opacity: 0, scale: 0.97, y: 10 }}
								animate={{ opacity: 1, scale: 1, y: 0 }}
								exit={{ opacity: 0, scale: 0.97, y: -10 }}
								transition={{ duration: 0.4, ease: "easeInOut" }}
								className="relative rounded-xl border border-ut/20"
								style={{
									background: "rgba(52,211,153,0.03)",
									boxShadow:
										"0 0 40px rgba(52,211,153,0.15), 0 0 80px rgba(52,211,153,0.08), 0 0 120px rgba(52,211,153,0.04)",
								}}
							>
								<div className="relative" style={{ zIndex: 3 }}>
									<CodePanel
										lines={AFTER_LINES}
										label="With usertrust"
										filename="after.ts"
										variant="after"
									/>
								</div>
							</motion.div>
						)}
					</AnimatePresence>
				</div>
			</div>
		</section>
	);
}
