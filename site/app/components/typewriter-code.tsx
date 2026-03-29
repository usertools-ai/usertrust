"use client";

import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";

interface Token {
	text: string;
	color: string;
}

type Line = Token[];

const C = {
	kw: "text-mem",
	str: "text-ut",
	fn: "text-tim",
	txt: "text-white",
	dim: "text-white/30",
};

const CODE_LINES: Line[] = [
	[
		{ text: "import", color: C.kw },
		{ text: " { trust } ", color: C.txt },
		{ text: "from", color: C.kw },
		{ text: ' "usertrust"', color: C.str },
	],
	[
		{ text: "import", color: C.kw },
		{ text: " Anthropic ", color: C.txt },
		{ text: "from", color: C.kw },
		{ text: ' "@anthropic-ai/sdk"', color: C.str },
	],
	[],
	[{ text: "// Your keys. Your billing. Now trusted.", color: C.dim }],
	[
		{ text: "const", color: C.kw },
		{ text: " client = ", color: C.txt },
		{ text: "await", color: C.kw },
		{ text: " ", color: C.txt },
		{ text: "trust", color: C.fn },
		{ text: "(", color: C.txt },
		{ text: "new", color: C.kw },
		{ text: " Anthropic())", color: C.txt },
	],
	[],
	[
		{ text: "const", color: C.kw },
		{ text: " { response, receipt } =", color: C.txt },
	],
	[
		{ text: "  ", color: C.txt },
		{ text: "await", color: C.kw },
		{ text: " client.", color: C.txt },
		{ text: "messages.create", color: C.fn },
		{ text: "({", color: C.txt },
	],
	[
		{ text: "  model: ", color: C.txt },
		{ text: '"claude-sonnet-4-20250514"', color: C.str },
		{ text: ",", color: C.txt },
	],
	[
		{ text: "  messages: [{ role: ", color: C.txt },
		{ text: '"user"', color: C.str },
		{ text: ", content: ", color: C.txt },
		{ text: '"Hello"', color: C.str },
		{ text: " }]", color: C.txt },
	],
	[{ text: "})", color: C.txt }],
	[],
	[
		{ text: "receipt.auditHash", color: C.txt },
		{ text: "  // hash-chained", color: C.dim },
	],
	[
		{ text: "receipt.cost", color: C.txt },
		{ text: "       // 0.0032", color: C.dim },
	],
	[
		{ text: "receipt.settled", color: C.txt },
		{ text: "    // true", color: C.dim },
	],
	[
		{ text: "receipt.model", color: C.txt },
		{ text: "      // claude-sonnet", color: C.dim },
	],
];

function flattenLine(line: Line): { char: string; color: string }[] {
	const chars: { char: string; color: string }[] = [];
	for (const token of line) {
		for (const ch of token.text) {
			chars.push({ char: ch, color: token.color });
		}
	}
	return chars;
}

export function TypewriterCode() {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, margin: "0px 0px -80px 0px" });
	const [visibleChars, setVisibleChars] = useState(0);
	const [done, setDone] = useState(false);

	// Flatten all lines into a single char array with line breaks
	const allChars = useRef<{ char: string; color: string }[]>([]);
	if (allChars.current.length === 0) {
		for (let i = 0; i < CODE_LINES.length; i++) {
			const line = CODE_LINES[i] ?? [];
			allChars.current.push(...flattenLine(line));
			if (i < CODE_LINES.length - 1) {
				allChars.current.push({ char: "\n", color: "" });
			}
		}
	}

	const total = allChars.current.length;

	useEffect(() => {
		if (!inView || done) return;

		let i = 0;
		let timeout: ReturnType<typeof setTimeout>;

		function tick() {
			i++;
			setVisibleChars(i);
			if (i >= total) {
				setDone(true);
				return;
			}
			// Jitter: 8-16ms per char, instant for spaces/newlines
			const ch = allChars.current[i]?.char;
			const delay = ch === " " || ch === "\n" ? 2 : 8 + Math.random() * 8;
			timeout = setTimeout(tick, delay);
		}

		timeout = setTimeout(tick, 300); // initial delay after scroll
		return () => clearTimeout(timeout);
	}, [inView, done, total]);

	// Render visible characters
	const rendered = allChars.current.slice(0, visibleChars);

	return (
		<div ref={ref}>
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
				{/* Invisible full code reserves pane dimensions */}
				<div className="relative">
					<pre
						className="p-5 text-sm font-mono leading-relaxed overflow-x-auto invisible"
						aria-hidden="true"
					>
						<code>
							{allChars.current.map((c, i) =>
								c.char === "\n" ? <br key={`h${i}`} /> : <span key={`h${i}`}>{c.char}</span>,
							)}
						</code>
					</pre>
					{/* Visible typewriter overlay */}
					<pre className="p-5 text-sm font-mono leading-relaxed overflow-x-auto absolute inset-0">
						<code>
							{rendered.map((c, i) =>
								c.char === "\n" ? (
									<br key={`t${i}`} />
								) : (
									<span key={`t${i}`} className={c.color}>
										{c.char}
									</span>
								),
							)}
							{!done && (
								<span className="inline-block w-[2px] h-[1em] bg-ut/70 ml-px animate-pulse align-text-bottom" />
							)}
						</code>
					</pre>
				</div>
			</div>
		</div>
	);
}
