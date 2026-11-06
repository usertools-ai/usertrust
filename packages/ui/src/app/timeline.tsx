// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { AtPayload } from "../shared/api.js";
import { isStepKey, newSince, stepFor, timelineLabel } from "../shared/timeline-view.js";
import { useNow } from "./use-now.js";

/**
 * The timeline along the bottom of the page: a native range over the vault's positions, `0..head`. Moving it shows the
 * whole screen as the vault was recorded at that position; the Live button returns to now. While a past position is
 * shown and new records arrive, "N new since" says how many (pressing it goes live too).
 *
 * The range is the browser's own slider (`role="slider"`, focusable, draggable), with `aria-valuetext` equal to the
 * label on screen, so a screen reader reads the time, not a bare index. The keys move it by `stepFor`: the arrows one
 * position, PageUp and PageDown 5%, Home and End to the ends. The label always describes what the screen shows, which
 * during a fast drag can be the last answer that landed, a moment behind the thumb.
 */
export function Timeline(props: {
	/** The answer shown (null: live, or nothing loaded yet for `wanted`). */
	at: AtPayload | null;
	/** The position asked for (the address's), or null for live. */
	wanted: number | null;
	/** The live vault's last position; -1 when it has no records. */
	head: number;
	loading: boolean;
	error: string | null;
	reloaded: boolean;
	onMove(pos: number): void;
	onLive(): void;
}): React.JSX.Element {
	const { at, wanted, head, onMove, onLive } = props;
	const now = useNow();
	const past = wanted !== null;
	const max = Math.max(head, 0);
	const value = Math.min(wanted ?? max, max);
	const label = !past
		? "Live"
		: at !== null
			? timelineLabel(at, new Date(now).toISOString())
			: props.loading
				? "Loading this point…"
				: "Live (that point did not load)";
	const fresh = past ? newSince(at, head) : 0;

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
		if (!isStepKey(e.key) || head < 0) return;
		e.preventDefault();
		const next = stepFor(e.key, value, head);
		if (next !== value) onMove(next);
	};

	return (
		<section className="ut-tl" aria-label="Timeline" data-past={past}>
			{(props.error !== null || props.reloaded) && (
				<p className="ut-tl-msg" role="status">
					{props.error !== null &&
						(at !== null
							? `Could not show that point: ${props.error}. Still showing the last point loaded.`
							: `Could not show that point: ${props.error}; showing the live vault.`)}
					{props.error !== null && props.reloaded && " "}
					{props.reloaded &&
						"Read again because the vault was reloaded: this position may now name another record."}
				</p>
			)}
			<div className="ut-tl-head">
				<span className="ut-tl-label" data-past={at !== null}>
					{label}
				</span>
				<span className="ut-grow" />
				{fresh > 0 && (
					<button
						type="button"
						className="ut-tl-btn"
						title={`${fresh.toLocaleString()} ${fresh === 1 ? "record was" : "records were"} added after this point was chosen: go live to see them`}
						onClick={onLive}
					>
						{`${fresh.toLocaleString()} new since`}
					</button>
				)}
				{past && (
					<button
						type="button"
						className="ut-tl-btn"
						title="Show the vault as it is now"
						onClick={onLive}
					>
						Live
					</button>
				)}
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
				aria-valuetext={label}
				onChange={(e) => {
					const next = Number(e.currentTarget.value);
					if (Number.isSafeInteger(next) && next !== value) onMove(next);
				}}
				onKeyDown={onKeyDown}
			/>
		</section>
	);
}
