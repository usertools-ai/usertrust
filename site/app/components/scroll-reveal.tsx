"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

export function ScrollReveal({
	children,
	delay = 0,
	className,
	scale = false,
}: {
	children: React.ReactNode;
	delay?: number;
	className?: string;
	scale?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, amount: 0.1 });

	return (
		<motion.div
			ref={ref}
			initial={{ opacity: 0, y: 20, scale: scale ? 0.95 : 1 }}
			animate={
				inView ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 20, scale: scale ? 0.95 : 1 }
			}
			transition={{ duration: 0.5, ease: "easeOut", delay }}
			className={className}
		>
			{children}
		</motion.div>
	);
}
