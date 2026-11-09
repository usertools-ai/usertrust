// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The box a chart reads. It is the content box in unrounded CSS pixels: a chart whose viewBox equals the CSS box lands
 * its crosshair within half a pixel at 125% zoom, which a rounded box cannot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

interface BoxModule {
	boxOf(entry: { contentRect: { width: number; height: number } }): { w: number; h: number };
	useBoxSize(ref: { current: Element | null }): { w: number; h: number };
	useMedia(query: string, server: boolean): boolean;
}

let box: BoxModule;
beforeAll(async () => {
	box = (await import(/* @vite-ignore */ `../src/app/desk/${"use-box-size"}.js`)) as BoxModule;
});

describe("boxOf", () => {
	it("reports the content box exactly as the browser gives it", () => {
		const b = box.boxOf({ contentRect: { width: 700.4, height: 219.6 } });
		expect(b.w).toBe(700.4);
		expect(b.h).toBe(219.6);
	});

	it("reports an empty box as zero by zero", () => {
		expect(box.boxOf({ contentRect: { width: 0, height: 0 } })).toEqual({ w: 0, h: 0 });
	});

	it("never rounds: the file has no round, floor, ceil or trunc", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "src", "app", "desk", "use-box-size.ts"),
			"utf-8",
		);
		expect(source).not.toMatch(/Math\.(round|floor|ceil|trunc)/);
	});
});

describe("under static markup", () => {
	it("useBoxSize is 0 by 0 and useMedia is the server's answer", () => {
		function Probe(): React.JSX.Element {
			const size = box.useBoxSize({ current: null });
			const narrow = box.useMedia("(max-width: 900px)", false);
			const wide = box.useMedia("(min-width: 1100px)", true);
			return createElement("p", null, `${size.w}x${size.h} ${narrow} ${wide}`);
		}
		expect(renderToStaticMarkup(createElement(Probe))).toBe("<p>0x0 false true</p>");
	});
});
