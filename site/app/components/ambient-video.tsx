"use client";

import { useEffect, useRef } from "react";

/** How much of the video must be on screen for the loop to run. */
const VISIBLE_RATIO = 0.5;

/**
 * Muted ambient loop — the one sanctioned loop in the motion doctrine. Plays
 * only while at least VISIBLE_RATIO of it is on screen, pauses otherwise, and
 * never autoplays under reduced motion (poster only). `preload="none"` +
 * poster keeps the bytes off the network until the IntersectionObserver calls
 * play().
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
				if (!entry) return;
				// Compare the RATIO, not `isIntersecting`. A threshold only says
				// where the observer notifies; the callback also runs on any
				// isIntersecting edge, so `isIntersecting` alone starts the loop at
				// one visible pixel and, crossing 50% downward, calls play() again
				// on a video that is mostly off screen. The documented behaviour —
				// and the one the motion doctrine sanctions — is 50%.
				if (entry.intersectionRatio >= VISIBLE_RATIO) void video.play().catch(() => {});
				else video.pause();
			},
			{ threshold: VISIBLE_RATIO },
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
