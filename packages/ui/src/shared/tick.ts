// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** How long a figure takes to count to its new value, and the frame step it counts in. */
export const TICK_DURATION_MS = 600;
export const TICK_FRAME_MS = 16;

/**
 * The values a figure shows, frame by frame, as it counts from `fromUt` to `toUt`: one per `frameMs` over
 * `durationMs`, eased out-cubic (fast, then settling). Every frame but the last is whole usertokens, truncated toward
 * `fromUt` so a frame never passes the target, and the sequence never moves away from it; the last frame is exactly
 * `toUt`. A fractional `fromUt` can drop the first frames, whose whole values would fall behind it. Equal values, a
 * non-finite value or a non-positive duration or step give `[toUt]`: the figure lands at once. The first frame is the
 * first step AFTER `fromUt`, which the figure already shows.
 */
export function tickFrames(
	fromUt: number,
	toUt: number,
	durationMs = TICK_DURATION_MS,
	frameMs = TICK_FRAME_MS,
): number[] {
	if (
		fromUt === toUt ||
		!Number.isFinite(fromUt) ||
		!Number.isFinite(toUt) ||
		!(durationMs > 0) ||
		!(frameMs > 0)
	)
		return [toUt];
	const n = Math.max(1, Math.ceil(durationMs / frameMs));
	const up = toUt > fromUt;
	// Truncating toward the start keeps an intermediate frame on the near side of a fractional target.
	const toward = up ? Math.floor : Math.ceil;
	const frames: number[] = [];
	for (let i = 1; i < n; i++) {
		const t = i / n;
		const eased = 1 - (1 - t) ** 3;
		const f = toward(fromUt + (toUt - fromUt) * eased);
		// With a fractional start, the first whole value can fall behind it: that frame is dropped, never shown.
		if (up ? f >= fromUt : f <= fromUt) frames.push(f);
	}
	frames.push(toUt);
	return frames;
}

/**
 * The frame to show `elapsedMs` into a count: frame `floor(elapsed / frameMs)`, clamped to the frames there are. A
 * requestAnimationFrame timestamp can be earlier than the clock read when the count began, so a negative (or NaN)
 * elapsed time shows the first frame, never the last one ahead of its time.
 */
export function frameAt(frames: number[], elapsedMs: number, frameMs = TICK_FRAME_MS): number {
	if (frames.length === 0) throw new RangeError("frameAt: no frames");
	const i = elapsedMs > 0 ? Math.floor(elapsedMs / frameMs) : 0;
	return frames[Math.min(frames.length - 1, i)] as number;
}
