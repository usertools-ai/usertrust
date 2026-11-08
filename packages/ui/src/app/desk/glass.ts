// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Glass, for controls only (the top bar, the range capsule, the loupe, a menu): any element with the class `ut-glass`
 * gets
 *
 * - a bent edge: an SVG displacement filter on its backdrop, made per size from a radial edge map, bending the outer
 *   9 px only (Chromium renders it; elsewhere the plain blur in the stylesheet stands);
 * - a rim lit toward the pointer: its brightest point (`--ra`) turns to face the hand, one light for every rim;
 * - a press: it grows a little and the rim brightens, for 120 ms;
 * - a shine along the edge, only after 7 s with no input; any input stops it, and it never runs under reduced motion.
 *
 * Installed once; it follows glass as it appears (a MutationObserver) and as it resizes (a ResizeObserver).
 */

import { motionStill } from "../../shared/motion.js";

/** How long with no input before the edge shine runs, in ms. */
export const SHINE_IDLE_MS = 7000;

const lensCache = new Map<string, string>();
let defs: SVGDefsElement | null = null;

function lensDefs(): SVGDefsElement {
	if (defs !== null) return defs;
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", "0");
	svg.setAttribute("height", "0");
	svg.setAttribute("aria-hidden", "true");
	svg.style.position = "absolute";
	defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
	svg.appendChild(defs);
	document.body.appendChild(svg);
	return defs;
}

/** The edge map: red and green push the backdrop outward near the rim, by up to the full scale, never in the middle. */
function lensify(el: HTMLElement): void {
	const w = Math.round(el.offsetWidth);
	const h = Math.round(el.offsetHeight);
	if (w < 4 || h < 4) return;
	const r = Math.min(
		Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
		h / 2,
		w / 2,
	);
	const key = `${w}x${h}r${Math.round(r)}`;
	let id = lensCache.get(key);
	if (id === undefined) {
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const g = c.getContext("2d");
		if (g === null) return;
		const im = g.createImageData(w, h);
		const band = 9;
		const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const px = x + 0.5;
				const py = y + 0.5;
				const cx = clamp(px, r, w - r);
				const cy = clamp(py, r, h - r);
				const vx = px - cx;
				const vy = py - cy;
				const len = Math.hypot(vx, vy);
				let dist: number;
				let nx = 0;
				let ny = 0;
				if (len > 0) {
					dist = r - len;
					nx = vx / len;
					ny = vy / len;
				} else {
					const m = Math.min(px, w - px, py, h - py);
					dist = m;
					if (m === px) nx = -1;
					else if (m === w - px) nx = 1;
					else if (m === py) ny = -1;
					else ny = 1;
				}
				let t = dist < band ? 1 - Math.max(0, dist) / band : 0;
				t *= t;
				const i = (y * w + x) * 4;
				im.data[i] = 128 - nx * t * 127;
				im.data[i + 1] = 128 - ny * t * 127;
				im.data[i + 2] = 128;
				im.data[i + 3] = 255;
			}
		g.putImageData(im, 0, 0);
		id = `ut-lens-${key}`;
		const NS = "http://www.w3.org/2000/svg";
		const f = document.createElementNS(NS, "filter");
		f.setAttribute("id", id);
		for (const [k, v] of [
			["x", "0"],
			["y", "0"],
			["width", String(w)],
			["height", String(h)],
			["filterUnits", "userSpaceOnUse"],
			["primitiveUnits", "userSpaceOnUse"],
			["color-interpolation-filters", "sRGB"],
		] as const)
			f.setAttribute(k, v);
		const img = document.createElementNS(NS, "feImage");
		img.setAttribute("href", c.toDataURL());
		for (const [k, v] of [
			["x", "0"],
			["y", "0"],
			["width", String(w)],
			["height", String(h)],
			["preserveAspectRatio", "none"],
			["result", "m"],
		] as const)
			img.setAttribute(k, v);
		const dm = document.createElementNS(NS, "feDisplacementMap");
		for (const [k, v] of [
			["in", "SourceGraphic"],
			["in2", "m"],
			["scale", "14"],
			["xChannelSelector", "R"],
			["yChannelSelector", "G"],
		] as const)
			dm.setAttribute(k, v);
		f.append(img, dm);
		lensDefs().appendChild(f);
		lensCache.set(key, id);
	}
	el.style.setProperty("backdrop-filter", `url(#${id}) blur(8px) saturate(125%)`);
}

let installed = false;

export function installGlass(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	// Chromium only: the displacement backdrop. Elsewhere the stylesheet's plain blur stands.
	const lens = typeof navigator !== "undefined" && /Chrome\//.test(navigator.userAgent);
	const resized =
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver((entries) => {
					if (!lens) return;
					for (const e of entries) lensify(e.target as HTMLElement);
				});
	const seen = new WeakSet<Element>();
	const scan = (): void => {
		for (const el of document.querySelectorAll<HTMLElement>(".ut-glass")) {
			if (seen.has(el)) continue;
			seen.add(el);
			resized?.observe(el);
			el.addEventListener("pointerdown", () => {
				el.classList.add("pressed");
				setTimeout(() => el.classList.remove("pressed"), 120);
			});
		}
	};
	scan();
	new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });

	// One light: every rim's brightest point turns toward the pointer.
	let raf = 0;
	let pt: [number, number] = [0, 0];
	addEventListener(
		"pointermove",
		(e) => {
			pt = [e.clientX, e.clientY];
			if (raf !== 0) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				for (const el of document.querySelectorAll<HTMLElement>(".ut-glass")) {
					const r = el.getBoundingClientRect();
					const a =
						(Math.atan2(pt[0] - (r.left + r.width / 2), -(pt[1] - (r.top + r.height / 2))) * 180) /
						Math.PI;
					el.style.setProperty("--ra", `${a.toFixed(1)}deg`);
				}
			});
		},
		{ passive: true },
	);

	// The shine: after SHINE_IDLE_MS with no input the page is marked idle (the stylesheet runs the shine on that
	// mark); any input clears it and starts the wait again. Never marked under reduced motion.
	const root = document.documentElement;
	let idle = 0;
	const wake = (): void => {
		root.removeAttribute("data-idle");
		clearTimeout(idle);
		idle = window.setTimeout(() => {
			if (!motionStill()) root.setAttribute("data-idle", "");
		}, SHINE_IDLE_MS);
	};
	for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"])
		addEventListener(type, wake, { passive: true });
	wake();
}
