/*
 * The one code-surface chrome for the whole page (Addendum E). Every
 * multi-line code / terminal / transcript / editor / log surface renders
 * inside this frame — container, title bar, and body typography are
 * defined here and nowhere else.
 */
export default function TerminalFrame({
	title,
	children,
	className,
	tone = "default",
}: {
	title?: string;
	children: React.ReactNode;
	className?: string;
	tone?: "default" | "error";
}) {
	const border = tone === "error" ? "border-danger/30" : "border-white/10";
	return (
		<div className={`overflow-hidden rounded-xl border ${border} bg-terminal ${className ?? ""}`}>
			{title != null && (
				<div className="flex h-9 items-center border-b border-white/[0.06] px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
					{title}
				</div>
			)}
			<div className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed md:p-5">
				{children}
			</div>
		</div>
	);
}
