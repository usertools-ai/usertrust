// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The status under the header's "As recorded at" line: why a point did not show, that a reload may have renamed it, and
 * that the views below are catching up. One always-mounted element, empty when idle.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}

interface Props {
	error: string | null;
	reloaded: boolean;
	holdNote?: string | null;
	announce?: string;
}

let AtStatus: Component<Props>;
beforeAll(async () => {
	AtStatus = (await app<{ AtStatus: typeof AtStatus }>("at-status")).AtStatus;
});

const render = (over: Partial<Props> = {}): string =>
	renderToStaticMarkup(createElement(AtStatus, { error: null, reloaded: false, ...over }));
const note = (html: string): string =>
	/<p[^>]*class="ut-tl-msg"[^>]*role="status"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? "<missing>";

describe("AtStatus", () => {
	// The approved design's words: the note says only that the point did not show. Whether a past point or the live
	// vault is on screen is the header's to say ("As recorded at", or nothing when live).
	it("an error says only that the point did not show", () => {
		expect(note(render({ error: "the dashboard did not answer" }))).toBe(
			"Could not show that point: the dashboard did not answer.",
		);
		expect(note(render({ error: "the vault has no records" }))).toBe(
			"Could not show that point: the vault has no records.",
		);
	});

	it("an error and a reload together say both, the error first", () => {
		expect(note(render({ error: "the dashboard did not answer", reloaded: true }))).toBe(
			"Could not show that point: the dashboard did not answer. Read again because the vault was reloaded: this position may now name another record.",
		);
	});

	it("a reload says the position may now name another record", () => {
		expect(note(render({ reloaded: true }))).toBe(
			"Read again because the vault was reloaded: this position may now name another record.",
		);
	});

	it("idle: the note is there and empty, the announcer is there, the held note is aria-hidden", () => {
		const html = render();
		expect(html).toMatch(/<p[^>]*class="ut-tl-msg"[^>]*role="status"[^>]*><\/p>/);
		expect(html).toMatch(/<span class="sr-only" role="status"><\/span>/);
		expect(html).toMatch(/<span class="ut-tl-held" aria-hidden="true"><\/span>/);
	});

	it("a held note is shown to the eye and announced once, by the announcer", () => {
		const html = render({
			holdNote: "Updating to record 62…",
			announce: "Updating to record 62…",
		});
		expect(html).toMatch(
			/<span class="ut-tl-held" aria-hidden="true">Updating to record 62…<\/span>/,
		);
		expect(html).toMatch(/<span class="sr-only" role="status">Updating to record 62…<\/span>/);
	});
});
