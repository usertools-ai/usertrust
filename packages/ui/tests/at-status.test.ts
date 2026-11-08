// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The status under the header's "As recorded at" line: why a point did not show, that a reload may have renamed it, and
 * that the views below are catching up. One always-mounted element, empty when idle.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";

type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}

interface Props {
	at: AtPayload | null;
	error: string | null;
	reloaded: boolean;
	holdNote?: string | null;
	announce?: string;
}

let AtStatus: Component<Props>;
beforeAll(async () => {
	AtStatus = (await app<{ AtStatus: typeof AtStatus }>("at-status")).AtStatus;
});

const shown = { pos: 40, head: 99, ts: "2026-11-06T10:04:05.000Z", clamped: false } as AtPayload;
const render = (over: Partial<Props> = {}): string =>
	renderToStaticMarkup(
		createElement(AtStatus, { at: null, error: null, reloaded: false, ...over }),
	);
const note = (html: string): string =>
	/<p[^>]*class="ut-tl-msg"[^>]*role="status"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? "<missing>";

describe("AtStatus", () => {
	it("an error with a past answer shown says the last point is still showing", () => {
		expect(note(render({ at: shown, error: "the dashboard did not answer" }))).toBe(
			"Could not show that point: the dashboard did not answer. Still showing the last point loaded.",
		);
	});

	it("an error with nothing shown says the live vault is shown", () => {
		expect(note(render({ error: "the vault has no records" }))).toBe(
			"Could not show that point: the vault has no records; showing the live vault.",
		);
	});

	it("a reload says the position may now name another record", () => {
		expect(note(render({ at: shown, reloaded: true }))).toBe(
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
			at: shown,
			holdNote: "Updating to record 62…",
			announce: "Updating to record 62…",
		});
		expect(html).toMatch(
			/<span class="ut-tl-held" aria-hidden="true">Updating to record 62…<\/span>/,
		);
		expect(html).toMatch(/<span class="sr-only" role="status">Updating to record 62…<\/span>/);
	});
});
