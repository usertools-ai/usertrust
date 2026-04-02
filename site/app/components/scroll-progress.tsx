"use client";

import { motion, useScroll, useSpring } from "motion/react";

export function ScrollProgress() {
	const { scrollYProgress } = useScroll();
	const scaleX = useSpring(scrollYProgress, {
		stiffness: 100,
		damping: 30,
		restDelta: 0.001,
	});

	return (
		<motion.div
			className="fixed top-0 left-0 right-0 h-[2px] origin-left z-[60]"
			style={{
				scaleX,
				background: "linear-gradient(90deg, #34d399, #6ca0c0, #c084fc)",
			}}
		/>
	);
}
