"use client";

import { useEffect, useRef, useState } from "react";
import { INTRO_VIDEO_SOURCES } from "./intro-video-sources";

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
			{/* Poster layer: first frame pre-video, final mascot frame once settled/static.
			    Hero framing shift: transform-only pan/zoom on md:+ so the mascot's head
			    clears the fixed nav with headroom and the figure rests right of center.
			    Both media layers below carry IDENTICAL transform classes — divergence here
			    reintroduces the settle-swap jump this shift exists to remove. */}
			{/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop swapped via plain src, not the LCP candidate (the headline is) */}
			<img
				src={settled ? "/intro/intro-poster.jpg" : "/intro/intro-first.jpg"}
				alt=""
				className="absolute inset-0 h-full w-full object-cover md:scale-[1.2] md:translate-x-[19%] md:translate-y-[16%] 2xl:scale-[1.3]"
			/>
			{mountVideo && (
				<video
					ref={videoRef}
					muted
					playsInline
					autoPlay
					preload="none"
					onEnded={() => setSettled(true)}
					className="absolute inset-0 h-full w-full object-cover md:scale-[1.2] md:translate-x-[19%] md:translate-y-[16%] 2xl:scale-[1.3]"
				>
					{INTRO_VIDEO_SOURCES.map((source) => (
						<source key={source.type} src={source.src} type={source.type} />
					))}
				</video>
			)}
			{/* Legibility scrim (Addendum C rebalance) — gradient only, NO
			    backdrop-filter. 90% holds through the left headline column,
			    decays mid-frame, and sits at 15% from the right fifth onward so
			    the suit settles essentially unveiled (spec ceiling: 20%). */}
			<div className="absolute inset-0 bg-gradient-to-r from-brand-bg/90 from-10% via-brand-bg/45 via-45% to-brand-bg/15 to-80%" />
			{/* Mobile: the stack sits full-width over the centered figure — one
			    flat layer restores contrast without dimming the desktop right.
			    Denser than before: mobile always shows the SETTLED frame, so the
			    suit's lit rock face is the permanent ground under the footnote row,
			    where "verifier" sampled well under the floor against the median
			    rock, and worse against its brightest highlights. */}
			<div className="absolute inset-0 bg-brand-bg/55 md:hidden" />
			{/* The footnote row sits ABOVE the desktop h-40 gradient's start, so
			    mobile gets its own taller, denser bottom ramp; desktop's scrim
			    balance (spec ceiling 20% over the suit) is untouched. */}
			<div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-brand-bg via-brand-bg/70 to-transparent md:hidden" />
			<div className="absolute inset-x-0 bottom-0 hidden h-40 bg-gradient-to-t from-brand-bg to-transparent md:block" />
		</div>
	);
}
