// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { faviconHref } from "./src/shared/favicon.js";

/**
 * Injects the tab icon into index.html from the bundled mark, read at build (and dev) time. index.html names no icon
 * of its own: a hand-inlined copy would drift from the pinned mark.
 */
export function faviconPlugin(markPath: string): Plugin {
	return {
		name: "usertrust-favicon",
		transformIndexHtml() {
			return [
				{
					tag: "link",
					attrs: {
						rel: "icon",
						type: "image/svg+xml",
						href: faviconHref(readFileSync(markPath, "utf-8")),
					},
					injectTo: "head",
				},
			];
		},
	};
}
