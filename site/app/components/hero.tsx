"use client";

import { AnimatePresence, motion, useScroll, useTransform } from "motion/react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { CopyCommand } from "./copy-command";

function usePackageStats() {
	const [downloads, setDownloads] = useState<string>("—");
	const [stars, setStars] = useState<string>("—");

	useEffect(() => {
		fetch("https://api.npmjs.org/downloads/point/last-month/usertrust")
			.then((r) => r.json())
			.then((d) => {
				const n = d.downloads as number;
				setDownloads(n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
			})
			.catch(() => {});

		fetch("https://api.github.com/repos/usertools-ai/usertrust")
			.then((r) => r.json())
			.then((d) => {
				const n = d.stargazers_count as number;
				setStars(n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
			})
			.catch(() => {});
	}, []);

	return { downloads, stars };
}

const taglines = [
	"Budget holds, audit trails, and spend limits for every LLM call.",
	"Your API keys. Your billing. Your provider. We add the trust layer.",
	"Like a credit card hold — but for AI spend. Settled or voided, never lost.",
	"Hash-chained receipts. Tamper-evident by construction. Zero vendor lock-in.",
];

export function Hero() {
	const sectionRef = useRef<HTMLElement>(null);
	const { downloads, stars } = usePackageStats();
	const [taglineIndex, setTaglineIndex] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setTaglineIndex((prev) => (prev + 1) % taglines.length);
		}, 4000);
		return () => clearInterval(interval);
	}, []);

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
				{/* Headline */}
				<h1 className="flex flex-col items-center gap-1">
					<motion.span
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
						className="font-mono text-6xl sm:text-7xl md:text-8xl font-bold text-ut leading-none tracking-tight"
						style={{
							textShadow:
								"0 0 60px rgba(52,211,153,0.5), 0 0 120px rgba(52,211,153,0.2), 0 0 80px rgba(0,0,0,0.8), 0 4px 40px rgba(0,0,0,0.6)",
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
					className="max-w-lg text-base sm:text-lg text-white/70 leading-relaxed h-[3.5em] sm:h-[3em] flex items-center justify-center"
				>
					<AnimatePresence mode="wait">
						<motion.span
							key={taglineIndex}
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -8 }}
							transition={{ duration: 0.4, ease: "easeInOut" }}
						>
							{taglines[taglineIndex]}
						</motion.span>
					</AnimatePresence>
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
						className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] bg-ut text-brand-bg rounded-lg text-sm font-semibold hover:bg-ut/90 active:scale-[0.98] transition-all duration-150 shadow-[0_0_20px_rgba(52,211,153,0.3),0_0_60px_rgba(52,211,153,0.1)]"
					>
						Start Trusting
					</a>
					<a
						href="https://github.com/usertools-ai/usertrust"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium text-white/80 hover:bg-white/[0.10] hover:text-white transition-all duration-150"
					>
						View on GitHub
					</a>
				</motion.div>

				{/* Badges + license — bottom of pane */}
				<div className="w-16 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.6, ease: "easeOut", delay: 0.64 }}
					className="flex flex-col items-center gap-3"
				>
					<div className="flex flex-wrap items-center justify-center gap-2">
						{[
							{
								label: "npm",
								value: "v1.2.2",
								logo: (
									<svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
										<path d="M0 0v16h16V0H0zm13 13H8V5H5v8H3V3h10v10z" />
									</svg>
								),
							},
							{
								label: "downloads",
								value: `${downloads}/mo`,
								logo: (
									<svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
										<path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75z" />
										<path d="M7.25 7.689V2a.75.75 0 011.5 0v5.689l1.97-1.969a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 6.78a.749.749 0 111.06-1.06l1.97 1.969z" />
									</svg>
								),
							},
							{
								label: "stars",
								value: stars,
								logo: (
									<svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden="true">
										<path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
									</svg>
								),
							},
						].map((badge) => (
							<span
								key={badge.label}
								className="inline-flex items-center rounded text-[11px] font-extrabold uppercase tracking-wider overflow-hidden"
							>
								<span className="bg-white text-black px-2 py-1 flex items-center gap-1.5">
									{badge.logo}
									{badge.label}
								</span>
								<span className="bg-ut text-black px-2 py-1">{badge.value}</span>
							</span>
						))}
					</div>
					<p className="text-[10px] text-white/25 tracking-wide">Open source · Apache 2.0</p>
				</motion.div>
			</div>
		</section>
	);
}
