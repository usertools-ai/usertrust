"use client";

import { track } from "@vercel/analytics";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard chip. Prints a paper "copied · $0.00" chit for 1.6s on
 * success and a visible "copy failed" chit when the Clipboard API rejects
 * (permissions policy, insecure context). Screen readers get an
 * aria-live="polite" announcement either way.
 */
export default function CopyChip({
	text,
	label,
	tone = "dark",
}: {
	text: string;
	label?: string;
	/**
	 * "dark" (default) is the original dark-ground styling (white/near-white
	 * on a translucent white fill) — every pre-existing call site (hero,
	 * exhibit E, exhibit G) renders on dark ground and is unaffected. "paper"
	 * swaps to ink-on-paper for placement inside ReceiptPaper: the dark
	 * styling reads at ~1.1:1 contrast on `--color-paper`, well under the
	 * ≥4.5:1 the paper surface requires (globals.css's validated paper-*
	 * accents), so it cannot be reused as-is there. Dim paper text (the "$"
	 * glyph and the "copy" label) uses ink at 64% opacity, matching
	 * globals.css's `.provenance-stub` convention (~5.1:1 on paper) rather
	 * than 50% (~3.3:1, under the bar).
	 */
	tone?: "dark" | "paper";
}) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);

	const handleCopy = useCallback(async () => {
		if (timer.current) clearTimeout(timer.current);
		try {
			await navigator.clipboard.writeText(text);
			track("copy", { label: label ?? text });
			setState("copied");
		} catch {
			setState("failed");
		}
		timer.current = setTimeout(() => setState("idle"), 1600);
	}, [text, label]);

	const isPaper = tone === "paper";
	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={`Copy ${label ?? text}`}
			className={
				isPaper
					? "focus-ring group relative inline-flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-ink/15 bg-ink/[0.04] px-4 py-2.5 font-mono text-sm text-ink transition-colors hover:border-ink/30"
					: "focus-ring group relative inline-flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-white/[0.06] px-4 py-2.5 font-mono text-sm text-white/85 transition-colors hover:border-ut/30"
			}
		>
			<span aria-hidden="true" className={isPaper ? "text-ink/64" : "text-ut/60"}>
				$
			</span>
			<span>{label ?? text}</span>
			<span
				className={
					isPaper
						? "text-xs text-ink/64 transition-colors group-hover:text-ink"
						: "text-xs text-white/40 transition-colors group-hover:text-ut"
				}
			>
				copy
			</span>
			{state === "copied" && (
				<span
					aria-hidden="true"
					className="chit pointer-events-none absolute -top-3 right-2 rounded-sm bg-paper px-2 py-0.5 font-mono text-[12px] text-ink shadow-md"
				>
					copied · $0.00
				</span>
			)}
			{state === "failed" && (
				<span
					aria-hidden="true"
					className="chit pointer-events-none absolute -top-3 right-2 rounded-sm bg-paper-red px-2 py-0.5 font-mono text-[12px] text-white shadow-md"
				>
					copy failed
				</span>
			)}
			<span aria-live="polite" className="sr-only">
				{state === "copied" ? "copied" : state === "failed" ? "copy failed" : ""}
			</span>
		</button>
	);
}
