// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dirname, "..", "..", "src", "app");

/** The page's original stylesheet, `styles.css`, on its own. */
export function legacyCss(): string {
	return readFileSync(join(APP, "styles.css"), "utf-8");
}

/** Every `.css` file under a folder, as paths relative to `src/app`, sorted. */
export function deskCssFiles(): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		let names: string[];
		try {
			names = readdirSync(join(APP, rel));
		} catch {
			return;
		}
		for (const name of names) {
			const path = `${rel}/${name}`;
			if (name.endsWith(".css")) out.push(path);
			else if (!name.includes(".")) walk(path);
		}
	};
	walk("desk");
	walk("windows");
	return out.sort();
}

/** Every desk stylesheet (the shell's and the four windows'), in path order. */
export function deskCss(): string {
	return deskCssFiles()
		.map((file) => readFileSync(join(APP, file), "utf-8"))
		.join("\n");
}

/** The original stylesheet, then the desk's: what a rule lookup by selector reads. */
export function allCss(): string {
	return `${legacyCss()}\n${deskCss()}`;
}

function channel(v: number): number {
	const s = v / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
	const [r, g, b] = [0, 2, 4].map((i) => channel(Number.parseInt(full.slice(i, i + 2), 16)));
	return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

/** The WCAG contrast ratio of two hex colours, 1 to 21. */
export function contrast(hexA: string, hexB: string): number {
	const a = luminance(hexA);
	const b = luminance(hexB);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
