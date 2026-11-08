// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import type { AtPayload } from "../shared/api.js";
import { Scrubber, type ScrubIo } from "../shared/scrub.js";
import {
	goLiveKeepingFocus,
	isStepEvent,
	newSince,
	type StepKey,
	stepFor,
	timelineTexts,
} from "../shared/timeline-view.js";

const browserFrames: ScrubIo = {
	frame(fn) {
		const id = requestAnimationFrame(() => fn());
		return () => cancelAnimationFrame(id);
	},
	later(fn, ms) {
		const id = setTimeout(fn, ms);
		return () => clearTimeout(id);
	},
};

/**
 * The timeline along the bottom of the page: a native range over the vault's positions, `0..head`. Moving it shows the
 * whole screen as the vault was recorded at that position; the Live button returns to now. While a past position is
 * shown and new records arrive, "N new since" says how many (pressing it goes live too).
 *
 * A drag moves the thumb at once (local state), asks for the position at most once a frame (`onPreview`), and writes
 * the address once, on release, key up, blur, or after it sits still (`onCommit`, through `Scrubber`): the browser
 * limits how often a page may rewrite its address.
 *
 * The range is the browser's own slider (`role="slider"`, focusable, draggable). Its `aria-valuetext` names the record
 * and, once the screen shows it, its time. The keys move it by `stepFor`: the arrows one position, PageUp and PageDown
 * 5%, Home and End to the ends. The visible label always describes what the screen shows, which during a fast drag
 * can be the last answer that landed, a moment behind the thumb.
 */
export function Timeline(props: {
	/** The answer shown (null: live, or nothing loaded yet for `wanted`). */
	at: AtPayload | null;
	/** The position asked for (a preview, or the address's), or null for live. */
	wanted: number | null;
	/** The address's position (`#at`): a change the drag did not write drops its pending commit. */
	committed: number | null;
	/** The live vault's last position; -1 when it has no records. */
	head: number;
	error: string | null;
	reloaded: boolean;
	/**
	 * Set while the list, the facets, Trends, the inspector and Export still show another position than the header
	 * (they are dimmed meanwhile): "Updating to record N…", shown beside the label where there is room (not on a phone).
	 * It follows every answer, so it is not announced: `announce` is.
	 */
	holdNote?: string | null;
	/**
	 * The polite live region's text (`holdAnnouncement`): it changes once when the views start to lag and once when they
	 * catch up, so a drag is two announcements, not one per answer. The region is there before any text.
	 */
	announce?: string;
	/** Ask for a position without writing the address (a drag in progress). */
	onPreview(pos: number): void;
	/** Write the position to the address (the drag settled). */
	onCommit(pos: number): void;
	/** A drag started (true) or ended (false): the page holds the list meanwhile. */
	onHold(holding: boolean): void;
	onLive(): void;
}): React.JSX.Element {
	const { at, wanted, head } = props;
	// Read at render, never subscribed to: the clock only decides whether a label names the year, and a ticking clock
	// re-rendered the timeline every 15 s while live for nothing.
	const nowIso = new Date().toISOString();
	// The thumb while a drag or a key is moving it, ahead of the answers; null once it is written to the address.
	const [thumb, setThumb] = useState<number | null>(null);
	const handlers = useRef(props);
	handlers.current = props;
	const scrub = useRef<Scrubber | null>(null);
	if (scrub.current === null)
		scrub.current = new Scrubber(
			browserFrames,
			(p) => handlers.current.onPreview(p),
			(p) => {
				setThumb(null);
				handlers.current.onCommit(p);
			},
			(active) => handlers.current.onHold(active),
		);
	useEffect(() => () => scrub.current?.cancel(), []);
	// Back, Forward or a link moved the address under a drag: drop its pending commit, and the thumb with it.
	useEffect(() => {
		const s = scrub.current;
		if (s === null) return;
		const hadPending = s.pending !== null;
		s.sync(props.committed);
		if (hadPending && s.pending === null) setThumb(null);
	}, [props.committed]);

	const max = Math.max(head, 0);
	// A position asked for past the head was answered with the head: the thumb sits on the record answered.
	const settled =
		wanted === null
			? max
			: at?.clamped === true && wanted > at.pos
				? at.pos
				: Math.min(wanted, max);
	const value = thumb ?? settled;
	const past = wanted !== null || thumb !== null;
	const { label, valueText } = timelineTexts({
		value,
		head,
		past,
		at,
		error: props.error,
		nowIso,
	});
	const fresh = past ? newSince(at, head) : 0;

	const move = (next: number): void => {
		setThumb(next);
		scrub.current?.move(next);
	};
	const release = (): void => scrub.current?.release();
	const live = (): void => {
		scrub.current?.cancel();
		setThumb(null);
		props.onLive();
	};
	// The "N new since" button unmounts once the count is zero; pressing it hands focus to the Live button.
	const liveBtn = useRef<HTMLButtonElement | null>(null);
	const pressNewSince = (): void => goLiveKeepingFocus(live, liveBtn.current);

	return (
		<section className="ut-tl" aria-label="Timeline" data-past={past}>
			<p className="ut-tl-msg" role="status">
				{props.error !== null &&
					(at !== null
						? `Could not show that point: ${props.error}. Still showing the last point loaded.`
						: `Could not show that point: ${props.error}; showing the live vault.`)}
				{props.error !== null && props.reloaded && " "}
				{props.reloaded &&
					"Read again because the vault was reloaded: this position may now name another record."}
			</p>
			<div className="ut-tl-head">
				<span className="ut-tl-label" data-past={at !== null}>
					{label}
				</span>
				<span className="ut-tl-held" aria-hidden="true">
					{props.holdNote ?? ""}
				</span>
				<span className="sr-only" role="status">
					{props.announce ?? ""}
				</span>
				{fresh > 0 && (
					<button
						type="button"
						className="ut-tl-btn ut-tl-new"
						title={`${fresh.toLocaleString()} ${fresh === 1 ? "record was" : "records were"} added after this point was chosen: go live to see them`}
						onClick={pressNewSince}
					>
						{`${fresh.toLocaleString()} new since`}
					</button>
				)}
				{/* Always mounted: pressing it goes live, and a button that unmounts under keyboard focus drops focus to the
				    page. While live it is aria-disabled (not disabled, which cannot hold focus) and does nothing. */}
				<button
					type="button"
					ref={liveBtn}
					className="ut-tl-btn"
					title={past ? "Show the vault as it is now" : "Already showing the vault as it is now"}
					aria-disabled={past ? undefined : true}
					onClick={past ? live : undefined}
				>
					Live
					{/* On a phone the "N new since" button is folded in here, so the label and one button share a row. */}
					{fresh > 0 && (
						<span className="ut-tl-count">
							{` +${fresh.toLocaleString()}`}
							<span className="sr-only"> new records</span>
						</span>
					)}
				</button>
			</div>
			<input
				type="range"
				className="ut-tl-range"
				min={0}
				max={max}
				step={1}
				value={value}
				disabled={head < 0}
				aria-label="Show the vault as recorded at"
				aria-valuetext={valueText}
				onChange={(e) => {
					const next = Number(e.currentTarget.value);
					if (Number.isSafeInteger(next) && next !== value) move(next);
				}}
				onKeyDown={(e) => {
					if (!isStepEvent(e) || head < 0) return;
					e.preventDefault();
					const next = stepFor(e.key as StepKey, value, head);
					if (next !== value) move(next);
				}}
				onKeyUp={release}
				onPointerUp={release}
				onBlur={release}
			/>
		</section>
	);
}
