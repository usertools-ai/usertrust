// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

export type Provider = "anthropic" | "openai";
export type MeteredRoute = "anthropic.messages" | "openai.chat" | "openai.responses";

export interface RouteConfig {
	/** Host (lowercase, no port) → the provider whose wire it speaks. */
	hosts: Record<string, Provider>;
	/**
	 * Non-billable routes passed through UNMETERED, e.g. `GET api.openai.com
	 * /v1/models`. Each names its HOST: the same path on another host is denied.
	 * Empty by default: an unlisted route is denied, never assumed free.
	 */
	passthrough: Array<{ host: string; method: string; path: string }>;
}

export const DEFAULT_ROUTE_CONFIG: RouteConfig = {
	hosts: { "api.anthropic.com": "anthropic", "api.openai.com": "openai" },
	passthrough: [],
};

const METERED: Record<Provider, Record<string, MeteredRoute>> = {
	anthropic: { "/v1/messages": "anthropic.messages" },
	openai: { "/v1/chat/completions": "openai.chat", "/v1/responses": "openai.responses" },
};

export type RouteMatch =
	| { kind: "metered"; provider: Provider; route: MeteredRoute }
	| { kind: "passthrough" }
	| { kind: "unsupported" };

/** `api.openai.com:443` and `API.OpenAI.com` are the same host. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/:443$/, "");
}

/** The path without its query string or a trailing slash. */
export function normalizePath(path: string): string {
	const q = path.indexOf("?");
	const p = q === -1 ? path : path.slice(0, q);
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * DEFAULT-DENY: a request is metered only on an exact (host, POST, path) match,
 * passed through only on an exact allowlist match, and `unsupported` otherwise —
 * including any request to a host the config does not name. An unlisted
 * billable endpoint (embeddings, images, audio, batch, files) is a credentialed,
 * chargeable call with no hold: a budget bypass.
 */
export function matchRoute(
	method: string,
	host: string,
	path: string,
	config: RouteConfig = DEFAULT_ROUTE_CONFIG,
): RouteMatch {
	const m = method.toUpperCase();
	const p = normalizePath(path);
	const h = normalizeHost(host);
	const provider = Object.hasOwn(config.hosts, h) ? config.hosts[h] : undefined;
	if (provider !== undefined && m === "POST" && Object.hasOwn(METERED[provider], p)) {
		const route = METERED[provider][p];
		if (route !== undefined) return { kind: "metered", provider, route };
	}
	const passes = config.passthrough.some(
		(r) =>
			normalizeHost(r.host) === h && r.method.toUpperCase() === m && normalizePath(r.path) === p,
	);
	if (passes) {
		return { kind: "passthrough" };
	}
	return { kind: "unsupported" };
}
