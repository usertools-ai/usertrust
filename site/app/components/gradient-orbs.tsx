const orbs = [
	{
		color: "rgba(52,211,153,0.08)",
		size: 600,
		x: "10%",
		y: "15%",
		duration: 25,
	},
	{
		color: "rgba(108,160,192,0.06)",
		size: 500,
		x: "75%",
		y: "40%",
		duration: 30,
	},
	{
		color: "rgba(192,132,252,0.05)",
		size: 450,
		x: "50%",
		y: "70%",
		duration: 28,
	},
];

// Server component: no motion, no filter. A radial gradient is already soft —
// the old blur(80px) on top of it was invisible duplication that forced huge
// blurred layers to re-rasterize on every frame of the JS-driven drift.
// Drift now runs on the compositor via the CSS `orb-float` keyframes
// (transform-only); prefers-reduced-motion is handled in globals.css.
export function GradientOrbs() {
	return (
		<div
			className="fixed inset-0 pointer-events-none overflow-hidden"
			style={{ zIndex: 0 }}
			aria-hidden="true"
		>
			{orbs.map((orb, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: static constant array
					key={`orb-${i}`}
					className="orb absolute rounded-full"
					style={{
						width: orb.size,
						height: orb.size,
						left: orb.x,
						top: orb.y,
						background: `radial-gradient(circle, ${orb.color} 0%, transparent 70%)`,
						animationDuration: `${orb.duration}s`,
					}}
				/>
			))}
		</div>
	);
}
