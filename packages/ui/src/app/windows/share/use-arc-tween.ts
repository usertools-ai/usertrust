// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ring's motion. The shape drawn starts as the target, so static markup and the first paint show the final state.
 * When the target changes, the ring eases from the shape on screen to the new one (`startTween`); a change of
 * `snapKey` (the crosshair or the pin moved to another moment) is drawn at once, and so is every change when the
 * reader asked for reduced motion. Everything of the browser is read in the effect, never while rendering.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { blendShape, type RingShape, shapeKey, startTween } from "../../../shared/donut.js";
import { motionStill } from "../../../shared/motion.js";

export function useArcTween(target: RingShape, snapKey: string): RingShape {
	// The shape of the frame in flight, or null when the target itself is drawn.
	const [frame, setFrame] = useState<RingShape | null>(null);
	// What is on screen, so a new target starts from there and not from the old target.
	const drawn = useRef<RingShape>(target);
	const lastSnap = useRef(snapKey);
	const key = shapeKey(target);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `target` is read through its key: an equal shape in a new object is not a new target
	useLayoutEffect(() => {
		const from = drawn.current;
		const snapped = lastSnap.current !== snapKey;
		lastSnap.current = snapKey;
		const still =
			snapped ||
			from.arcs.size === 0 ||
			shapeKey(from) === key ||
			typeof requestAnimationFrame !== "function" ||
			motionStill();
		if (still) {
			drawn.current = target;
			setFrame(null);
			return;
		}
		const at = startTween(from, target);
		const show = (shape: RingShape, done: boolean): void => {
			drawn.current = shape;
			setFrame(done ? null : shape);
		};
		// Before the browser paints the new target, put back what was on screen: the tween starts there.
		show(blendShape(from, target, 0), false);
		let id = requestAnimationFrame(function step(now: number): void {
			const next = at(now);
			show(next.shape, next.done);
			if (!next.done) id = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(id);
	}, [key, snapKey]);

	return frame ?? target;
}
