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
				/*
				 * The scrolled bar used to be MORE transparent (60%) than the
				 * top-of-page bar (80%), and the fixed bar passes over the one light
				 * surface on the page — the open-ledger receipt paper (#f2efe6),
				 * which spans x352-928 at 1280 and nearly the full width at 390.
				 * Over that composite ground, white/70 nav text falls to ~3.7:1 and
				 * text-ut to ~2.95:1, both under the 4.5:1 floor. 85% restores
				 * white/70 to ~7.4:1 and text-ut to ~7.1:1 while keeping the blur.
				 */
				scrolled
					? "bg-brand-bg/85 backdrop-blur-[20px] border-white/[0.10]"
					: "bg-brand-bg/80 backdrop-blur-[16px] border-white/[0.06]"
			}`}
		>
			{/*
			 * A gap plus the min-w-0/shrink discipline below (Addendum O2). The bar is
			 * one flex row of two clusters, and NOTHING in it used to yield: every
			 * child sized to its content, so the instant the two clusters together
			 * exceeded the track the row overflowed to the right and the GitHub CTA
			 * — the last child — was pushed past the safe-x edge with its label cut
			 * off. Reproduced by inflating the star counter: at 1280 the CTA landed
			 * 49px past the content edge reading "GitHu".
			 *
			 * The rule now: the COUNTERS are the only sacrificial element. They are
			 * the one decorative thing in the bar, so they get `min-w-0 shrink` and
			 * clip themselves; the nav links, the CTA and the hamburger are all
			 * `shrink-0`, so the CTA is structurally incapable of losing a pixel.
			 *
			 * The gap is `gap-2 md:gap-4`, not a flat gap-4: `justify-between`
			 * already separates the clusters and the gap only binds under pressure,
			 * which is exactly the phone widths where the track is scarcest — a flat
			 * 16px there spent the last pixel of slack at 390 and pushed the
			 * hamburger back over the edge.
			 *
			 * `py-4` is untouched — it is the summand in the 4.81rem mobile-menu
			 * max-h AND the I3 --anchor-offset, and this fix must not move either.
			 * Re-measured after: the bar is 77px at every width from 320 to 2000.
			 */}
			<div className="flex items-center justify-between gap-2 safe-x py-4 md:gap-4">
				<div className="flex min-w-0 items-center gap-4">
					{/*
					 * First focusable element on the page: the dossier's escape hatch for
					 * people who came for numbers, not scenography. Visually subtle mono;
					 * focus-visible makes it prominent (the shared .focus-ring outline plus
					 * a color flip to emerald).
					 */}
					{/*
					 * Two labels, one link. The full label wrapped to THREE lines at
					 * 390 ("skip to / the / facts ↓"), inflating the fixed bar to
					 * ~80px beside the pill/GitHub/hamburger row. Only one span is in
					 * the accessibility tree at a time (display:none hides the other
					 * from AT as well as from view), and the link stays first
					 * focusable at every width.
					 */}
					<a
						href="#docket"
						data-cursor-hover
						className="focus-ring inline-flex min-h-[44px] min-w-0 items-center overflow-hidden whitespace-nowrap font-mono text-xs text-white/70 hover:text-white focus-visible:text-ut transition-colors duration-200"
					>
						<span className="md:hidden">facts ↓</span>
						<span className="hidden md:inline">skip to the facts ↓</span>
					</a>
					<a
						href="/"
						data-cursor-hover
						className={`focus-ring inline-flex min-h-[44px] shrink-0 items-center px-4 py-2.5 border rounded-full text-sm font-medium tracking-tight transition-all duration-300 ${
							/*
							 * No glow: the old shadow-[0_0_20px_rgba(52,211,153,0.1)] was
							 * a fifth depth idiom beside lift-1/lift-2/glow-emerald/
							 * ground-zone (Addendum H3) and rendered no perceptible halo
							 * in any capture. border-ut/30 + text-ut already state the
							 * scrolled condition.
							 */
							scrolled ? "border-ut/30 text-ut" : "border-white/20 hover:border-ut/50 hover:text-ut"
						}`}
					>
						usertrust
					</a>
				</div>

				<div className="flex min-w-0 items-center gap-6">
					<div className="hidden md:flex shrink-0 items-center gap-5 text-sm text-white/70 font-medium">
						{links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								data-cursor-hover
								className={`focus-ring relative inline-flex min-h-[44px] items-center whitespace-nowrap hover:text-white transition-colors duration-200 ${
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
						<div className="hidden lg:flex min-w-0 shrink items-center gap-4 overflow-hidden font-mono text-xs text-white/70">
							{stars !== null && (
								<a
									href="https://github.com/usertools-ai/usertrust"
									target="_blank"
									rel="noopener noreferrer"
									data-cursor-hover
									className="focus-ring inline-flex min-h-[44px] items-center whitespace-nowrap hover:text-white/80 transition-colors duration-200"
								>
									★ {fmtCompact(stars)}
								</a>
							)}
							{downloads !== null && (
								<a
									href="https://www.npmjs.com/package/usertrust"
									target="_blank"
									rel="noopener noreferrer"
									data-cursor-hover
									className="focus-ring inline-flex min-h-[44px] items-center whitespace-nowrap hover:text-white/80 transition-colors duration-200"
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
						data-cursor-hover
						className="focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap px-3.5 py-1.5 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium hover:bg-white/[0.10] hover:border-white/20 transition-all duration-200"
					>
						<GitHubIcon className="w-4 h-4" />
						GitHub
					</a>

					{/* Hamburger — mobile only */}
					<button
						ref={buttonRef}
						type="button"
						onClick={() => setOpen((prev) => !prev)}
						className="focus-ring md:hidden inline-flex shrink-0 items-center justify-center w-11 h-11 rounded-lg border border-white/10 bg-white/[0.06] hover:bg-white/[0.10] transition-colors duration-200"
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
			 *
			 * 4.81rem in the max-h calc is this nav's own rendered height, and it
			 * is a SUM, not a magic number: 44px link row (min-h-[44px]) + 2 x 16px
			 * (py-4) + 1px border-b = 77px = 4.81rem. globals.css's
			 * scroll-padding-top is derived from the same figure — change py-4 or
			 * the 44px target and both rules need re-measuring together.
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
