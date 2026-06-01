"use client";

import { motion, useReducedMotion } from "motion/react";

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

export function GradientOrbs() {
	const reduce = useReducedMotion();
	return (
		<div
			className="fixed inset-0 pointer-events-none overflow-hidden"
			style={{ zIndex: 0 }}
			aria-hidden="true"
		>
			{orbs.map((orb, i) => (
				<motion.div
					// biome-ignore lint/suspicious/noArrayIndexKey: static constant array
					key={`orb-${i}`}
					className="absolute rounded-full"
					style={{
						width: orb.size,
						height: orb.size,
						left: orb.x,
						top: orb.y,
						background: `radial-gradient(circle, ${orb.color} 0%, transparent 70%)`,
						filter: "blur(80px)",
						willChange: reduce ? undefined : "transform",
					}}
					animate={reduce ? undefined : { x: [0, 30, -20, 10, 0], y: [0, -25, 15, -10, 0] }}
					transition={
						reduce
							? undefined
							: {
									duration: orb.duration,
									repeat: Number.POSITIVE_INFINITY,
									ease: "easeInOut",
								}
					}
				/>
			))}
		</div>
	);
}
