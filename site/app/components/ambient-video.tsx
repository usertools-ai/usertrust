"use client";

import { useEffect, useRef } from "react";

/**
 * Muted ambient loop — the one sanctioned loop in the motion doctrine. Plays
 * only while >=50% on screen, pauses off-screen, and never autoplays under
 * reduced motion (poster only). `preload="none"` + poster keeps the bytes off
 * the network until the IntersectionObserver calls play().
 */
export default function AmbientVideo({
	src,
	poster,
	className,
}: {
	src: string;
	poster?: string;
	className?: string;
}) {
	const ref = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const video = ref.current;
		if (!video) return;
		// Reduced motion: poster only — never autoplay.
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const io = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) void video.play().catch(() => {});
				else video.pause();
			},
			{ threshold: 0.5 },
		);
		io.observe(video);
		return () => io.disconnect();
	}, []);

	return (
		<video
			ref={ref}
			src={src}
			poster={poster}
			className={className}
			muted
			playsInline
			loop
			preload="none"
			aria-hidden="true"
			tabIndex={-1}
		/>
	);
}
