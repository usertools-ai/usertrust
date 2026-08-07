"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard chip. Prints a paper "copied · $0.00" chit for 1.6s on
 * success and a visible "copy failed" chit when the Clipboard API rejects
 * (permissions policy, insecure context). Screen readers get an
 * aria-live="polite" announcement either way.
 */
export default function CopyChip({ text, label }: { text: string; label?: string }) {
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
			setState("copied");
		} catch {
			setState("failed");
		}
		timer.current = setTimeout(() => setState("idle"), 1600);
	}, [text]);

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={`Copy ${text}`}
			className="focus-ring group relative inline-flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-white/[0.06] px-4 py-2.5 font-mono text-sm text-white/85 transition-colors hover:border-ut/30"
		>
			<span aria-hidden="true" className="text-ut/60">
				$
			</span>
			<span>{label ?? text}</span>
			<span className="text-xs text-white/40 transition-colors group-hover:text-ut">copy</span>
			{state === "copied" && (
				<span
					aria-hidden="true"
					className="chit pointer-events-none absolute -top-3 right-2 rounded-sm bg-paper px-2 py-0.5 font-mono text-[10px] text-ink shadow-md"
				>
					copied · $0.00
				</span>
			)}
			{state === "failed" && (
				<span
					aria-hidden="true"
					className="chit pointer-events-none absolute -top-3 right-2 rounded-sm bg-danger px-2 py-0.5 font-mono text-[10px] text-white shadow-md"
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
