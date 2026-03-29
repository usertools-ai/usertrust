"use client";

import { motion, useScroll, useTransform } from "motion/react";
import Image from "next/image";
import { useRef } from "react";
import { CopyCommand } from "./copy-command";

export function Hero() {
	const sectionRef = useRef<HTMLElement>(null);

	const { scrollYProgress } = useScroll({
		target: sectionRef,
		offset: ["start start", "50vh start"],
	});

	const bgOpacity = useTransform(scrollYProgress, [0, 1], [1, 0]);

	return (
		<section
			ref={sectionRef}
			className="relative min-h-screen flex flex-col items-center justify-start text-center px-6 pt-[18vh]"
			style={{ zIndex: 1 }}
		>
			{/* Bliss background — scroll-fades */}
			<motion.div
				className="hero-bg absolute inset-0 overflow-hidden"
				style={{
					animation: "kenburns 20s ease-in-out infinite alternate",
					opacity: bgOpacity,
				}}
				aria-hidden="true"
			>
				<Image
					src="/bliss.jpg"
					alt=""
					fill
					priority
					sizes="100vw"
					className="object-cover object-center"
				/>
			</motion.div>

			{/* Hero content — glass pane */}
			<div
				className="relative z-10 max-w-3xl mx-auto flex flex-col items-center gap-6 px-8 py-10 sm:px-12 sm:py-14 rounded-2xl border border-white/[0.08]"
				style={{
					background: "rgba(10,10,26,0.35)",
					backdropFilter: "blur(24px)",
					WebkitBackdropFilter: "blur(24px)",
					boxShadow: "0 0 80px rgba(10,10,26,0.3)",
				}}
			>
				{/* Badge */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, ease: "easeOut", delay: 0 }}
					className="inline-flex items-center gap-2 px-4 py-1.5 bg-ut/10 border border-ut/30 rounded-full text-ut text-xs font-medium tracking-wide"
				>
					Open source · Apache 2.0
				</motion.div>

				{/* Headline */}
				<h1 className="flex flex-col items-center gap-1">
					<motion.span
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
						className="text-6xl sm:text-7xl md:text-8xl font-bold text-ut leading-none tracking-tight"
						style={{
							textShadow:
								"0 0 60px rgba(52,211,153,0.4), 0 0 120px rgba(52,211,153,0.15), 0 0 80px rgba(0,0,0,0.8), 0 4px 40px rgba(0,0,0,0.6)",
						}}
					>
						trust()
					</motion.span>
					<motion.span
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
						className="text-4xl sm:text-5xl md:text-6xl font-bold text-white leading-tight"
						style={{
							textShadow: "0 0 80px rgba(0,0,0,0.8), 0 4px 40px rgba(0,0,0,0.6)",
						}}
					>
						your AI spend
					</motion.span>
				</h1>

				{/* Subhead */}
				<motion.p
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, ease: "easeOut", delay: 0.32 }}
					className="max-w-lg text-base sm:text-lg text-white/60 leading-relaxed"
				>
					Budget holds, audit trails, and spend limits for every LLM call. Keep your keys, keep your
					billing. Add trust in one line.
				</motion.p>

				{/* Install command */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, ease: "easeOut", delay: 0.44 }}
					className="w-full max-w-md"
				>
					<CopyCommand />
				</motion.div>

				{/* CTA links */}
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, ease: "easeOut", delay: 0.54 }}
					className="flex flex-wrap items-center justify-center gap-3"
				>
					<a
						href="#code"
						className="inline-flex items-center gap-2 px-5 py-2.5 bg-ut text-brand-bg rounded-lg text-sm font-semibold hover:bg-ut/90 active:scale-[0.98] transition-all duration-150"
					>
						See the code
					</a>
					<a
						href="https://github.com/usertools-ai/usertrust"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium text-white/80 hover:bg-white/[0.10] hover:text-white transition-all duration-150"
					>
						View on GitHub
					</a>
				</motion.div>
			</div>
		</section>
	);
}
