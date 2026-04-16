"use client";

import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ScrollReveal } from "./scroll-reveal";

const C = {
	key: "text-tim",
	str: "text-ut",
	num: "text-mem",
	bool: "text-warning",
	punct: "text-white/50",
	bracket: "text-white/40",
};

interface JsonToken {
	text: string;
	color: string;
}

function key(k: string): JsonToken[] {
	return [
		{ text: '"', color: C.punct },
		{ text: k, color: C.key },
		{ text: '"', color: C.punct },
		{ text: ": ", color: C.punct },
	];
}

function str(v: string): JsonToken[] {
	return [
		{ text: '"', color: C.punct },
		{ text: v, color: C.str },
		{ text: '"', color: C.punct },
	];
}

function num(v: string): JsonToken[] {
	return [{ text: v, color: C.num }];
}

function bool(v: string): JsonToken[] {
	return [{ text: v, color: C.bool }];
}

function punct(v: string): JsonToken[] {
	return [{ text: v, color: C.punct }];
}

function bracket(v: string): JsonToken[] {
	return [{ text: v, color: C.bracket }];
}

type ReceiptLine = JsonToken[];

const RECEIPT_LINES: ReceiptLine[] = [
	bracket("{"),
	[...key("transferId"), ...str("tx_m3k7p_a1b2c3"), ...punct(",")],
	[...key("model"), ...str("claude-sonnet-4-6"), ...punct(",")],
	[...key("status"), ...str("settled"), ...punct(",")],
	[...key("cost"), ...bracket("{")],
	[...key("estimated"), ...num("4200"), ...punct(",")],
	[...key("actual"), ...num("3847"), ...punct(",")],
	[...key("unit"), ...str("usertokens")],
	[...bracket("}"), ...punct(",")],
	[...key("audit"), ...bracket("{")],
	[...key("sequence"), ...num("42"), ...punct(",")],
	[...key("hash"), ...str("a1b2c3d4e5f6...7890"), ...punct(",")],
	[...key("chainValid"), ...bool("true")],
	[...bracket("}"), ...punct(",")],
	[...key("policy"), ...bracket("{")],
	[...key("evaluated"), ...num("3"), ...punct(",")],
	[...key("denied"), ...num("0"), ...punct(",")],
	[...key("warnings"), ...bracket("["), ...bracket("]")],
	[...bracket("}"), ...punct(",")],
	[...key("board"), ...bracket("{")],
	[...key("decision"), ...str("approved"), ...punct(",")],
	[
		...key("directors"),
		...bracket("["),
		...str("Alpha: APPROVE"),
		...punct(", "),
		...str("Beta: APPROVE"),
		...bracket("]"),
	],
	bracket("}"),
	bracket("}"),
];

// Indentation depths for each line
const INDENTS = [
	0, // {
	1, // transferId
	1, // model
	1, // status
	1, // cost: {
	2, // estimated
	2, // actual
	2, // unit
	1, // },
	1, // audit: {
	2, // sequence
	2, // hash
	2, // chainValid
	1, // },
	1, // policy: {
	2, // evaluated
	2, // denied
	2, // warnings
	1, // },
	1, // board: {
	2, // decision
	2, // directors
	1, // }
	0, // }
];

function renderLine(tokens: JsonToken[]) {
	return tokens.map((t, i) => (
		<span key={`${t.text}-${i}`} className={t.color}>
			{t.text}
		</span>
	));
}

export function GovernanceReceipt() {
	const codeRef = useRef<HTMLDivElement>(null);
	const inView = useInView(codeRef, { once: true, amount: 0.3 });
	const [visibleLines, setVisibleLines] = useState(0);

	useEffect(() => {
		if (!inView) return;
		let i = 0;
		const total = RECEIPT_LINES.length;

		function tick() {
			i++;
			setVisibleLines(i);
			if (i < total) {
				setTimeout(tick, 40 + Math.random() * 40);
			}
		}

		setTimeout(tick, 400);
	}, [inView]);

	const done = visibleLines >= RECEIPT_LINES.length;

	return (
		<div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
			{/* Left: description */}
			<div className="flex flex-col gap-5 lg:order-2">
				<ScrollReveal>
					<p className="text-xs font-medium text-ut uppercase tracking-widest">
						Every call returns a receipt
					</p>
				</ScrollReveal>
				<ScrollReveal delay={0.1}>
					<h2 className="text-3xl sm:text-4xl font-bold leading-tight">What you get back.</h2>
				</ScrollReveal>
				<ScrollReveal delay={0.2}>
					<p className="text-base text-white/60 leading-relaxed">
						Every governed call returns a structured receipt with cost tracking, audit chain proof,
						policy evaluation, and board oversight&nbsp;&mdash; alongside the original LLM response.
					</p>
				</ScrollReveal>

				<ScrollReveal delay={0.3}>
					<ul className="flex flex-col gap-3 mt-2">
						<li className="flex items-start gap-3 text-sm text-white/60">
							<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
							Estimated vs actual cost in <code className="text-ut">usertokens</code>
						</li>
						<li className="flex items-start gap-3 text-sm text-white/60">
							<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
							SHA-256 hash-chained audit link for tamper detection
						</li>
						<li className="flex items-start gap-3 text-sm text-white/60">
							<span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ut shrink-0" />
							Policy and board decisions with full traceability
						</li>
					</ul>
				</ScrollReveal>
			</div>

			{/* Right: receipt JSON block */}
			<ScrollReveal delay={0.15} className="lg:order-1">
				<div
					ref={codeRef}
					className="rounded-xl border border-white/[0.08] overflow-hidden"
					style={{ background: "rgba(255,255,255,0.03)" }}
				>
					{/* Window chrome */}
					<div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
						<div className="flex items-center gap-1.5">
							<span className="w-2.5 h-2.5 rounded-full bg-danger/60" />
							<span className="w-2.5 h-2.5 rounded-full bg-warning/60" />
							<span className="w-2.5 h-2.5 rounded-full bg-ut/60" />
							<span className="ml-3 text-xs text-white/25">governance receipt</span>
						</div>
						{done && (
							<span className="text-[10px] text-ut/50 font-medium uppercase tracking-wider">
								settled
							</span>
						)}
					</div>

					<pre className="p-3 sm:p-5 text-xs sm:text-sm font-mono leading-relaxed overflow-x-auto">
						<code>
							{RECEIPT_LINES.map((line, i) => {
								const indent = INDENTS[i] ?? 0;
								const visible = i < visibleLines;
								return (
									<span
										// biome-ignore lint/suspicious/noArrayIndexKey: static constant array
										key={`line-${i}`}
										className={`transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
									>
										{i > 0 && <br />}
										{indent > 0 && (
											<span className="text-transparent select-none">{"  ".repeat(indent)}</span>
										)}
										{renderLine(line)}
										{!done && i === visibleLines - 1 && (
											<span className="inline-block w-[2px] h-[1em] bg-ut/70 ml-px animate-pulse align-text-bottom" />
										)}
									</span>
								);
							})}
						</code>
					</pre>
				</div>
			</ScrollReveal>
		</div>
	);
}
