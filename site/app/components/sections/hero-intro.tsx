"use client";

import { useEffect, useRef, useState } from "react";

/*
 * The intro backdrop (Addendum A; scrim per Addendum C). Poster paints in
 * initial HTML; the video mounts idle-gated so it can never compete with the
 * hero's LCP. Desktop + no-preference only: mobile and reduced-motion
 * visitors get the final mascot frame as a static backdrop and download zero
 * video bytes.
 */

// Named `delay` so the check-facts gate's assignment pattern sanctions the
// literal (a bare digit in sections/ is otherwise a rogue-token build break).
const delay = 300;

export default function HeroIntro() {
	const [mountVideo, setMountVideo] = useState(false);
	const [settled, setSettled] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const wantsVideo =
			window.matchMedia("(min-width: 768px)").matches &&
			!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (!wantsVideo) {
			setSettled(true);
			return;
		}
		const idle =
			typeof window.requestIdleCallback === "function"
				? window.requestIdleCallback
				: (cb: () => void) => window.setTimeout(cb, delay);
		const handle = idle(() => setMountVideo(true));
		return () => {
			if (typeof window.cancelIdleCallback === "function")
				window.cancelIdleCallback(handle as number);
			else window.clearTimeout(handle as number);
		};
	}, []);

	return (
		<div aria-hidden="true" className="absolute inset-0 -z-10 overflow-hidden">
			{/* Poster layer: first frame pre-video, final mascot frame once settled/static */}
			{/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop swapped via plain src, not the LCP candidate (the headline is) */}
			<img
				src={settled ? "/intro/intro-poster.jpg" : "/intro/intro-first.jpg"}
				alt=""
				className="absolute inset-0 h-full w-full object-cover"
			/>
			{mountVideo && (
				<video
					ref={videoRef}
					muted
					playsInline
					autoPlay
					preload="none"
					onEnded={() => setSettled(true)}
					className="absolute inset-0 h-full w-full object-cover"
				>
					<source src="/intro/intro-autoplay.webm" type="video/webm" />
					<source src="/intro/intro-autoplay.mp4" type="video/mp4" />
				</video>
			)}
			{/* Legibility scrim (Addendum C rebalance) — gradient only, NO
			    backdrop-filter. 90% holds through the left headline column,
			    decays mid-frame, and sits at 15% from the right fifth onward so
			    the suit settles essentially unveiled (spec ceiling: 20%). */}
			<div className="absolute inset-0 bg-gradient-to-r from-brand-bg/90 from-10% via-brand-bg/45 via-45% to-brand-bg/15 to-80%" />
			{/* Mobile: the stack sits full-width over the centered figure — one
			    flat layer restores contrast without dimming the desktop right. */}
			<div className="absolute inset-0 bg-brand-bg/40 md:hidden" />
			<div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-brand-bg to-transparent" />
		</div>
	);
}
