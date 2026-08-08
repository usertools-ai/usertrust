"use client";

import { useEffect, useRef, useState } from "react";
import { GitHubIcon } from "./github-icon";

// "1.2k"-style compact mono counter. Trailing ".0" is dropped (1.0k -> 1k).
function fmtCompact(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function Nav({ stars, downloads }: { stars: number | null; downloads: number | null }) {
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

	// Close on outside click
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
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	/*
	 * Lock the page behind the open menu. Without this the body scrolls under the
	 * dropdown on iOS and the menu appears to drift; the `[overscroll-behavior:contain]`
	 * on the dropdown stops the scroll chaining back to the body once the menu's own
	 * list hits its end. The previous inline value is restored rather than cleared, so
	 * a lock owned by something else outlives this one.
	 */
	useEffect(() => {
		if (!open) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previous;
		};
	}, [open]);

	/*
	 * Close on the way up to desktop. The dropdown is `md:hidden`, so crossing the
	 * breakpoint while open hides the menu but leaves `open` true — and with it the body
	 * scroll lock, on a viewport with no visible way to release it.
	 */
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => {
			if (e.matches) setOpen(false);
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	/*
	 * Escape closes, and focus returns to the button that opened it — otherwise a
	 * keyboard user who dismisses the menu is left with focus on a removed node and
	 * tabbing restarts from the top of the document.
	 */
	useEffect(() => {
		if (!open) return;
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				setOpen(false);
				buttonRef.current?.focus();
			}
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [open]);

	// Addendum F (2026-08-08): the film section was dropped — no #film link.
	const links = [
		{ href: "#docket", label: "the docket" },
		{ href: "#exhibit-a", label: "exhibits" },
		{ href: "/docs", label: "docs" },
	];

	return (
		<nav
			className={`fixed top-0 left-0 right-0 z-50 border-b transition-all duration-300 ${
				scrolled
					? "bg-brand-bg/60 backdrop-blur-[20px] border-white/[0.10]"
					: "bg-brand-bg/80 backdrop-blur-[16px] border-white/[0.06]"
			}`}
		>
			<div className="flex items-center justify-between safe-x py-4">
				<div className="flex items-center gap-4">
					{/*
					 * First focusable element on the page: the dossier's escape hatch for
					 * people who came for numbers, not scenography. Visually subtle mono;
					 * focus-visible makes it prominent (the shared .focus-ring outline plus
					 * a color flip to emerald).
					 */}
					<a
						href="#docket"
						className="focus-ring inline-flex min-h-[44px] items-center font-mono text-xs text-white/70 hover:text-white focus-visible:text-ut transition-colors duration-200"
					>
						skip to the facts ↓
					</a>
					<a
						href="/"
						className={`focus-ring inline-flex min-h-[44px] items-center px-4 py-2.5 border rounded-full text-sm font-medium tracking-tight transition-all duration-300 ${
							scrolled
								? "border-ut/30 text-ut shadow-[0_0_20px_rgba(52,211,153,0.1)]"
								: "border-white/20 hover:border-ut/50 hover:text-ut"
						}`}
					>
						usertrust
					</a>
				</div>

				<div className="flex items-center gap-6">
					<div className="hidden md:flex items-center gap-5 text-sm text-white/70 font-medium">
						{links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								className={`focus-ring relative inline-flex min-h-[44px] items-center hover:text-white transition-colors duration-200 ${
									activeSection === link.href ? "text-ut" : ""
								}`}
							>
								{link.label}
								{activeSection === link.href && (
									/*
									 * `bottom-1.5`, not `-bottom-1.5`: the link box is 44px tall for the
									 * touch target while its text line is only 20px, so an offset measured
									 * outside the box lands 12px below the label instead of under it. This
									 * value is tied to the `min-h-[44px]` above — change one and the dot
									 * detaches from the word it marks.
									 */
									<span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-ut" />
								)}
							</a>
						))}
					</div>

					{/* Mono counters — omitted entirely on fetch failure, never rendered as 0. */}
					{(stars !== null || downloads !== null) && (
						<div className="hidden lg:flex items-center gap-4 font-mono text-xs text-white/70">
							{stars !== null && (
								<a
									href="https://github.com/usertools-ai/usertrust"
									target="_blank"
									rel="noopener noreferrer"
									className="focus-ring inline-flex min-h-[44px] items-center hover:text-white/80 transition-colors duration-200"
								>
									★ {fmtCompact(stars)}
								</a>
							)}
							{downloads !== null && (
								<a
									href="https://www.npmjs.com/package/usertrust"
									target="_blank"
									rel="noopener noreferrer"
									className="focus-ring inline-flex min-h-[44px] items-center hover:text-white/80 transition-colors duration-200"
								>
									↓ {fmtCompact(downloads)}/mo
								</a>
							)}
						</div>
					)}

					<a
						href="https://github.com/usertools-ai/usertrust"
						target="_blank"
						rel="noopener noreferrer"
						className="focus-ring inline-flex min-h-[44px] items-center gap-2 px-3.5 py-1.5 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium hover:bg-white/[0.10] hover:border-white/20 transition-all duration-200"
					>
						<GitHubIcon className="w-4 h-4" />
						GitHub
					</a>

					{/* Hamburger — mobile only */}
					<button
						ref={buttonRef}
						type="button"
						onClick={() => setOpen((prev) => !prev)}
						className="focus-ring md:hidden inline-flex items-center justify-center w-11 h-11 rounded-lg border border-white/10 bg-white/[0.06] hover:bg-white/[0.10] transition-colors duration-200"
						aria-label={open ? "Close menu" : "Open menu"}
						aria-expanded={open}
						aria-controls={open ? "mobile-menu" : undefined}
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

			{/*
			 * Mobile dropdown. No `pb-4` here on purpose: `.safe-bottom` owns the bottom
			 * padding with a 1rem floor. `max-h` plus `overflow-y-auto` keep the menu
			 * reachable on short viewports, and `[overscroll-behavior:contain]` stops the
			 * inner scroll chaining out to the locked body.
			 */}
			{open && (
				<div
					ref={menuRef}
					id="mobile-menu"
					className="md:hidden safe-bottom safe-x border-t border-white/[0.06] bg-brand-bg/95 backdrop-blur-[16px] pt-2 [overscroll-behavior:contain] max-h-[calc(100dvh-4.81rem)] overflow-y-auto"
				>
					<div className="flex flex-col gap-1">
						{links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								onClick={() => setOpen(false)}
								className={`focus-ring flex min-h-[44px] items-center px-3 py-2.5 text-sm font-medium rounded-lg hover:text-white hover:bg-white/[0.06] transition-colors duration-200 ${
									activeSection === link.href ? "text-ut" : "text-white/70"
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
