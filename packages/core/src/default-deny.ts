// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Default-deny for Anthropic and OpenAI clients.
 *
 * `trust()` governs a handful of methods on each client (see detect.ts's boundary block). Every
 * OTHER method reached off the governed client, at any depth, is refused: the call rejects with a
 * PolicyDeniedError naming the method path, after a `policy_denied` event is on the chain, and the
 * SDK is never called. Two lists relax it:
 *
 *   - the FREE list below: methods that cannot spend (reads, lists, deletes, cancels, token
 *     counts, local signature checks). They run on the RAW SDK resource, unaudited.
 *   - `trust({ allowUngoverned })`: methods the operator chose to run ungoverned. They run on the
 *     raw resource too, and each call appends an `ungoverned_call` event (no usage, no cost).
 *
 * WHAT IS SUBJECT TO THE BOUNDARY. A property read off the governed client, or off any SDK
 * resource reached from it, is refused when ALL of these hold:
 *   1. its key is a string (symbol-keyed members — `Symbol.toStringTag`, `util.inspect.custom`,
 *      `Symbol.asyncIterator` — always pass);
 *   2. its value is a function (strings, numbers, booleans and plain config pass);
 *   3. its name is not one `Object.prototype` carries (`constructor`, `toString`, `valueOf`,
 *      `hasOwnProperty`, …) and is not `toJSON`, so inspection and serialization keep working.
 * A value that is an SDK resource (an object carrying the SDK's `_client`) is wrapped the same
 * way, recursively, so `client.beta.threads.runs.create` is refused. Return values of calls (a
 * Page, a Batch) are never wrapped. `then` is never defined by the SDK, so it stays `undefined`
 * and neither the client nor a resource becomes thenable.
 *
 * WHY FREE METHODS RUN ON THE RAW RESOURCE. An SDK method reaches the network through
 * `this._client`, and some read `#private` members off `this` (OpenAI's webhooks). Through the
 * boundary `this._client` is a refusing stand-in, so a free method bound to the proxy would be
 * refused by its own transport.
 *
 * ESCAPE HATCHES, closed by name: a resource's `_client` is the SDK's raw client, so reading it
 * returns a stand-in on which every call is refused; the client's raw HTTP members (`post`,
 * `get`, `request`, …) are refused and cannot be listed in `allowUngoverned`; and `withOptions`
 * returns a governed client (governed.ts builds it with the same governor).
 *
 * Duck-typed like detect.ts: no provider SDK is imported here.
 */

import { PolicyDeniedError } from "./shared/errors.js";

export type DefaultDenyProvider = "anthropic" | "openai";

/** The event kind an `allowUngoverned` call appends. Carries no usage and no cost. */
export const UNGOVERNED_CALL_KIND = "ungoverned_call" as const;

/**
 * Refuse one ungoverned call: write its `policy_denied` event at the denial boundary, then reject
 * with `error` (default: the generic ungoverned-method refusal for the path). Built by `trust()`,
 * which owns the audit writer; the proxies only know the method's path.
 */
export type RefuseFn = (path: string, args: unknown[], error?: PolicyDeniedError) => Promise<never>;

/** Everything the boundary needs from the governor that built it. One per `trust()` call. */
export interface MethodBoundary {
	readonly provider: DefaultDenyProvider;
	readonly refuse: RefuseFn;
	/** Paths from `allowUngoverned`, already validated. */
	readonly allowUngoverned: ReadonlySet<string>;
	/** Run a listed method on its raw resource, auditing it as `ungoverned_call`. */
	readonly callUngoverned: (
		path: string,
		fn: (...args: unknown[]) => unknown,
		thisArg: object,
		args: unknown[],
	) => unknown;
	/** Wrap the raw client `withOptions` returned, with the same governor. */
	readonly rewrap: (fresh: unknown) => unknown;
	/** Raw resource → its guarded proxy, so a resource is the same object on every read. */
	readonly resources: WeakMap<object, object>;
	/** Stand-in path → (raw object → its stand-in). Stable identity keeps JSON's cycle check working. */
	readonly standIns: Map<string, WeakMap<object, object>>;
}

// ── The free list ──
// Built from a sweep of every billable method on @anthropic-ai/sdk 0.116.0 and openai 7.4.0.
// Each entry cites the method's definition in the SDK's CommonJS build (the file that runs) and
// the request it makes. A method is free only if it cannot start billable work: no model run,
// no storage, no session. Rows the sweep could not confirm as free are NOT here (they are refused,
// fail closed), and neither are "free" creates that can allocate billed storage.

const ANTHROPIC_FREE_METHODS: ReadonlySet<string> = new Set([
	"messages.countTokens", // resources/messages/messages.js:111 POST /v1/messages/count_tokens
	"messages.batches.retrieve", // resources/messages/batches.js:66 GET
	"messages.batches.list", // resources/messages/batches.js:84 GET /v1/messages/batches
	"messages.batches.delete", // resources/messages/batches.js:102 DELETE
	"messages.batches.cancel", // resources/messages/batches.js:126 POST …/cancel
	"messages.batches.results", // resources/messages/batches.js:145 GET results_url (billed at processing, not download)
	"beta.messages.countTokens", // resources/beta/messages/messages.js:108 POST /v1/messages/count_tokens?beta=true
	"beta.messages.batches.retrieve", // resources/beta/messages/batches.js:71 GET
	"beta.messages.batches.list", // resources/beta/messages/batches.js:96 GET /v1/messages/batches?beta=true
	"beta.messages.batches.delete", // resources/beta/messages/batches.js:124 DELETE
	"beta.messages.batches.cancel", // resources/beta/messages/batches.js:156 POST …/cancel
	"beta.messages.batches.results", // resources/beta/messages/batches.js:184 GET results_url
	// beta.files.upload is NOT here: it creates stored content (refused, fail closed).
	"beta.files.list", // resources/beta/files.js:23 GET /v1/files?beta=true
	"beta.files.delete", // resources/beta/files.js:44 DELETE
	"beta.files.download", // resources/beta/files.js:67 GET …/content
	"beta.files.retrieveMetadata", // resources/beta/files.js:90 GET
	"models.retrieve", // resources/models.js:16 GET
	"models.list", // resources/models.js:32 GET /v1/models
	"beta.models.retrieve", // resources/beta/models.js:23 GET
	"beta.models.list", // resources/beta/models.js:47 GET /v1/models?beta=true
	"beta.webhooks.unwrap", // resources/beta/webhooks.js:8 local: verifies a signature, sends nothing
]);

const OPENAI_FREE_METHODS: ReadonlySet<string> = new Set([
	"chat.completions.retrieve", // resources/chat/completions/completions.js:41 GET (stored completion)
	"chat.completions.update", // resources/chat/completions/completions.js:60 POST (metadata only)
	"chat.completions.list", // resources/chat/completions/completions.js:79 GET /chat/completions
	"chat.completions.delete", // resources/chat/completions/completions.js:96 DELETE
	"chat.completions.messages.list", // resources/chat/completions/messages.js:26 GET
	"responses.retrieve", // resources/responses/responses.js:34 GET (incl. resuming a stream)
	"responses.delete", // resources/responses/responses.js:57 DELETE
	"responses.cancel", // resources/responses/responses.js:87 POST …/cancel
	"responses.inputItems.list", // resources/responses/input-items.js:22 GET
	"beta.responses.retrieve", // resources/beta/responses/responses.js:32 GET
	"beta.responses.delete", // resources/beta/responses/responses.js:55 DELETE
	"beta.responses.cancel", // resources/beta/responses/responses.js:78 POST …/cancel
	"moderations.create", // resources/moderations.js:14 POST /moderations (priced "Free")
	"batches.retrieve", // resources/batches.js:21 GET
	"batches.list", // resources/batches.js:27 GET /batches
	"batches.cancel", // resources/batches.js:39 POST …/cancel
	"fineTuning.jobs.retrieve", // resources/fine-tuning/jobs/jobs.js:51 GET
	"fineTuning.jobs.list", // resources/fine-tuning/jobs/jobs.js:68 GET /fine_tuning/jobs
	"fineTuning.jobs.cancel", // resources/fine-tuning/jobs/jobs.js:85 POST …/cancel
	"fineTuning.jobs.listEvents", // resources/fine-tuning/jobs/jobs.js:104 GET …/events
	"fineTuning.jobs.pause", // resources/fine-tuning/jobs/jobs.js:117 POST …/pause
	"fineTuning.jobs.checkpoints.list", // resources/fine-tuning/jobs/checkpoints.js:25 GET
	"fineTuning.checkpoints.permissions.create", // resources/fine-tuning/checkpoints/permissions.js:29 POST (an access grant)
	"fineTuning.checkpoints.permissions.retrieve", // resources/fine-tuning/checkpoints/permissions.js:40 GET
	"fineTuning.checkpoints.permissions.list", // resources/fine-tuning/checkpoints/permissions.js:63 GET
	"fineTuning.checkpoints.permissions.delete", // resources/fine-tuning/checkpoints/permissions.js:84 DELETE
	"fineTuning.alpha.graders.validate", // resources/fine-tuning/alpha/graders.js:51 POST …/validate (runs no grader)
	// beta.assistants.create and beta.threads.create are NOT here: `tool_resources.file_search.
	// vector_stores` creates a vector store (billed storage; assistants.d.ts:1009, threads.d.ts:291).
	// beta.threads.messages.create is NOT here: a file_search attachment adds billed storage.
	"beta.assistants.retrieve", // resources/beta/assistants.js:31 GET
	"beta.assistants.update", // resources/beta/assistants.js:43 POST (update params only reference stores)
	"beta.assistants.list", // resources/beta/assistants.js:56 GET /assistants
	"beta.assistants.delete", // resources/beta/assistants.js:69 DELETE
	"beta.threads.retrieve", // resources/beta/threads/threads.js:43 GET
	"beta.threads.update", // resources/beta/threads/threads.js:55 POST (update params only reference stores)
	"beta.threads.delete", // resources/beta/threads/threads.js:68 DELETE
	"beta.threads.messages.retrieve", // resources/beta/threads/messages.js:33 GET
	"beta.threads.messages.update", // resources/beta/threads/messages.js:46 POST (metadata only)
	"beta.threads.messages.list", // resources/beta/threads/messages.js:60 GET
	"beta.threads.messages.delete", // resources/beta/threads/messages.js:73 DELETE
	"beta.threads.runs.steps.retrieve", // resources/beta/threads/runs/steps.js:20 GET
	"beta.threads.runs.steps.list", // resources/beta/threads/runs/steps.js:34 GET
	"realtime.calls.hangup", // resources/realtime/calls.js:36 POST …/hangup
	"realtime.calls.refer", // resources/realtime/calls.js:53 POST …/refer
	"realtime.calls.reject", // resources/realtime/calls.js:69 POST …/reject
	"videos.retrieve", // resources/videos.js:20 GET
	"videos.list", // resources/videos.js:26 GET /videos
	"videos.delete", // resources/videos.js:36 DELETE
	"videos.downloadContent", // resources/videos.js:50 GET …/content
	"videos.getCharacter", // resources/videos.js:75 GET
	"evals.create", // resources/evals/evals.js:27 POST /evals (a definition; runs are refused)
	"evals.retrieve", // resources/evals/evals.js:33 GET
	"evals.update", // resources/evals/evals.js:39 POST
	"evals.list", // resources/evals/evals.js:45 GET /evals
	"evals.delete", // resources/evals/evals.js:55 DELETE
	"evals.runs.retrieve", // resources/evals/runs/runs.js:34 GET
	"evals.runs.list", // resources/evals/runs/runs.js:44 GET
	"evals.runs.delete", // resources/evals/runs/runs.js:54 DELETE
	"evals.runs.cancel", // resources/evals/runs/runs.js:64 POST
	"evals.runs.outputItems.retrieve", // resources/evals/runs/output-items.js:15 GET
	"evals.runs.outputItems.list", // resources/evals/runs/output-items.js:25 GET
	"conversations.create", // resources/conversations/conversations.js:21 POST /conversations (state; spend lands on responses.create)
	"conversations.retrieve", // resources/conversations/conversations.js:27 GET
	"conversations.update", // resources/conversations/conversations.js:36 POST
	"conversations.delete", // resources/conversations/conversations.js:46 DELETE
	"conversations.items.create", // resources/conversations/items.js:15 POST
	"conversations.items.retrieve", // resources/conversations/items.js:27 GET
	"conversations.items.list", // resources/conversations/items.js:38 GET
	"conversations.items.delete", // resources/conversations/items.js:44 DELETE
	"models.retrieve", // resources/models.js:16 GET
	"models.list", // resources/models.js:23 GET /models
	"models.delete", // resources/models.js:30 DELETE (a fine-tuned model)
	"webhooks.unwrap", // resources/webhooks/webhooks.js:18 local: verifies a signature, sends nothing
	"webhooks.verifySignature", // resources/webhooks/webhooks.js:32 local
	// The native Usage and Costs API (reads). The rest of `admin.organization` (keys, spend
	// limits, projects) is administrative and stays refused.
	"admin.organization.usage.audioSpeeches", // resources/admin/organization/usage.js:18 GET
	"admin.organization.usage.audioTranscriptions", // resources/admin/organization/usage.js:36 GET
	"admin.organization.usage.codeInterpreterSessions", // resources/admin/organization/usage.js:54 GET
	"admin.organization.usage.completions", // resources/admin/organization/usage.js:72 GET
	"admin.organization.usage.costs", // resources/admin/organization/usage.js:90 GET /organization/costs
	"admin.organization.usage.embeddings", // resources/admin/organization/usage.js:108 GET
	"admin.organization.usage.fileSearchCalls", // resources/admin/organization/usage.js:126 GET
	"admin.organization.usage.images", // resources/admin/organization/usage.js:144 GET
	"admin.organization.usage.moderations", // resources/admin/organization/usage.js:162 GET
	"admin.organization.usage.vectorStores", // resources/admin/organization/usage.js:180 GET
	"admin.organization.usage.webSearchCalls", // resources/admin/organization/usage.js:198 GET
]);

const FREE_METHODS: Record<DefaultDenyProvider, ReadonlySet<string>> = {
	anthropic: ANTHROPIC_FREE_METHODS,
	openai: OPENAI_FREE_METHODS,
};

/**
 * The client's own raw HTTP members (both SDKs' `BaseAnthropic` / `OpenAI` client classes). Each
 * sends an arbitrary request with the client's credentials, so it is refused by name and can never
 * be listed in `allowUngoverned`. Every other client-level function is refused by default anyway.
 */
const RAW_TRANSPORT_METHODS: ReadonlySet<string> = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"request",
	"methodRequest",
	"makeRequest",
	"getAPIList",
	"requestAPIList",
	"fetch",
	"fetchWithAuth",
	"fetchWithTimeout",
	"retryRequest",
]);

const PROVIDER_NAME: Record<DefaultDenyProvider, string> = {
	anthropic: "an Anthropic",
	openai: "an OpenAI",
};

const GOVERNED_METHODS: Record<DefaultDenyProvider, string> = {
	anthropic: "messages.create, messages.stream and messages.parse (and the same on beta.messages)",
	openai: "chat.completions.create and responses.create",
};

/** The refusal for an SDK method usertrust does not govern and the free list does not name. */
export function ungovernedMethodError(
	provider: DefaultDenyProvider,
	path: string,
): PolicyDeniedError {
	return new PolicyDeniedError(
		`ungoverned_method: ${path} is not governed on ${PROVIDER_NAME[provider]} client`,
		`usertrust governs ${GOVERNED_METHODS[provider]} on ${PROVIDER_NAME[provider]} client, and refuses every other SDK method that is not on its free list rather than let it run unmetered. To run this one anyway, list it in trust({ allowUngoverned: ["${path}"] }): each call is then audited as ungoverned_call, with no budget hold and no cost.`,
	);
}

/** The refusal for a call reached through a raw client: `_client`, or a client-level HTTP member. */
function rawClientError(provider: DefaultDenyProvider, path: string): PolicyDeniedError {
	return new PolicyDeniedError(
		`ungoverned_method: ${path} is not governed on ${PROVIDER_NAME[provider]} client`,
		`${path} sends requests on the SDK's raw client, which nothing governs, so every call through it is refused, and allowUngoverned cannot list it. Call the method on the governed client instead.`,
	);
}

/** The refusal for every call through a `withOptions` client that points somewhere else. */
export function endpointMovedError(provider: DefaultDenyProvider): PolicyDeniedError {
	return new PolicyDeniedError(
		`ungoverned_method: withOptions is not governed on ${PROVIDER_NAME[provider]} client when it changes the endpoint`,
		"A governed client meters every call for the endpoint trust() classified when it wrapped the client, so a withOptions() client that points elsewhere is refused. Wrap a client built for that endpoint with its own trust() call.",
	);
}

/**
 * Validate `trust({ allowUngoverned })` at creation: an array of non-empty method paths. A path
 * through a raw client (`_client`, or a client-level HTTP member) is refused here rather than
 * silently ignored at call time. Returns the set the boundary reads.
 */
export function validateAllowUngoverned(value: unknown): ReadonlySet<string> {
	if (value === undefined) return new Set();
	if (!Array.isArray(value)) {
		throw new TypeError(
			'usertrust: allowUngoverned must be an array of SDK method paths, such as ["embeddings.create"].',
		);
	}
	const paths = new Set<string>();
	for (const entry of value as unknown[]) {
		if (typeof entry !== "string" || entry.length === 0) {
			throw new TypeError(
				`usertrust: allowUngoverned entries must be non-empty method paths, got ${typeof entry === "string" ? "an empty string" : typeof entry}.`,
			);
		}
		const segments = entry.split(".");
		if (
			segments.includes("_client") ||
			(segments.length === 1 && RAW_TRANSPORT_METHODS.has(entry))
		) {
			throw new TypeError(
				`usertrust: allowUngoverned cannot list "${entry}": it reaches the SDK's raw client, which is always refused.`,
			);
		}
		paths.add(entry);
	}
	return paths;
}

/** Names that pass whatever they hold: Object.prototype's members, and JSON's `toJSON` hook. */
function isInertName(prop: string): boolean {
	return prop in Object.prototype || prop === "toJSON";
}

/** An SDK resource: every APIResource stores the client it was built from as `_client`. */
function isResource(value: unknown): value is object {
	return value !== null && typeof value === "object" && "_client" in value;
}

/**
 * The boundary's `get`: what reading `prop` off `target` (a raw SDK resource, or the raw client,
 * reached at `path`) returns through the governed client. The governed proxies call it for every
 * name they do not trap themselves; it replaces their former `Reflect.get` fall-through.
 */
export function guardedGet(
	target: object,
	prop: string | symbol,
	receiver: unknown,
	path: string,
	boundary: MethodBoundary,
): unknown {
	const value: unknown = Reflect.get(target, prop, receiver);
	if (typeof prop === "symbol" || isInertName(prop)) return value;
	const at = path === "" ? prop : `${path}.${prop}`;
	if (prop === "_client" && value !== null && typeof value === "object") {
		return rawClientStandIn(value, at, boundary, rawClientError(boundary.provider, at));
	}
	if (typeof value === "function") {
		const fn = value as (...args: unknown[]) => unknown;
		if (path === "" && RAW_TRANSPORT_METHODS.has(prop)) {
			return (...args: unknown[]) =>
				boundary.refuse(at, args, rawClientError(boundary.provider, at));
		}
		// Free and listed methods run on the RAW resource: see the module comment.
		if (FREE_METHODS[boundary.provider].has(at)) {
			return (...args: unknown[]) => fn.apply(target, args);
		}
		if (boundary.allowUngoverned.has(at)) {
			return (...args: unknown[]) => boundary.callUngoverned(at, fn, target, args);
		}
		return (...args: unknown[]) => boundary.refuse(at, args);
	}
	if (isResource(value)) return guardResource(value, at, boundary);
	return value;
}

/** A nested SDK resource behind the boundary. One proxy per raw resource. */
function guardResource(resource: object, path: string, boundary: MethodBoundary): object {
	const cached = boundary.resources.get(resource);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(resource, {
		get(target, prop, receiver) {
			return guardedGet(target, prop, receiver, path, boundary);
		},
	});
	boundary.resources.set(resource, proxy);
	return proxy;
}

/**
 * A stand-in for a raw client (or anything reached from one): every function reached through it,
 * at any depth, is refused with `error`, under the one `path` the raw client was reached at.
 * Values that are not functions read through unchanged, objects as further stand-ins. Getters run
 * on the raw object, so a getter that reads a `#private` field does not throw on the stand-in.
 */
export function rawClientStandIn(
	raw: object,
	path: string,
	boundary: MethodBoundary,
	error: PolicyDeniedError,
): object {
	let byRaw = boundary.standIns.get(path);
	if (byRaw === undefined) {
		byRaw = new WeakMap();
		boundary.standIns.set(path, byRaw);
	}
	const cached = byRaw.get(raw);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(raw, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof prop === "symbol" || isInertName(prop)) return value;
			if (typeof value === "function") {
				return (...args: unknown[]) => boundary.refuse(path, args, error);
			}
			if (value !== null && typeof value === "object") {
				return rawClientStandIn(value, path, boundary, error);
			}
			return value;
		},
	});
	byRaw.set(raw, proxy);
	return proxy;
}
