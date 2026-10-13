// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { KIT_MARK_URL, remoteSettings } from "../src/shared/kit.js";

describe("the kit mark's URL", () => {
	// The browser fetches exactly this. Anything in the query, fragment or userinfo could carry an identifier.
	it("is the usertrust website's own icon, over https, with no query string, fragment or credentials", () => {
		const url = new URL(KIT_MARK_URL);
		expect(url.protocol).toBe("https:");
		expect(url.host).toBe("usertrust.ai");
		expect(url.pathname).toBe("/favicon.svg");
		expect(url.search).toBe("");
		expect(url.hash).toBe("");
		expect(url.username + url.password).toBe("");
	});
});

describe("remoteSettings", () => {
	it("red-first (no setting existed): off unless the config says remote.kit is true", () => {
		expect(remoteSettings({ remote: { kit: true } })).toEqual({ kit: true });
	});

	it("off by default, and off for anything but the JSON boolean true", () => {
		for (const config of [
			undefined,
			null,
			"remote",
			{},
			{ budget: 1000 },
			{ remote: null },
			{ remote: true },
			{ remote: {} },
			{ remote: { kit: "true" } },
			{ remote: { kit: 1 } },
			{ remote: { kit: false } },
		])
			expect(remoteSettings(config)).toEqual({ kit: false });
	});

	it("a sibling key in the section (a later remote.proxy) does not change kit", () => {
		expect(remoteSettings({ remote: { kit: true, proxy: "https://example.com" } })).toEqual({
			kit: true,
		});
		expect(remoteSettings({ remote: { proxy: "https://example.com" } })).toEqual({ kit: false });
	});
});
