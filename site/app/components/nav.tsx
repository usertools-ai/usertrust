"use client";

import { useEffect, useRef, useState } from "react";
import { GitHubIcon } from "./github-icon";

export function Nav() {
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

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

	const links = [
		{ href: "#code", label: "Code" },
		{ href: "#features", label: "Features" },
		{ href: "#how", label: "How it works" },
		{ href: "/docs", label: "Docs" },
	];

	return (
		<nav className="fixed top-0 left-0 right-0 z-50 bg-brand-bg/80 backdrop-blur-[16px] border-b border-white/[0.06]">
			<div className="flex items-center justify-between px-6 py-4">
				<a
					href="/"
					className="inline-flex items-center px-4 py-2.5 border border-white/20 rounded-full text-sm font-medium tracking-tight hover:border-ut/50 hover:text-ut transition-colors duration-200"
				>
					usertrust
				</a>

				<div className="flex items-center gap-6">
					<div className="hidden md:flex items-center gap-5 text-sm text-white/60 font-medium">
						{links.map((link) => (
							<a
								key={link.href}
								href={link.href}
								className="hover:text-white transition-colors duration-200"
							>
								{link.label}
							</a>
						))}
					</div>

					<a
						href="https://github.com/usertools-ai/usertrust"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium hover:bg-white/[0.10] hover:border-white/20 transition-all duration-200"
					>
						<GitHubIcon className="w-4 h-4" />
						GitHub
					</a>

					{/* Hamburger — mobile only */}
					<button
						ref={buttonRef}
						type="button"
						onClick={() => setOpen((prev) => !prev)}
						className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg border border-white/10 bg-white/[0.06] hover:bg-white/[0.10] transition-colors duration-200"
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
								className="block px-3 py-2.5 text-sm text-white/60 font-medium rounded-lg hover:text-white hover:bg-white/[0.06] transition-colors duration-200"
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
