"use client";

import { useEffect, useRef, useState } from "react";
import { GitHubIcon } from "./github-icon";

export function Nav() {
	const [open, setOpen] = useState(false);
	const [scrolled, setScrolled] = useState(false);
	const [activeSection, setActiveSection] = useState("");
	const menuRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	// Scroll detection
	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 20);
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	// Active section tracking
	useEffect(() => {
		const sections = document.querySelectorAll("section[id]");
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setActiveSection(`#${entry.target.id}`);
					}
				}
			},
			{ rootMargin: "-40% 0px -55% 0px" },
		);
		for (const section of sections) observer.observe(section);
		return () => observer.disconnect();
	}, []);

	// Close on outside click (and return focus to hamburger)
	useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				buttonRef.current &&
				!buttonRef.current.contains(e.target as Node)
			) {
				setOpen(false);
				buttonRef.current.focus();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	// Body scroll lock + Escape-to-close while mobile menu is open
	useEffect(() => {
		if (!open) return;
		const prevOverflow = document.body.style.overflow;
		const prevOverscroll = document.body.style.overscrollBehavior;
		document.body.style.overflow = "hidden";
		document.body.style.overscrollBehavior = "contain";
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				setOpen(false);
				buttonRef.current?.focus();
			}
		}
		document.addEventListener("keydown", handleKey);
		return () => {
			document.body.style.overflow = prevOverflow;
			document.body.style.overscrollBehavior = prevOverscroll;
			document.removeEventListener("keydown", handleKey);
		};
	}, [open]);

	const links = [
		{ href: "#code", label: "Code" },
		{ href: "#features", label: "Features" },
		{ href: "#how", label: "How it works" },
		{ href: "/docs", label: "Docs" },
	];

	return (
		<nav
			className={`safe-top fixed top-0 left-0 right-0 z-50 border-b transition-all duration-300 ${
				scrolled
					? "bg-brand-bg/60 backdrop-blur-[20px] border-white/[0.10]"
					: "bg-brand-bg/80 backdrop-blur-[16px] border-white/[0.06]"
			}`}
		>
			<div className="flex items-center justify-between px-6 py-4">
				<a
					href="/"
					className={`inline-flex items-center px-4 py-2.5 min-h-[44px] md:min-h-0 border rounded-full text-sm font-medium tracking-tight transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ut/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg ${
						scrolled
							? "border-ut/30 text-ut shadow-[0_0_20px_rgba(52,211,153,0.1)]"
							: "border-white/20 hover:border-ut/50 hover:text-ut animate-[pulse-glow_4s_ease-in-out_infinite]"
					}`}
				>
					usertrust
				</a>

				<div className="flex items-center gap-6">
					<div className="hidden md:flex items-center gap-5 text-sm text-white/60 font-medium">
						{links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								className={`relative hover:text-white transition-colors duration-200 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ut/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg ${
									activeSection === link.href ? "text-ut" : ""
								}`}
							>
								{link.label}
								{activeSection === link.href && (
									<span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-ut" />
								)}
							</a>
						))}
					</div>

					<a
						href="https://github.com/usertools-ai/usertrust"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-2 px-3.5 py-1.5 min-h-[44px] md:min-h-0 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium hover:bg-white/[0.10] hover:border-white/20 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ut/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg"
					>
						<GitHubIcon className="w-4 h-4" />
						GitHub
					</a>

					{/* Hamburger — mobile only */}
					<button
						ref={buttonRef}
						type="button"
						onClick={() => setOpen((prev) => !prev)}
						className="md:hidden inline-flex items-center justify-center w-11 h-11 rounded-lg border border-white/10 bg-white/[0.06] hover:bg-white/[0.10] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ut/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg"
						aria-label={open ? "Close menu" : "Open menu"}
						aria-expanded={open}
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 18 18"
							fill="none"
							className="text-white/80"
							aria-hidden="true"
						>
							{open ? (
								<>
									<line
										x1="4"
										y1="4"
										x2="14"
										y2="14"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
									/>
									<line
										x1="14"
										y1="4"
										x2="4"
										y2="14"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
									/>
								</>
							) : (
								<>
									<line
										x1="3"
										y1="5"
										x2="15"
										y2="5"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
									/>
									<line
										x1="3"
										y1="9"
										x2="15"
										y2="9"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
									/>
									<line
										x1="3"
										y1="13"
										x2="15"
										y2="13"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
									/>
								</>
							)}
						</svg>
					</button>
				</div>
			</div>

			{/* Mobile dropdown */}
			{open && (
				<div
					ref={menuRef}
					className="md:hidden border-t border-white/[0.06] bg-brand-bg/95 backdrop-blur-[16px] px-6 pb-4 pt-2"
				>
					<div className="flex flex-col gap-1">
						{links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								onClick={() => setOpen(false)}
								className={`block px-3 py-3 min-h-[44px] text-sm font-medium rounded-lg hover:text-white hover:bg-white/[0.06] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ut/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg ${
									activeSection === link.href ? "text-ut" : "text-white/60"
								}`}
							>
								{link.label}
							</a>
						))}
					</div>
				</div>
			)}
		</nav>
	);
}
