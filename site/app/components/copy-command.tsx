"use client";

import { useCallback, useState } from "react";

export function CopyCommand() {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText("npm install usertrust");
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Fallback: select the text
			const el = document.querySelector("[data-install-cmd]");
			if (el) {
				const range = document.createRange();
				range.selectNodeContents(el);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
		}
	}, []);

	return (
		<button
			type="button"
			onClick={handleCopy}
			className="group relative flex w-full items-center justify-between gap-4 rounded-xl border border-white/10 px-5 py-3.5 cursor-pointer hover:border-ut/30 transition-colors duration-200"
			style={{
				background: "rgba(255,255,255,0.04)",
				backdropFilter: "blur(24px)",
			}}
			aria-label="Copy install command"
		>
			<code data-install-cmd className="text-sm text-white/80 select-all">
				$ npm install usertrust
			</code>
			<span className="shrink-0 text-xs font-medium text-white/40 group-hover:text-ut transition-colors duration-200">
				{copied ? "copied!" : "copy"}
			</span>
		</button>
	);
}
