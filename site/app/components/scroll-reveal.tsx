"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

export function ScrollReveal({
	children,
	delay = 0,
	className,
}: {
	children: React.ReactNode;
	delay?: number;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, margin: "0px 0px -40px 0px" });

	return (
		<motion.div
			ref={ref}
			initial={{ opacity: 0, y: 20 }}
			animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
			transition={{ duration: 0.5, ease: "easeOut", delay }}
			className={className}
		>
			{children}
		</motion.div>
	);
}
