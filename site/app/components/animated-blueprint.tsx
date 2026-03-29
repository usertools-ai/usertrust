"use client";

import { useInView } from "motion/react";
import { useRef } from "react";

interface AnimatedBlueprintProps {
	phaseId: string;
	className?: string;
	children: React.ReactNode;
}

export function AnimatedBlueprint({ phaseId, className, children }: AnimatedBlueprintProps) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, margin: "0px 0px -60px 0px" });

	return (
		<>
			<style>{`
				.bp-hidden svg line,
				.bp-hidden svg path,
				.bp-hidden svg polygon,
				.bp-hidden svg ellipse,
				.bp-hidden svg circle,
				.bp-hidden svg rect {
					stroke-dasharray: 200;
					stroke-dashoffset: 200;
					transition: stroke-dashoffset 1.5s ease-out;
				}
				.bp-visible svg line,
				.bp-visible svg path,
				.bp-visible svg polygon,
				.bp-visible svg ellipse,
				.bp-visible svg circle,
				.bp-visible svg rect {
					stroke-dasharray: 200;
					stroke-dashoffset: 0;
				}
				.bp-hidden svg text {
					opacity: 0;
					transition: opacity 0.8s ease-out 1s;
				}
				.bp-visible svg text {
					opacity: inherit;
				}
			`}</style>
			<div
				ref={ref}
				className={inView ? "bp-visible" : "bp-hidden"}
				aria-label={`Blueprint for ${phaseId} phase`}
			>
				<div className={`relative ${className ?? ""}`}>{children}</div>
			</div>
		</>
	);
}
