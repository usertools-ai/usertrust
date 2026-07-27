// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * LLM Client Detection — duck typing for Anthropic, OpenAI, and Google SDKs.
 *
 * Uses structural checks (duck typing) to identify which SDK a client object
 * belongs to, without requiring the SDK packages as dependencies.
 *
 * **Governance boundary:** the following methods are intercepted and governed:
 * - Anthropic: `client.messages.create()`, `client.messages.stream()`,
 *   `client.beta.messages.create()`, `client.beta.messages.stream()`
 * - OpenAI: `client.chat.completions.create()`, and `client.responses.create()`
 *   when present (feature-detected — the Responses API postdates the peer-range
 *   floor, so older clients simply lack it and it stays a pass-through)
 * - Google: `client.models.generateContent()`
 *
 * Remaining ungoverned surfaces (feature-detected pass-throughs, or shapes that do
 * not mirror `create`): `client.messages.batches`, `client.beta.messages.batches`,
 * `client.beta.models`, `client.beta.files`, the OpenAI Responses non-create
 * methods (`client.responses.retrieve/cancel/delete`), the OpenAI `client.beta.*`
 * namespace (assistants/threads/realtime — a different shape from Anthropic beta),
 * and the legacy `client.completions.create`. These are **NOT** intercepted and
 * bypass governance, audit, and budget enforcement. Callers relying on ungoverned
 * methods should implement their own budget and audit controls or wrap calls
 * through the governed entry points above.
 */

import type { EndpointInfo, LLMClientKind, LocalRuntime, TrustConfig } from "./shared/types.js";

/**
 * Detect which LLM SDK a client belongs to by inspecting its shape.
 *
 * Governance boundary: the following methods are intercepted and governed:
 * - Anthropic: `client.messages.create()`, `client.messages.stream()`,
 *   `client.beta.messages.create()`, `client.beta.messages.stream()`
 * - OpenAI: `client.chat.completions.create()`, and `client.responses.create()`
 *   when present (feature-detected — the Responses API postdates the peer-range
 *   floor, so older clients simply lack it and it stays a pass-through)
 * - Google: `client.models.generateContent()`
 *
 * Remaining ungoverned pass-throughs: `client.messages.batches`,
 * `client.beta.messages.batches`, `client.beta.models`, `client.beta.files`, the
 * OpenAI Responses non-create methods (`client.responses.retrieve/cancel/delete`),
 * the OpenAI `client.beta.*` namespace (assistants/threads/realtime), and the
 * legacy `client.completions.create`. These bypass governance, audit, and budget
 * enforcement (they do not mirror the `create` request/response shape).
 *
 * @throws {Error} if the client does not match any known SDK shape
 */
export function detectClientKind(client: unknown): LLMClientKind {
	if (
		client != null &&
		typeof client === "object" &&
		"messages" in client &&
		client.messages != null &&
		typeof client.messages === "object" &&
		"create" in client.messages &&
		typeof client.messages.create === "function"
	) {
		return "anthropic";
	}

	if (
		client != null &&
		typeof client === "object" &&
		"chat" in client &&
		client.chat != null &&
		typeof client.chat === "object" &&
		"completions" in client.chat &&
		client.chat.completions != null &&
		typeof client.chat.completions === "object" &&
		"create" in client.chat.completions &&
		typeof client.chat.completions.create === "function"
	) {
		return "openai";
	}

	if (
		client != null &&
		typeof client === "object" &&
		"models" in client &&
		client.models != null &&
		typeof client.models === "object" &&
		"generateContent" in client.models &&
		typeof client.models.generateContent === "function"
	) {
		return "google";
	}

	throw new Error("Unsupported LLM client: could not detect Anthropic, OpenAI, or Google SDK");
}

// ── Endpoint classification (M2 local-model governance) ──

// Compared against normalizeHostname(url.hostname) — the WHATWG-serialized,
// bracket-stripped form. `::ffff:7f00:1` is how Node's URL serializes the
// IPv4-mapped IPv6 loopback `::ffff:127.0.0.1` (the last 32 bits render as hex,
// never dotted-quad), so the map entry MUST be the serialized form to match.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "::ffff:7f00:1"]);

/** Best-effort runtime hint by conventional default port (metadata only). */
const RUNTIME_BY_PORT: Record<string, LocalRuntime> = {
	"11434": "ollama",
	"1234": "lmstudio",
	"8000": "vllm",
};

const CLOUD_DEFAULT: EndpointInfo = { class: "cloud", runtime: "unknown" };

function parseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/**
 * Normalize a URL hostname for comparison: lowercase, IPv6 brackets stripped
 * (Node's WHATWG URL keeps brackets in `hostname` for IPv6 literals).
 */
function normalizeHostname(hostname: string): string {
	const lower = hostname.toLowerCase();
	if (lower.startsWith("[") && lower.endsWith("]")) return lower.slice(1, -1);
	return lower;
}

/**
 * Match a parsed baseURL against one config.endpoints[].match entry (A1).
 * Exactly three entry forms — never raw string prefixing:
 * (i)   scheme entry ("http://gpu-box:8000") → parsed; match iff origins are equal
 *       (path/query/trailing slash ignored; kills "http://gpu-box:8000.evil.com"
 *       and "http://gpu-box:8000@evil.com" bypass shapes);
 * (ii)  leading-star entry ("*.gpu.internal") → hostname SUFFIX match: matches
 *       "a.gpu.internal" and "x.y.gpu.internal", NOT "gpu.internal" itself;
 * (iii) bare hostname → case-insensitive hostname equality (any port).
 * Unparseable scheme entries never match (and never throw).
 */
function matchesEndpointEntry(entry: string, url: URL): boolean {
	if (/^https?:\/\//i.test(entry)) {
		const entryUrl = parseUrl(entry);
		return entryUrl !== null && entryUrl.origin === url.origin;
	}
	const host = normalizeHostname(url.hostname);
	if (entry.startsWith("*.")) {
		const suffix = entry.slice(1).toLowerCase(); // ".gpu.internal"
		return host.endsWith(suffix);
	}
	return host === entry.toLowerCase();
}

/** Read a string `baseURL` property off an SDK client instance, if present. */
function readBaseURL(client: unknown): string | undefined {
	if (client != null && typeof client === "object" && "baseURL" in client) {
		const value = (client as { baseURL?: unknown }).baseURL;
		if (typeof value === "string") return value;
	}
	return undefined;
}

/**
 * Classify the endpoint a client points at — local (self-hosted) or cloud —
 * selecting the settlement regime for every governed call. Runs BESIDE
 * `detectClientKind` (which stays the transport detector); the endpoint class,
 * not the model string, picks local vs cloud metering, so model-name spoofing
 * (`ollama cp llama3.2 gpt-4o`) cannot change the regime.
 *
 * Classification order:
 * 1. `override.class` provided → override wins (runtime defaults to "unknown").
 * 2. `client.baseURL` read when it is a string; absent or malformed (URL parse
 *    failure) → treated as absent → cloud default. Never throws.
 * 3. `config.endpoints[]` first match (origin / leading-star hostname suffix /
 *    bare hostname — see matchesEndpointEntry).
 * 4. Loopback autodetect (config.local.autoDetectLoopback): hostname
 *    localhost | 127.0.0.1 | ::1 | ::ffff:127.0.0.1 (case-insensitive, IPv6
 *    brackets stripped, IPv4-mapped form matched by its WHATWG serialization) →
 *    local, runtime hinted by port (11434 ollama, 1234 lmstudio, 8000 vllm,
 *    else "openai-compat").
 * 5. Default `{ class: "cloud", runtime: "unknown" }` — fail-EXPENSIVE:
 *    over-charging at cloud rates is recoverable, under-charging a paid
 *    endpoint is not.
 *
 * **Security posture (trusted-operator boundary):** endpoint classification —
 * config matchers, overrides, and loopback autodetect — is a TRUSTED-OPERATOR
 * decision. Never wire it to end-user or request input. In server/multi-tenant
 * deployments set `local.autoDetectLoopback: false` and classify via explicit
 * `endpoints[]` config: loopback inside a container can be a forwarding sidecar
 * to a paid API. This is the same trust boundary as `budget`/`customRates` —
 * the config author already controls billing entirely. Note that a compromised
 * local server can under-report usage; receipts expose `usageSource` and
 * `meter.rateSource` precisely so that this is auditable.
 */
export function classifyEndpoint(
	client: unknown,
	config: TrustConfig,
	override?: Partial<EndpointInfo>,
): EndpointInfo {
	const baseURL = readBaseURL(client);

	// (1) Explicit override wins over everything.
	if (override?.class !== undefined) {
		const info: EndpointInfo = { class: override.class, runtime: override.runtime ?? "unknown" };
		const overrideBase = override.baseURL ?? baseURL;
		if (overrideBase !== undefined) info.baseURL = overrideBase;
		return info;
	}

	// (2) No readable baseURL → cloud default. Malformed → treat as absent, never throw.
	if (baseURL === undefined) return { ...CLOUD_DEFAULT };
	const url = parseUrl(baseURL);
	if (url === null) return { ...CLOUD_DEFAULT };

	// (3) config.endpoints[] — first match wins.
	for (const entry of config.endpoints) {
		if (matchesEndpointEntry(entry.match, url)) {
			return { class: entry.class, runtime: entry.runtime, baseURL };
		}
	}

	// (4) Loopback autodetect.
	if (config.local.autoDetectLoopback && LOOPBACK_HOSTS.has(normalizeHostname(url.hostname))) {
		return { class: "local", runtime: RUNTIME_BY_PORT[url.port] ?? "openai-compat", baseURL };
	}

	// (5) Cloud default.
	return { class: "cloud", runtime: "unknown", baseURL };
}
