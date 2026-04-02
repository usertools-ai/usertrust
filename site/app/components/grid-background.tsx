"use client";

export function GridBackground() {
	return (
		<div
			className="fixed inset-0 dot-grid pointer-events-none"
			style={{ zIndex: 0, opacity: 0.5 }}
			aria-hidden="true"
		>
			{/* Radial fade from center */}
			<div
				className="absolute inset-0"
				style={{
					background: "radial-gradient(ellipse at 50% 0%, transparent 0%, var(--color-brand-bg) 70%)",
				}}
			/>
		</div>
	);
}
