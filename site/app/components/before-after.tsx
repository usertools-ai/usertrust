"use client";

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
	/** Whether this line is a "diff addition" — highlighted in the After panel */
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
		<div
			className={`rounded-xl border overflow-hidden ${
				isBefore ? "border-white/[0.06] opacity-50" : "border-ut/40"
			}`}
			style={{
				background: isBefore ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.03)",
				...(isBefore
					? {}
					: { boxShadow: "0 0 40px rgba(52,211,153,0.12), 0 0 80px rgba(52,211,153,0.06)" }),
			}}
		>
			{/* Window chrome */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
				<div className="flex items-center gap-1.5">
					<span className="w-2.5 h-2.5 rounded-full bg-danger/60" />
					<span className="w-2.5 h-2.5 rounded-full bg-warning/60" />
					<span className="w-2.5 h-2.5 rounded-full bg-ut/60" />
					<span className="ml-3 text-xs text-white/25">{filename}</span>
				</div>
				<span
					className={`text-[10px] font-semibold uppercase tracking-wider ${
						isBefore ? "text-white/25" : "text-ut"
					}`}
				>
					{label}
				</span>
			</div>

			{/* Code lines */}
			<pre className="p-5 text-sm font-mono leading-relaxed overflow-x-auto">
				<code>
					{lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static constant array
						<span key={`line-${i}`} className="flex">
							{line.added && !isBefore ? (
								<span className="w-1 shrink-0 rounded-full bg-ut mr-3" />
							) : (
								<span className="w-1 shrink-0 mr-3" />
							)}
							<span
								className={line.added && !isBefore ? "bg-ut/[0.10] -mx-1 px-1 rounded" : undefined}
							>
								{line.tokens.length > 0 ? renderTokens(line.tokens) : "\u00A0"}
							</span>
						</span>
					))}
				</code>
			</pre>
		</div>
	);
}

export function BeforeAfter() {
	return (
		<section className="relative py-24 sm:py-32 px-6">
			<div className="max-w-5xl mx-auto">
				{/* Section header */}
				<div className="text-center mb-14">
					<ScrollReveal>
						<p className="text-xs font-medium text-ut uppercase tracking-widest mb-4">
							Before &amp; After
						</p>
					</ScrollReveal>
					<ScrollReveal delay={0.1}>
						<h2 className="text-3xl sm:text-4xl font-bold leading-tight">
							One import. One wrapper.
						</h2>
					</ScrollReveal>
					<ScrollReveal delay={0.2}>
						<p className="text-base text-white/60 mt-4 max-w-xl mx-auto">
							Everything else stays the same.
						</p>
					</ScrollReveal>
				</div>

				{/* Code panels */}
				<div className="grid lg:grid-cols-2 gap-6 lg:gap-8">
					<ScrollReveal delay={0.15}>
						<CodePanel
							lines={BEFORE_LINES}
							label="Without usertrust"
							filename="before.ts"
							variant="before"
						/>
					</ScrollReveal>
					<ScrollReveal delay={0.25}>
						<CodePanel
							lines={AFTER_LINES}
							label="With usertrust"
							filename="after.ts"
							variant="after"
						/>
					</ScrollReveal>
				</div>
			</div>
		</section>
	);
}
