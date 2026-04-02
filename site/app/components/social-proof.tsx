"use client";

import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";

function AnimatedNumber({ target, suffix = "" }: { target: number; suffix?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref, { once: true });
	const [value, setValue] = useState(0);

	useEffect(() => {
		if (!inView) return;
		let start = 0;
		const duration = 1200;
		const startTime = performance.now();

		function tick(now: number) {
			const elapsed = now - startTime;
			const progress = Math.min(elapsed / duration, 1);
			// Ease out cubic
			const eased = 1 - (1 - progress) ** 3;
			start = Math.round(eased * target);
			setValue(start);
			if (progress < 1) requestAnimationFrame(tick);
		}

		requestAnimationFrame(tick);
	}, [inView, target]);

	return (
		<span ref={ref} className="font-mono text-2xl sm:text-3xl font-bold text-white tabular-nums">
			{value.toLocaleString()}
			{suffix}
		</span>
	);
}

const stats = [
	{ value: 0, suffix: "", label: "Dependencies", display: "0" },
	{ value: 100, suffix: "%", label: "TypeScript" },
	{ value: 30, suffix: "s", label: "Setup time" },
	{ value: 20, suffix: "+", label: "Models supported" },
];

export function SocialProof() {
	return (
		<section className="relative py-12 sm:py-16 px-6">
			<div className="max-w-4xl mx-auto">
				<div className="grid grid-cols-2 md:grid-cols-4 gap-6 sm:gap-8">
					{stats.map((stat) => (
						<div key={stat.label} className="flex flex-col items-center gap-1.5 text-center">
							{stat.display !== undefined ? (
								<span className="relative inline-flex items-center justify-center">
									<span
										className="absolute inset-0 rounded-full glow-ring"
										style={{ margin: "-8px" }}
									/>
									<span className="font-mono text-2xl sm:text-3xl font-bold text-ut tabular-nums">
										{stat.display}
									</span>
								</span>
							) : (
								<AnimatedNumber target={stat.value} suffix={stat.suffix} />
							)}
							<span className="text-xs text-white/40 uppercase tracking-wider">{stat.label}</span>
						</div>
					))}
				</div>
				{/* Subtle bottom divider */}
				<div className="mt-12 sm:mt-16 h-px bg-gradient-to-r from-transparent via-ut/10 to-transparent" />
			</div>
		</section>
	);
}
