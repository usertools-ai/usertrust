/*
 * The one code-surface chrome for the whole page (Addendum E). Every
 * multi-line code / terminal / transcript / editor / log surface renders
 * inside this frame — container, title bar, and body typography are
 * defined here and nowhere else. Sizes are the Addendum H1 bump: body is
 * ALWAYS 14px mono, frame-internal labels are ALWAYS 12px mono uppercase
 * at white/70 — not white/50, the amended contrast floor
 * (global-constraints.md, "Code-surface consistency" + "Type + contrast
 * floors"). The container carries `lift-1`, the one sanctioned elevation
 * primitive for cards/frames (Addendum H3) — no per-section shadow.
 *
 * `title` and `footer` accept a `ReactNode`, not just a string: several
 * surfaces need a two-part title bar (filename + count, case number +
 * caption) or a bar-flush footer row (provenance line, "unstamped" ticket
 * stub) that a plain string can't express. Widening the type is additive —
 * every existing single-string `title` usage is unaffected — and it is what
 * lets those surfaces render through this component instead of duplicating
 * its classes next to it. `footer` is intentionally unstyled by the frame
 * itself (unlike `title`, which always gets the same label treatment):
 * footers are per-surface flourishes (a plain provenance line here, a
 * dashed "ticket" stub there) and forcing them into one look would erase a
 * deliberate visual distinction, not unify a chrome definition.
 */
export default function TerminalFrame({
	title,
	footer,
	children,
	className,
	tone = "default",
}: {
	title?: React.ReactNode;
	footer?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
	tone?: "default" | "error";
}) {
	const border = tone === "error" ? "border-danger/30" : "border-white/10";
	return (
		<div
			className={`lift-1 overflow-hidden rounded-xl border ${border} bg-terminal ${className ?? ""}`}
		>
			{title != null && (
				<div className="flex h-9 items-center border-b border-white/[0.06] px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
					{title}
				</div>
			)}
			<div className="overflow-x-auto p-4 font-mono text-[14px] leading-relaxed md:p-5">
				{children}
			</div>
			{footer != null && footer}
		</div>
	);
}
