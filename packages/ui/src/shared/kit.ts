// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The usertrust mark, loaded at runtime from usertrust.ai, OPT-IN. Brand assets are not committed to this repo
 * (the one exception is the header logo in `packages/ui/brand/`, which the page bundles): public pages load them from
 * usertrust.ai at runtime. This UI is loopback-only by default, so the mark is off
 * unless the vault config turns it on, and then it is the BROWSER that fetches it: one plain GET with no query
 * string, no cookies (`crossorigin="anonymous"`) and no referrer.
 */

/** The mark: the usertrust website's own icon, its favicon, served with `access-control-allow-origin: *`. */
export const KIT_MARK_URL = "https://usertrust.ai/favicon.svg";

/** How long the mark may take to load before the page gives up on it and shows none. */
export const KIT_TIMEOUT_MS = 5000;

/**
 * The `remote` section of `.usertrust/usertrust.config.json`: what this UI may load from outside the machine. Only
 * `kit` exists. A missing section, a missing key, or anything but the JSON boolean `true` leaves it off.
 */
export interface RemoteSettings {
	kit: boolean;
}

export function remoteSettings(config: unknown): RemoteSettings {
	const remote =
		config !== null && typeof config === "object"
			? (config as Record<string, unknown>).remote
			: undefined;
	const kit =
		remote !== null && typeof remote === "object"
			? (remote as Record<string, unknown>).kit === true
			: false;
	return { kit };
}
