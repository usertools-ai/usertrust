// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Default-deny for Anthropic, OpenAI and Google clients.
 *
 * `trust()` governs a handful of methods on each client (see detect.ts's boundary block). Every
 * OTHER method reached off the governed client, at any depth, is refused: the call rejects with a
 * PolicyDeniedError naming the method path, after a `policy_denied` event is on the chain, and the
 * SDK is never called. Two lists relax it:
 *
 *   - the FREE list below: every method whose requests are all GET or DELETE, plus POSTs
 *     named with a reason (token counts, cancels, …) and local signature checks, minus named
 *     exceptions. They run on the RAW SDK resource, unaudited.
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
 * A value that is an SDK resource (an object carrying the SDK's `_client`; on Google, see
 * `isResource`) is wrapped the same way, recursively, so `client.beta.threads.runs.create` is
 * refused. A method keeps its identity across reads. Return values of calls (a Page, a Batch, a
 * Pager) are never wrapped. `then` is never defined by the SDK, so it stays `undefined` and
 * neither the client nor a resource becomes thenable.
 *
 * ON GOOGLE, members are read with the RAW target as receiver, so the client's `interactions` /
 * `webhooks` getters run on the raw client (they call `this.getNextGenClient()` and cache on
 * `this`). The transport members are stand-ins by name (`GOOGLE_RAW_MEMBERS`,
 * `GOOGLE_TRANSPORT_OBJECTS`), and a method is decided by its PATH: the SDK's raw `Models` reached
 * as `chats.modelsModule` is guarded there, where `generateContent` is not governed.
 *
 * WHY FREE METHODS RUN ON THE RAW RESOURCE. An SDK method reaches the network through
 * `this._client`, and some read `#private` members off `this` (OpenAI's webhooks). Through the
 * boundary `this._client` is a refusing stand-in, so a free method bound to the proxy would be
 * refused by its own transport.
 *
 * ESCAPE HATCHES, closed by name: a resource's `_client` (on Google also `apiClient`,
 * `_nextGenClient` and the Live transports) is the SDK's raw client, so reading it returns a
 * stand-in on which every call is refused; the client's raw HTTP members (`post`,
 * `get`, `request`, …) are refused and cannot be listed in `allowUngoverned`; and `withOptions`
 * returns a governed client (govern.ts builds it with the same governor). WRITES through the
 * governed client (assignment, `defineProperty`, `delete`) throw a TypeError, and the client's
 * transport objects (`middleware`, `_options`, …) are read through read-only views, because every
 * proxy's target is the raw SDK object and an untrapped write would land on it.
 *
 * Duck-typed like detect.ts: no provider SDK is imported here.
 */

import { types as utilTypes } from "node:util";
import { PolicyDeniedError } from "./shared/errors.js";

/** The built-in, captured at module load: a caller who patches it later cannot make a fake constructor look native. */
const functionToString = Function.prototype.toString;

/** An own DATA property's value, read from its descriptor (never through a getter); `undefined` otherwise. */
function ownDataValue(obj: object, key: string): { value: unknown } | undefined {
	const d = Object.getOwnPropertyDescriptor(obj, key);
	return d !== undefined && "value" in d ? { value: d.value } : undefined;
}

/**
 * `proto` is SOME realm's `Object.prototype` (this one, or a `vm` context's, a test runner's):
 * it has no prototype of its own, and its own `constructor` is a DATA property holding a
 * native function named "Object" whose own `prototype` is `proto` itself. Read through
 * descriptors only, with the captured `Function.prototype.toString`, and a Proxy anywhere is
 * not plain, so no caller code runs. A user class's prototype, or a user function named
 * "Object", fails it; a deliberately forged prototype can pass (see `hasNativeConstructor`).
 */
function isRealmObjectPrototype(proto: unknown): boolean {
	if (proto === Object.prototype) return true;
	if (proto === null || typeof proto !== "object" || utilTypes.isProxy(proto)) return false;
	if (Object.getPrototypeOf(proto) !== null) return false;
	return hasNativeConstructor(proto, "Object");
}

/**
 * `proto`'s own `constructor` is a DATA property holding a non-Proxy native function whose own
 * `name` is `name` and whose own `prototype` is `proto`, read through descriptors and the
 * captured `Function.prototype.toString` only. This recognises a realm's prototype by SHAPE; it
 * does not prove it: a bound function's toString reads as native code, and a bound function can
 * be given an own `name` and an own `prototype` that points back (see `plainObject` for why that
 * gains nothing here).
 */
function hasNativeConstructor(proto: object, name: string): boolean {
	const ctor = ownDataValue(proto, "constructor")?.value;
	if (typeof ctor !== "function" || utilTypes.isProxy(ctor)) return false;
	return (
		ownDataValue(ctor, "name")?.value === name &&
		ownDataValue(ctor, "prototype")?.value === proto &&
		functionToString.call(ctor).includes("[native code]")
	);
}

export type DefaultDenyProvider = "anthropic" | "openai" | "google";

/** The event kind an `allowUngoverned` call appends. Carries no usage and no cost. */
export const UNGOVERNED_CALL_KIND = "ungoverned_call" as const;

/**
 * Refuse one ungoverned call: write its `policy_denied` event at the denial boundary, then reject
 * with `error` (default: the generic ungoverned-method refusal for the path). Built by `trust()`,
 * which owns the audit writer; the proxies only know the method's path.
 */
export type RefuseFn = (path: string, args: unknown[], error?: PolicyDeniedError) => Promise<never>;

/** A cached method wrapper, with the raw function it was built for. */
export interface MethodWrapper {
	readonly fn: unknown;
	readonly wrapper: (...args: unknown[]) => unknown;
}

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
	readonly rewrap: (fresh: unknown, options: unknown) => unknown;
	/**
	 * Resource path → (raw resource → its guarded proxy), so a resource is the same object on every
	 * read. Keyed by path first: a proxy decides by the path it was reached at, so one raw object
	 * reachable at two paths gets one proxy per path.
	 */
	readonly resources: Map<string, WeakMap<object, object>>;
	/** Stand-in path → (raw object → its stand-in). Stable identity keeps JSON's cycle check working. */
	readonly standIns: Map<string, WeakMap<object, object>>;
	/**
	 * Method wrappers, so `client.models.list === client.models.list`: resource path → raw target →
	 * member name → the wrapper (and the raw function it was built for). Keyed by target, not by the
	 * raw function: a prototype method is shared by every instance, and each wrapper closes over its
	 * own target. A member the SDK later replaces gets a new wrapper.
	 */
	readonly methods: Map<string, WeakMap<object, Map<string, MethodWrapper>>>;
	/** Raw transport object → its read-only view (`TRANSPORT_OBJECTS`). */
	readonly readOnly: WeakMap<object, object>;
}

/**
 * The SDK versions the free list below was classified on, and so the floors of the
 * `peerDependencies` in packages/core/package.json: the supported range IS the verified range.
 * An older SDK exposes method names the classification never saw. `default-deny.test.ts` fails
 * when a floor and this constant disagree, so neither moves without re-running the classification.
 */
export const CLASSIFIED_SDK_VERSIONS = {
	openai: "7.4.0",
	anthropic: "0.116.0",
	google: "1.52.0",
} as const;

// ── The free list ──
// Every method on the resource trees of @anthropic-ai/sdk 0.116.0 and openai 7.4.0 (and, further
// below, @google/genai 1.52.0) was enumerated
// and classified by the HTTP verb its source sends (`this._client.get/post/delete/…`, following
// calls to sibling methods). The rule:
//   - a method whose requests are all GET or DELETE is free: a read cannot start billable work,
//     and a delete only reduces storage; and a GET or DELETE is still refused when, in
//     substance, it starts billable work or lifts a spend control (the two categories below);
//   - a POST is free only for the reason written beside it (a token count, a moderation, a
//     cancel or pause, a metadata update, a validation, an access grant, a state object whose
//     spend lands on a governed method);
//   - a local method (no request) is free only when named;
//   - anything else, including every helper that drives the raw client, is refused.
// Each entry cites the method's definition in the SDK's CommonJS build (the file that runs).
// `tests/govern/default-deny.test.ts` calls every entry through the governed client and fails
// on a POST that is not in its own list of free POSTs.
//
// Refused despite GET or DELETE, by category:
// (1) It STARTS billable work. Every GET was checked; this is the only one found.
//     `responses.retrieve({ stream: true })` resumes a response that is already running and
//     billed, and the session event streams observe a session; neither starts anything.
//   - Anthropic beta.environments.work.poll (resources/beta/environments/work.js:165) GET: it
//     claims a queued work item for a self-hosted worker, which then runs the session (billed
//     session runtime).
// (2) It LIFTS a spend control: a governed client must not remove the customer's own limits.
//   - OpenAI admin.organization.spendLimit.delete (resources/admin/organization/spend-limit.js:51) DELETE
//   - OpenAI admin.organization.projects.spendLimit.delete (resources/admin/organization/projects/spend-limit.js:59) DELETE
//   - OpenAI admin.organization.spendAlerts.delete (resources/admin/organization/spend-alerts.js:102) DELETE
//   - OpenAI admin.organization.projects.spendAlerts.delete (resources/admin/organization/projects/spend-alerts.js:112) DELETE
//   - OpenAI admin.organization.projects.modelPermissions.delete (resources/admin/organization/projects/model-permissions.js:55) DELETE:
//     it removes a project's model restrictions, widening what it can spend on.

const ANTHROPIC_FREE_METHODS: ReadonlySet<string> = new Set([
	// GET and DELETE: the rule.
	"beta.agents.list", // resources/beta/agents/agents.js:96 GET
	"beta.agents.retrieve", // resources/beta/agents/agents.js:51 GET
	"beta.agents.versions.list", // resources/beta/agents/versions.js:23 GET
	"beta.deploymentRuns.list", // resources/beta/deployment-runs.js:42 GET
	"beta.deploymentRuns.retrieve", // resources/beta/deployment-runs.js:21 GET
	"beta.deployments.list", // resources/beta/deployments.js:99 GET
	"beta.deployments.retrieve", // resources/beta/deployments.js:56 GET
	"beta.dreams.list", // resources/beta/dreams.js:63 GET
	"beta.dreams.retrieve", // resources/beta/dreams.js:42 GET
	"beta.environments.delete", // resources/beta/environments/environments.js:115 DELETE
	"beta.environments.list", // resources/beta/environments/environments.js:93 GET
	"beta.environments.retrieve", // resources/beta/environments/environments.js:50 GET
	"beta.environments.work.list", // resources/beta/environments/work.js:84 GET
	"beta.environments.work.retrieve", // resources/beta/environments/work.js:28 GET
	"beta.environments.work.stats", // resources/beta/environments/work.js:190 GET
	"beta.files.delete", // resources/beta/files.js:44 DELETE
	"beta.files.download", // resources/beta/files.js:67 GET
	"beta.files.list", // resources/beta/files.js:23 GET
	"beta.files.retrieveMetadata", // resources/beta/files.js:90 GET
	"beta.memoryStores.delete", // resources/beta/memory-stores/memory-stores.js:112 DELETE
	"beta.memoryStores.list", // resources/beta/memory-stores/memory-stores.js:92 GET
	"beta.memoryStores.memories.delete", // resources/beta/memory-stores/memories.js:117 DELETE
	"beta.memoryStores.memories.list", // resources/beta/memory-stores/memories.js:94 GET
	"beta.memoryStores.memories.retrieve", // resources/beta/memory-stores/memories.js:46 GET
	"beta.memoryStores.memoryVersions.list", // resources/beta/memory-stores/memory-versions.js:46 GET
	"beta.memoryStores.memoryVersions.retrieve", // resources/beta/memory-stores/memory-versions.js:22 GET
	"beta.memoryStores.retrieve", // resources/beta/memory-stores/memory-stores.js:51 GET
	"beta.messages.batches.delete", // resources/beta/messages/batches.js:124 DELETE
	"beta.messages.batches.list", // resources/beta/messages/batches.js:96 GET
	"beta.messages.batches.results", // resources/beta/messages/batches.js:184 GET
	"beta.messages.batches.retrieve", // resources/beta/messages/batches.js:71 GET
	"beta.models.list", // resources/beta/models.js:47 GET
	"beta.models.retrieve", // resources/beta/models.js:23 GET
	"beta.sessions.delete", // resources/beta/sessions/sessions.js:122 DELETE
	"beta.sessions.events.list", // resources/beta/sessions/events.js:24 GET
	"beta.sessions.events.stream", // resources/beta/sessions/events.js:81 GET
	"beta.sessions.list", // resources/beta/sessions/sessions.js:100 GET
	"beta.sessions.resources.delete", // resources/beta/sessions/resources.js:94 DELETE
	"beta.sessions.resources.list", // resources/beta/sessions/resources.js:71 GET
	"beta.sessions.resources.retrieve", // resources/beta/sessions/resources.js:22 GET
	"beta.sessions.retrieve", // resources/beta/sessions/sessions.js:57 GET
	"beta.sessions.threads.events.list", // resources/beta/sessions/threads/events.js:24 GET
	"beta.sessions.threads.events.stream", // resources/beta/sessions/threads/events.js:47 GET
	"beta.sessions.threads.list", // resources/beta/sessions/threads/threads.js:52 GET
	"beta.sessions.threads.retrieve", // resources/beta/sessions/threads/threads.js:29 GET
	"beta.skills.delete", // resources/beta/skills/skills.js:87 DELETE
	"beta.skills.list", // resources/beta/skills/skills.js:68 GET
	"beta.skills.retrieve", // resources/beta/skills/skills.js:47 GET
	"beta.skills.versions.delete", // resources/beta/skills/versions.js:89 DELETE
	"beta.skills.versions.download", // resources/beta/skills/versions.js:113 GET
	"beta.skills.versions.list", // resources/beta/skills/versions.js:67 GET
	"beta.skills.versions.retrieve", // resources/beta/skills/versions.js:44 GET
	"beta.tunnels.certificates.list", // resources/beta/tunnels/certificates.js:86 GET
	"beta.tunnels.certificates.retrieve", // resources/beta/tunnels/certificates.js:57 GET
	"beta.tunnels.list", // resources/beta/tunnels/tunnels.js:85 GET
	"beta.tunnels.retrieve", // resources/beta/tunnels/tunnels.js:58 GET
	"beta.userProfiles.list", // resources/beta/user-profiles.js:84 GET
	"beta.userProfiles.retrieve", // resources/beta/user-profiles.js:41 GET
	"beta.vaults.credentials.delete", // resources/beta/vaults/credentials.js:121 DELETE
	"beta.vaults.credentials.list", // resources/beta/vaults/credentials.js:98 GET
	"beta.vaults.credentials.retrieve", // resources/beta/vaults/credentials.js:52 GET
	"beta.vaults.delete", // resources/beta/vaults/vaults.js:115 DELETE
	"beta.vaults.list", // resources/beta/vaults/vaults.js:93 GET
	"beta.vaults.retrieve", // resources/beta/vaults/vaults.js:50 GET
	"messages.batches.delete", // resources/messages/batches.js:102 DELETE
	"messages.batches.list", // resources/messages/batches.js:84 GET
	"messages.batches.results", // resources/messages/batches.js:145 GET
	"messages.batches.retrieve", // resources/messages/batches.js:66 GET
	"models.list", // resources/models.js:32 GET
	"models.retrieve", // resources/models.js:16 GET
	// POST, each free for the reason given.
	"beta.deployments.pause", // resources/beta/deployments.js:142 POST: pause: stops scheduled runs
	"beta.dreams.cancel", // resources/beta/dreams.js:104 POST: cancel: stops work
	"beta.messages.batches.cancel", // resources/beta/messages/batches.js:156 POST: cancel: stops work
	"beta.messages.countTokens", // resources/beta/messages/messages.js:108 POST: counts tokens; runs no model and is not billed
	"messages.batches.cancel", // resources/messages/batches.js:126 POST: cancel: stops work
	"messages.countTokens", // resources/messages/messages.js:111 POST: counts tokens; runs no model and is not billed
	// Local: no request.
	"beta.webhooks.unwrap", // resources/beta/webhooks.js:8 local: verifies a signature, sends nothing
]);

const OPENAI_FREE_METHODS: ReadonlySet<string> = new Set([
	// GET and DELETE: the rule.
	"admin.organization.adminAPIKeys.delete", // resources/admin/organization/admin-api-keys.js:73 DELETE
	"admin.organization.adminAPIKeys.list", // resources/admin/organization/admin-api-keys.js:55 GET
	"admin.organization.adminAPIKeys.retrieve", // resources/admin/organization/admin-api-keys.js:38 GET
	"admin.organization.auditLogs.list", // resources/admin/organization/audit-logs.js:22 GET
	"admin.organization.certificates.delete", // resources/admin/organization/certificates.js:95 DELETE
	"admin.organization.certificates.list", // resources/admin/organization/certificates.js:79 GET
	"admin.organization.certificates.retrieve", // resources/admin/organization/certificates.js:43 GET
	"admin.organization.dataRetention.retrieve", // resources/admin/organization/data-retention.js:16 GET
	"admin.organization.groups.delete", // resources/admin/organization/groups/groups.js:99 DELETE
	"admin.organization.groups.list", // resources/admin/organization/groups/groups.js:82 GET
	"admin.organization.groups.retrieve", // resources/admin/organization/groups/groups.js:47 GET
	"admin.organization.groups.roles.delete", // resources/admin/organization/groups/roles.js:75 DELETE
	"admin.organization.groups.roles.list", // resources/admin/organization/groups/roles.js:60 GET
	"admin.organization.groups.roles.retrieve", // resources/admin/organization/groups/roles.js:40 GET
	"admin.organization.groups.users.delete", // resources/admin/organization/groups/users.js:75 DELETE
	"admin.organization.groups.users.list", // resources/admin/organization/groups/users.js:60 GET
	"admin.organization.groups.users.retrieve", // resources/admin/organization/groups/users.js:40 GET
	"admin.organization.invites.delete", // resources/admin/organization/invites.js:75 DELETE
	"admin.organization.invites.list", // resources/admin/organization/invites.js:57 GET
	"admin.organization.invites.retrieve", // resources/admin/organization/invites.js:40 GET
	"admin.organization.projects.apiKeys.delete", // resources/admin/organization/projects/api-keys.js:59 DELETE
	"admin.organization.projects.apiKeys.list", // resources/admin/organization/projects/api-keys.js:41 GET
	"admin.organization.projects.apiKeys.retrieve", // resources/admin/organization/projects/api-keys.js:21 GET
	"admin.organization.projects.certificates.list", // resources/admin/organization/projects/certificates.js:22 GET
	"admin.organization.projects.dataRetention.retrieve", // resources/admin/organization/projects/data-retention.js:19 GET
	"admin.organization.projects.groups.delete", // resources/admin/organization/projects/groups/groups.js:83 DELETE
	"admin.organization.projects.groups.list", // resources/admin/organization/projects/groups/groups.js:68 GET
	"admin.organization.projects.groups.retrieve", // resources/admin/organization/projects/groups/groups.js:47 GET
	"admin.organization.projects.groups.roles.delete", // resources/admin/organization/projects/groups/roles.js:78 DELETE
	"admin.organization.projects.groups.roles.list", // resources/admin/organization/projects/groups/roles.js:62 GET
	"admin.organization.projects.groups.roles.retrieve", // resources/admin/organization/projects/groups/roles.js:41 GET
	"admin.organization.projects.hostedToolPermissions.retrieve", // resources/admin/organization/projects/hosted-tool-permissions.js:19 GET
	"admin.organization.projects.list", // resources/admin/organization/projects/projects.js:114 GET
	"admin.organization.projects.modelPermissions.retrieve", // resources/admin/organization/projects/model-permissions.js:19 GET
	"admin.organization.projects.rateLimits.listRateLimits", // resources/admin/organization/projects/rate-limits.js:22 GET
	"admin.organization.projects.retrieve", // resources/admin/organization/projects/projects.js:79 GET
	"admin.organization.projects.roles.delete", // resources/admin/organization/projects/roles.js:99 DELETE
	"admin.organization.projects.roles.list", // resources/admin/organization/projects/roles.js:80 GET
	"admin.organization.projects.roles.retrieve", // resources/admin/organization/projects/roles.js:40 GET
	"admin.organization.projects.serviceAccounts.delete", // resources/admin/organization/projects/service-accounts/service-accounts.js:102 DELETE
	"admin.organization.projects.serviceAccounts.list", // resources/admin/organization/projects/service-accounts/service-accounts.js:84 GET
	"admin.organization.projects.serviceAccounts.retrieve", // resources/admin/organization/projects/service-accounts/service-accounts.js:48 GET
	"admin.organization.projects.spendAlerts.list", // resources/admin/organization/projects/spend-alerts.js:97 GET
	"admin.organization.projects.spendAlerts.retrieve", // resources/admin/organization/projects/spend-alerts.js:48 GET
	"admin.organization.projects.spendLimit.retrieve", // resources/admin/organization/projects/spend-limit.js:19 GET
	"admin.organization.projects.users.delete", // resources/admin/organization/projects/users/users.js:106 DELETE
	"admin.organization.projects.users.list", // resources/admin/organization/projects/users/users.js:88 GET
	"admin.organization.projects.users.retrieve", // resources/admin/organization/projects/users/users.js:48 GET
	"admin.organization.projects.users.roles.delete", // resources/admin/organization/projects/users/roles.js:78 DELETE
	"admin.organization.projects.users.roles.list", // resources/admin/organization/projects/users/roles.js:62 GET
	"admin.organization.projects.users.roles.retrieve", // resources/admin/organization/projects/users/roles.js:41 GET
	"admin.organization.roles.delete", // resources/admin/organization/roles.js:88 DELETE
	"admin.organization.roles.list", // resources/admin/organization/roles.js:71 GET
	"admin.organization.roles.retrieve", // resources/admin/organization/roles.js:37 GET
	"admin.organization.spendAlerts.list", // resources/admin/organization/spend-alerts.js:88 GET
	"admin.organization.spendAlerts.retrieve", // resources/admin/organization/spend-alerts.js:44 GET
	"admin.organization.spendLimit.retrieve", // resources/admin/organization/spend-limit.js:16 GET
	"admin.organization.usage.audioSpeeches", // resources/admin/organization/usage.js:18 GET
	"admin.organization.usage.audioTranscriptions", // resources/admin/organization/usage.js:36 GET
	"admin.organization.usage.codeInterpreterSessions", // resources/admin/organization/usage.js:54 GET
	"admin.organization.usage.completions", // resources/admin/organization/usage.js:72 GET
	"admin.organization.usage.costs", // resources/admin/organization/usage.js:90 GET
	"admin.organization.usage.embeddings", // resources/admin/organization/usage.js:108 GET
	"admin.organization.usage.fileSearchCalls", // resources/admin/organization/usage.js:126 GET
	"admin.organization.usage.images", // resources/admin/organization/usage.js:144 GET
	"admin.organization.usage.moderations", // resources/admin/organization/usage.js:162 GET
	"admin.organization.usage.vectorStores", // resources/admin/organization/usage.js:180 GET
	"admin.organization.usage.webSearchCalls", // resources/admin/organization/usage.js:198 GET
	"admin.organization.users.delete", // resources/admin/organization/users/users.js:75 DELETE
	"admin.organization.users.list", // resources/admin/organization/users/users.js:58 GET
	"admin.organization.users.retrieve", // resources/admin/organization/users/users.js:25 GET
	"admin.organization.users.roles.delete", // resources/admin/organization/users/roles.js:75 DELETE
	"admin.organization.users.roles.list", // resources/admin/organization/users/roles.js:60 GET
	"admin.organization.users.roles.retrieve", // resources/admin/organization/users/roles.js:40 GET
	"batches.list", // resources/batches.js:27 GET
	"batches.retrieve", // resources/batches.js:21 GET
	"beta.assistants.delete", // resources/beta/assistants.js:69 DELETE
	"beta.assistants.list", // resources/beta/assistants.js:56 GET
	"beta.assistants.retrieve", // resources/beta/assistants.js:31 GET
	"beta.chatkit.threads.delete", // resources/beta/chatkit/threads.js:55 DELETE
	"beta.chatkit.threads.list", // resources/beta/chatkit/threads.js:37 GET
	"beta.chatkit.threads.listItems", // resources/beta/chatkit/threads.js:75 GET
	"beta.chatkit.threads.retrieve", // resources/beta/chatkit/threads.js:19 GET
	"beta.responses.delete", // resources/beta/responses/responses.js:55 DELETE
	"beta.responses.inputItems.list", // resources/beta/responses/input-items.js:23 GET
	"beta.responses.retrieve", // resources/beta/responses/responses.js:32 GET
	"beta.threads.delete", // resources/beta/threads/threads.js:68 DELETE
	"beta.threads.messages.delete", // resources/beta/threads/messages.js:73 DELETE
	"beta.threads.messages.list", // resources/beta/threads/messages.js:60 GET
	"beta.threads.messages.retrieve", // resources/beta/threads/messages.js:33 GET
	"beta.threads.retrieve", // resources/beta/threads/threads.js:43 GET
	"beta.threads.runs.list", // resources/beta/threads/runs/runs.js:68 GET
	"beta.threads.runs.poll", // resources/beta/threads/runs/runs.js:111 GET
	"beta.threads.runs.retrieve", // resources/beta/threads/runs/runs.js:41 GET
	"beta.threads.runs.steps.list", // resources/beta/threads/runs/steps.js:34 GET
	"beta.threads.runs.steps.retrieve", // resources/beta/threads/runs/steps.js:20 GET
	"chat.completions.delete", // resources/chat/completions/completions.js:96 DELETE
	"chat.completions.list", // resources/chat/completions/completions.js:79 GET
	"chat.completions.messages.list", // resources/chat/completions/messages.js:26 GET
	"chat.completions.retrieve", // resources/chat/completions/completions.js:41 GET
	"containers.delete", // resources/containers/containers.js:45 DELETE
	"containers.files.content.retrieve", // resources/containers/files/content.js:12 GET
	"containers.files.delete", // resources/containers/files/files.js:50 DELETE
	"containers.files.list", // resources/containers/files/files.js:40 GET
	"containers.files.retrieve", // resources/containers/files/files.js:30 GET
	"containers.list", // resources/containers/containers.js:35 GET
	"containers.retrieve", // resources/containers/containers.js:26 GET
	"conversations.delete", // resources/conversations/conversations.js:46 DELETE
	"conversations.items.delete", // resources/conversations/items.js:44 DELETE
	"conversations.items.list", // resources/conversations/items.js:38 GET
	"conversations.items.retrieve", // resources/conversations/items.js:27 GET
	"conversations.retrieve", // resources/conversations/conversations.js:27 GET
	"evals.delete", // resources/evals/evals.js:55 DELETE
	"evals.list", // resources/evals/evals.js:45 GET
	"evals.retrieve", // resources/evals/evals.js:33 GET
	"evals.runs.delete", // resources/evals/runs/runs.js:54 DELETE
	"evals.runs.list", // resources/evals/runs/runs.js:44 GET
	"evals.runs.outputItems.list", // resources/evals/runs/output-items.js:25 GET
	"evals.runs.outputItems.retrieve", // resources/evals/runs/output-items.js:15 GET
	"evals.runs.retrieve", // resources/evals/runs/runs.js:34 GET
	"files.content", // resources/files.js:73 GET
	"files.delete", // resources/files.js:67 DELETE
	"files.list", // resources/files.js:57 GET
	"files.retrieve", // resources/files.js:51 GET
	"files.waitForProcessing", // resources/files.js:84 GET
	"fineTuning.checkpoints.permissions.delete", // resources/fine-tuning/checkpoints/permissions.js:84 DELETE
	"fineTuning.checkpoints.permissions.list", // resources/fine-tuning/checkpoints/permissions.js:63 GET
	"fineTuning.checkpoints.permissions.retrieve", // resources/fine-tuning/checkpoints/permissions.js:40 GET
	"fineTuning.jobs.checkpoints.list", // resources/fine-tuning/jobs/checkpoints.js:25 GET
	"fineTuning.jobs.list", // resources/fine-tuning/jobs/jobs.js:68 GET
	"fineTuning.jobs.listEvents", // resources/fine-tuning/jobs/jobs.js:104 GET
	"fineTuning.jobs.retrieve", // resources/fine-tuning/jobs/jobs.js:51 GET
	"models.delete", // resources/models.js:30 DELETE
	"models.list", // resources/models.js:23 GET
	"models.retrieve", // resources/models.js:16 GET
	"responses.delete", // resources/responses/responses.js:57 DELETE
	"responses.inputItems.list", // resources/responses/input-items.js:22 GET
	"responses.retrieve", // resources/responses/responses.js:34 GET
	"skills.content.retrieve", // resources/skills/content.js:12 GET
	"skills.delete", // resources/skills/skills.js:55 DELETE
	"skills.list", // resources/skills/skills.js:45 GET
	"skills.retrieve", // resources/skills/skills.js:29 GET
	"skills.versions.content.retrieve", // resources/skills/versions/content.js:12 GET
	"skills.versions.delete", // resources/skills/versions/versions.js:46 DELETE
	"skills.versions.list", // resources/skills/versions/versions.js:36 GET
	"skills.versions.retrieve", // resources/skills/versions/versions.js:26 GET
	"vectorStores.delete", // resources/vector-stores/vector-stores.js:66 DELETE
	"vectorStores.fileBatches.listFiles", // resources/vector-stores/file-batches.js:56 GET
	"vectorStores.fileBatches.poll", // resources/vector-stores/file-batches.js:71 GET
	"vectorStores.fileBatches.retrieve", // resources/vector-stores/file-batches.js:26 GET
	"vectorStores.files.content", // resources/vector-stores/files.js:141 GET
	"vectorStores.files.delete", // resources/vector-stores/files.js:64 DELETE
	"vectorStores.files.list", // resources/vector-stores/files.js:50 GET
	"vectorStores.files.poll", // resources/vector-stores/files.js:85 GET
	"vectorStores.files.retrieve", // resources/vector-stores/files.js:27 GET
	"vectorStores.list", // resources/vector-stores/vector-stores.js:55 GET
	"vectorStores.retrieve", // resources/vector-stores/vector-stores.js:34 GET
	"videos.delete", // resources/videos.js:36 DELETE
	"videos.downloadContent", // resources/videos.js:50 GET
	"videos.getCharacter", // resources/videos.js:75 GET
	"videos.list", // resources/videos.js:26 GET
	"videos.retrieve", // resources/videos.js:20 GET
	// POST, each free for the reason given.
	"batches.cancel", // resources/batches.js:39 POST: cancel: stops work
	"beta.assistants.update", // resources/beta/assistants.js:43 POST: update; its params only reference existing vector stores, never create one
	"beta.chatkit.sessions.cancel", // resources/beta/chatkit/sessions.js:40 POST: cancel: ends a session
	"beta.responses.cancel", // resources/beta/responses/responses.js:78 POST: cancel: stops work
	"beta.threads.messages.update", // resources/beta/threads/messages.js:46 POST: metadata only
	"beta.threads.runs.cancel", // resources/beta/threads/runs/runs.js:81 POST: cancel: stops a run
	"beta.threads.update", // resources/beta/threads/threads.js:55 POST: update; its params only reference existing vector stores, never create one
	"chat.completions.update", // resources/chat/completions/completions.js:60 POST: metadata only, on a stored completion
	"conversations.create", // resources/conversations/conversations.js:21 POST: a state object; the spend lands on responses.create
	"conversations.items.create", // resources/conversations/items.js:15 POST: adds items to a state object; the spend lands on responses.create
	"conversations.update", // resources/conversations/conversations.js:36 POST: metadata only
	"evals.create", // resources/evals/evals.js:27 POST: an eval definition; running it (evals.runs.create) is refused
	"evals.runs.cancel", // resources/evals/runs/runs.js:64 POST: cancel: stops a run
	"evals.update", // resources/evals/evals.js:39 POST: metadata of an eval definition
	"fineTuning.alpha.graders.validate", // resources/fine-tuning/alpha/graders.js:51 POST: validates a grader definition; runs no grader
	"fineTuning.checkpoints.permissions.create", // resources/fine-tuning/checkpoints/permissions.js:29 POST: an access grant on a checkpoint; runs nothing
	"fineTuning.jobs.cancel", // resources/fine-tuning/jobs/jobs.js:85 POST: cancel: stops work
	"fineTuning.jobs.pause", // resources/fine-tuning/jobs/jobs.js:117 POST: pause: stops work
	"moderations.create", // resources/moderations.js:14 POST: priced "Free"
	"realtime.calls.hangup", // resources/realtime/calls.js:36 POST: ends a call
	"realtime.calls.refer", // resources/realtime/calls.js:53 POST: transfers a call away from the model
	"realtime.calls.reject", // resources/realtime/calls.js:69 POST: declines a call
	"responses.cancel", // resources/responses/responses.js:87 POST: cancel: stops work
	"uploads.cancel", // resources/uploads/uploads.js:49 POST: cancel: drops an upload
	"vectorStores.fileBatches.cancel", // resources/vector-stores/file-batches.js:38 POST: cancel: stops ingestion
	// Local: no request.
	"webhooks.unwrap", // resources/webhooks/webhooks.js:18 local: verifies a signature, sends nothing
	"webhooks.verifySignature", // resources/webhooks/webhooks.js:32 local: verifies a signature, sends nothing
]);

// @google/genai 1.52.0, by the same rule. Each entry cites the method's definition in
// `dist/node/index.mjs` (the ESM build the runtime loads), with the request it sends. Gemini and
// Vertex send the same verb unless noted. Not free, by the rule: every `*Internal` method (GET
// twins included), the private helpers that send nothing but have no caller need
// (`models.processParamsMaybeAddMcpUsage`, `batches.getGcsUri`, ...), `getNextGenClient`, and
// the four webhook configuration POSTs (`webhooks.create` / `update` / `ping` /
// `rotateSigningSecret`), which stay refused until a reason is named. `files.upload` is refused:
// it sends the file's bytes with no PII scan, whatever Google charges for storage.
const GOOGLE_FREE_METHODS: ReadonlySet<string> = new Set([
	// GET and DELETE: the rule.
	"batches.delete", // dist/node/index.mjs:5728 DELETE batches/{name} (Vertex: batchPredictionJobs/{name})
	"batches.get", // dist/node/index.mjs:5551 GET batches/{name} (Vertex: batchPredictionJobs/{name})
	"batches.list", // dist/node/index.mjs:5313 GET batches (Vertex: batchPredictionJobs)
	"caches.delete", // dist/node/index.mjs:6808 DELETE {name}
	"caches.get", // dist/node/index.mjs:6747 GET {name}
	"caches.list", // dist/node/index.mjs:6656 GET cachedContents
	"fileSearchStores.delete", // dist/node/index.mjs:17381 DELETE {name}
	"fileSearchStores.documents.delete", // dist/node/index.mjs:17133 DELETE {name}
	"fileSearchStores.documents.get", // dist/node/index.mjs:17097 GET {name}
	"fileSearchStores.documents.list", // dist/node/index.mjs:17087 GET {parent}/documents
	"fileSearchStores.downloadMedia", // dist/node/index.mjs:17270 GET .../media/...
	"fileSearchStores.get", // dist/node/index.mjs:17345 GET {name}
	"fileSearchStores.list", // dist/node/index.mjs:17216 GET fileSearchStores
	"files.delete", // dist/node/index.mjs:7788 DELETE files/{file}
	"files.download", // dist/node/index.mjs:7642 GET files/{name}:download
	"files.get", // dist/node/index.mjs:7744 GET files/{file}
	"files.list", // dist/node/index.mjs:7569 GET files
	"interactions.delete", // dist/node/index.mjs:18134 DELETE /{v}/interactions/{id}
	"interactions.get", // dist/node/index.mjs:18153 GET /{v}/interactions/{id}; with stream it resumes an existing interaction, as responses.retrieve does
	"models.delete", // dist/node/index.mjs:15787 DELETE {name}
	"models.get", // dist/node/index.mjs:15587 GET {name}
	"models.list", // dist/node/index.mjs:14763 GET {models_url}
	"tunings.get", // dist/node/index.mjs:20491 GET {name}
	"tunings.list", // dist/node/index.mjs:20479 GET tuningJobs
	"webhooks.delete", // dist/node/index.mjs:18193 DELETE /{v}/webhooks/{id}
	"webhooks.get", // dist/node/index.mjs:18200 GET /{v}/webhooks/{id}
	"webhooks.list", // dist/node/index.mjs:18186 GET /{v}/webhooks
	// POST (or PATCH), each free for the reason given.
	"batches.cancel", // dist/node/index.mjs:5614 POST batches/{name}:cancel: cancel: stops work
	"interactions.cancel", // dist/node/index.mjs:18149 POST /{v}/interactions/{id}/cancel: cancel: stops work
	"models.computeTokens", // dist/node/index.mjs:15957 POST {model}:computeTokens: tokenization; runs no generation
	"models.countTokens", // dist/node/index.mjs:15871 POST {model}:countTokens: counts tokens; runs no generation
	"models.update", // dist/node/index.mjs:15724 PATCH {model}: metadata only (displayName, description, defaultCheckpointId)
	"operations.get", // dist/node/index.mjs:16113 GET {operationName} (Vertex: POST {resourceName}:fetchPredictOperation): polls an existing operation
	"operations.getVideosOperation", // dist/node/index.mjs:16074 GET {operationName} (Vertex: POST {resourceName}:fetchPredictOperation): polls an existing operation
	"tunings.cancel", // dist/node/index.mjs:20657 POST {name}:cancel: cancel: stops work
]);

/** The free list, by provider. Exported for the test that pins its rule. */
export const FREE_METHODS: Readonly<Record<DefaultDenyProvider, ReadonlySet<string>>> = {
	anthropic: ANTHROPIC_FREE_METHODS,
	openai: OPENAI_FREE_METHODS,
	google: GOOGLE_FREE_METHODS,
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
	google: "a Google",
};

/**
 * The methods each provider's proxies govern (buildAnthropicProxy / buildOpenAIProxy in govern.ts
 * trap these names). ONE source for the refusal hint and for validateAllowUngoverned, which refuses
 * an opt-out entry that names one: the governed trap would win, so the entry could never be audited
 * as ungoverned_call.
 */
export const GOVERNED_PATHS: Readonly<Record<DefaultDenyProvider, ReadonlySet<string>>> = {
	anthropic: new Set([
		"messages.create",
		"messages.stream",
		"messages.parse",
		"beta.messages.create",
		"beta.messages.stream",
		"beta.messages.parse",
	]),
	openai: new Set(["chat.completions.create", "responses.create"]),
	google: new Set(["models.generateContent", "models.generateContentStream"]),
};

/** "a, b and c" over a provider's governed paths, for the refusal hint. */
function governedMethodsText(provider: DefaultDenyProvider): string {
	const paths = [...GOVERNED_PATHS[provider]];
	return paths.length < 2
		? paths.join("")
		: `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}

/** The refusal for an SDK method usertrust does not govern and the free list does not name. */
export function ungovernedMethodError(
	provider: DefaultDenyProvider,
	path: string,
): PolicyDeniedError {
	return new PolicyDeniedError(
		`ungoverned_method: ${path} is not governed on ${PROVIDER_NAME[provider]} client`,
		`usertrust governs ${governedMethodsText(provider)} on ${PROVIDER_NAME[provider]} client, and refuses every other SDK method that is not on its free list rather than let it run unmetered. To run this one anyway, list it in trust({ allowUngoverned: ["${path}"] }): each call is then audited as ungoverned_call, with no budget hold and no cost.`,
	);
}

/** The refusal for a call reached through a raw client: `_client`, or a client-level HTTP member. */
function rawClientError(provider: DefaultDenyProvider, path: string): PolicyDeniedError {
	return new PolicyDeniedError(
		`ungoverned_method: ${path} is not governed on ${PROVIDER_NAME[provider]} client`,
		`${path} sends requests on the SDK's raw client, which nothing governs, so every call through it is refused, and allowUngoverned cannot list it. Call the method on the governed client instead.`,
	);
}

/**
 * The `withOptions()` keys that leave the transport as it was: how long to wait, how often to
 * retry, extra headers and query, logging, and which credential or account to send. Every other
 * key can change WHERE or HOW calls are sent, so a `withOptions()` call that passes one (even as
 * `undefined`: the SDK spreads it over the inherited value) gets a client on which every call is
 * refused. An allow-list, so a key a subclass or an older SDK adds fails closed. The keys this
 * refuses on the installed SDKs (`ClientOptions` in each `client.d.ts`):
 *   - both: `baseURL`, `fetch`, `fetchOptions` (a dispatcher or agent rides here);
 *   - Anthropic: `middleware` (rewrites each request), `credentials`, `config`, `profile`
 *     (credential resolution can set the base URL: `_applyCredentialBaseURL`);
 *   - OpenAI: `provider` (a third-party API provider), `workloadIdentity` (a token exchange);
 *   - older SDKs and subclasses: `httpAgent`, Azure's `endpoint` / `deployment`, Bedrock's and
 *     Vertex's region and project, and any key not listed below.
 */
const GOVERNED_WITH_OPTIONS_KEYS: Record<DefaultDenyProvider, ReadonlySet<string>> = {
	anthropic: new Set([
		"timeout",
		"maxRetries",
		"defaultHeaders",
		"defaultQuery",
		"logLevel",
		"logger",
		"dangerouslyAllowBrowser",
		"apiKey",
		"authToken",
		"webhookKey",
	]),
	openai: new Set([
		"timeout",
		"maxRetries",
		"defaultHeaders",
		"defaultQuery",
		"logLevel",
		"logger",
		"dangerouslyAllowBrowser",
		"apiKey",
		"adminAPIKey",
		"organization",
		"project",
		"webhookSecret",
	]),
	// @google/genai has no withOptions; the entry exists so the record covers every provider.
	google: new Set(),
};

/** The `withOptions()` keys that can change where or how calls are sent, in the order given. */
export function transportOptionKeys(provider: DefaultDenyProvider, options: unknown): string[] {
	if (options == null || typeof options !== "object") return [];
	return Object.keys(options).filter((key) => !GOVERNED_WITH_OPTIONS_KEYS[provider].has(key));
}

/**
 * The per-call request options (the SECOND argument on Anthropic and OpenAI) a governed call may
 * carry: the ones measured to change neither the body nor where it is sent. Every other option is
 * refused, as default-deny refuses every method it does not govern and `withOptions()` refuses every
 * key it does not list, so an option an SDK adds later is refused until it is measured. Measured
 * through the real SDKs (each posts `{ body, ...options }` and spreads `fetchOptions` last over the
 * request): `body`, `fetchOptions` and Anthropic's `middleware` replaced the body, `path` and
 * `defaultBaseURL` moved the call, `__binaryResponse` hid the usage. `stream` is listed because the
 * SDK sets its own after the spread; `headers` and `query` change only the header and the URL's
 * query string.
 */
const GOVERNED_REQUEST_OPTIONS: ReadonlySet<string> = new Set([
	"timeout",
	"maxRetries",
	"signal",
	"headers",
	"query",
	"method",
	"idempotencyKey",
	"stream",
]);

/** Google's per-call `config.httpOptions` keys a governed call may carry (`extraBody` merges into the body, `baseUrl` moves the host). */
const GOVERNED_GOOGLE_HTTP_OPTIONS: ReadonlySet<string> = new Set([
	"apiVersion",
	"headers",
	"timeout",
	"retryOptions",
]);

/**
 * The ROOT of every client chain: a client handed to trust() inside a Proxy, or the SDK resource a
 * call runs on when it is one, is TRUSTED transport. Observability wrappers hand back the SDK
 * client inside a forwarding Proxy, and a Proxy built to show these checks one value and the SDK
 * another is deliberate bypass from the caller's own code, out of scope (LIMITATIONS §1). Its
 * traps are not run here, and nothing is read through it. Below the root every step still fails
 * closed. One switch, so tightening it is one line.
 */
const PROXY_ROOT_IS_TRUSTED = true;

/** What `readThroughChain` returns for a property it cannot read without running caller code. */
export const UNREADABLE: unique symbol = Symbol("unreadable");

/** How many objects `readThroughChain` walks before it gives up and reads the property as unreadable. */
const MAX_CHAIN_DEPTH = 64;

/**
 * Property `key` of `holder` as the SDK's own `holder[key]` finds it, read without running caller
 * code: the prototype chain is walked from `holder`, and the first object holding `key` decides.
 * Its value when that is a data property, `undefined` when no object on the chain holds it, and
 * `UNREADABLE` when it cannot be read that way: an object on the chain up to that point is a Proxy
 * (its descriptor and prototype traps are caller code), the property is an accessor, or the holder
 * itself was unreadable. An inherited property is read, not taken as absent: the SDK reads these
 * keys by plain property access, so a client built with `Object.create(client)`, or options whose
 * prototype carries the key, would otherwise send what the check never saw. Fails CLOSED: every
 * check below REFUSES what is unreadable, and never reads it as absent, so an accessor or a Proxy
 * at any step of a chain is refused. A chain longer than `MAX_CHAIN_DEPTH` objects is unreadable
 * too: no SDK object comes near it, and the walk stays bounded however the chain was built.
 */
export function readThroughChain(holder: unknown, key: string): unknown {
	if (holder === UNREADABLE) return UNREADABLE;
	if (holder == null || (typeof holder !== "object" && typeof holder !== "function")) {
		return undefined;
	}
	let o: object | null = holder;
	for (let depth = 0; o !== null; depth++) {
		if (depth >= MAX_CHAIN_DEPTH || utilTypes.isProxy(o)) return UNREADABLE;
		const d = Object.getOwnPropertyDescriptor(o, key);
		if (d !== undefined) return "value" in d ? d.value : UNREADABLE;
		o = Object.getPrototypeOf(o);
	}
	return undefined;
}

/**
 * A plain object: not a Proxy, and its prototype is null or SOME realm's `Object.prototype` (this
 * one, or a `vm` context's: `isRealmObjectPrototype`, read through descriptors, no caller code). A
 * function, an array or a class instance is not one. A forged prototype can pass that shape check.
 * Where these values are used that gains nothing: per-call options are forwarded as a copy of the
 * OWN data properties read here, and a client's `fetchOptions` is read by the SDK through an object
 * spread, which copies own properties only. A Google client's `httpOptions` is the exception: the
 * SDK reads its keys by plain property access, which finds a key on the prototype, so
 * `googleClientMoved` holds it to THIS realm's `Object.prototype` (or none) instead.
 */
function plainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || isRealmObjectPrototype(proto);
}

/**
 * A plain array: not a Proxy, its prototype is THIS realm's `Array.prototype` (exactly, not by
 * shape: the SDK spreads it, which runs the prototype's iterator, and a forged prototype would pass
 * a shape check; the SDK copies a constructor's middleware into this realm, so only an array put on
 * the raw client afterwards can be another realm's), and its own keys are only `length` and
 * indices, each held as data. So a spread of it (`[...array]`, which runs its iterator) sees exactly
 * what `length` and the indices say: an own `Symbol.iterator`, an accessor index or any other own
 * key would let the check read one array and the SDK spread another.
 */
function plainArray(value: unknown): value is unknown[] {
	// The Proxy test first: `Array.isArray` throws on a revoked Proxy, which would escape the
	// refusal before its denial is recorded.
	if (utilTypes.isProxy(value) || !Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Array.prototype) return false;
	return Reflect.ownKeys(value).every((key) => {
		if (key === "length") return true;
		if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return false;
		const d = Object.getOwnPropertyDescriptor(value, key);
		return d !== undefined && "value" in d;
	});
}

/**
 * What is wrong with request options `value` (empty: nothing). They must be absent, or a plain
 * object whose every key the governed list allows, each held as data. A key counts when it is
 * present at all, whatever its value: the SDK's spread copies an `undefined` too, so
 * `{ path: undefined }` replaces the call's path. An internal `__` key is named as such. Nothing
 * here runs caller code: names are listed, descriptors read, no accessor called.
 */
function ungovernedKeysOf(
	value: unknown,
	governed: ReadonlySet<string>,
	prefix: string,
	name: string,
): string[] {
	if (value === undefined || value === null) return [];
	if (value === UNREADABLE) return [`${name} (unreadable)`];
	if (utilTypes.isProxy(value)) return [`${name} (a Proxy)`];
	if (!plainObject(value)) return [`${name} (not a plain object)`];
	return Object.getOwnPropertyNames(value).flatMap((key) => {
		if (key.startsWith("__")) return [`${prefix}${key} (internal)`];
		if (!governed.has(key)) return [`${prefix}${key}`];
		const d = Object.getOwnPropertyDescriptor(value, key);
		return d !== undefined && !("value" in d) ? [`${prefix}${key} (an accessor)`] : [];
	});
}

/**
 * A NEW object holding only the governed keys of options `ungovernedKeysOf` passed (a plain
 * object of data properties), each read once. What is forwarded is this copy, never the caller's
 * object, so a key the caller adds, or a value it changes, after the check cannot reach the SDK.
 */
function governedCopy(
	options: Record<string, unknown>,
	governed: ReadonlySet<string>,
): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(options)) {
		if (!governed.has(key)) continue;
		const d = Object.getOwnPropertyDescriptor(options, key);
		if (d !== undefined && "value" in d) copy[key] = d.value;
	}
	return copy;
}

/**
 * A Google client's `httpOptions`, read through its `apiClient`: what would move every body. The
 * SDK reads `httpOptions.extraBody` by plain property access, so a key on the prototype counts:
 * the object must be plain with THIS realm's `Object.prototype` or none (another realm's, which can
 * be given any key, is refused), and `extraBody` is looked for along that chain. It must not carry
 * `toJSON` either: the SDK merges a call's own `httpOptions` into a `JSON.stringify` copy of the
 * client's, and a `toJSON` there could answer with an `extraBody`.
 */
function googleClientMoved(apiClient: unknown): string[] {
	const http = readThroughChain(readThroughChain(apiClient, "clientOptions"), "httpOptions");
	if (http === UNREADABLE) return ["client httpOptions (unreadable)"];
	if (http === undefined || http === null) return [];
	if (!plainObject(http)) return ["client httpOptions (not a plain object)"];
	const proto = Object.getPrototypeOf(http);
	if (proto !== null && proto !== Object.prototype) {
		return ["client httpOptions (another realm's object)"];
	}
	return ["extraBody", "toJSON"]
		.filter((key) => key in http)
		.map((key) => `client httpOptions.${key}`);
}

/**
 * What a client carries that rewrites every request after governance read it (empty: nothing).
 * Anthropic and OpenAI: their own `fetchOptions` carrying `body` or `method` (the SDKs spread a
 * client's `fetchOptions` over every request after the body; its transport keys, such as a proxy
 * `dispatcher`, stay allowed). Anthropic: a `middleware` chain given to the constructor (the SDK's
 * own `betaRefusalFallbackMiddleware` re-sends a refused call to a fallback model, after it was
 * priced). Google: `httpOptions.extraBody`, merged into every body. `client` is the SDK client;
 * anything on the way that cannot be read without running caller code is refused.
 */
export function movedClientOptions(provider: DefaultDenyProvider, client: unknown): string[] {
	if (client === UNREADABLE) return ["client (unreadable)"];
	if (utilTypes.isProxy(client)) return PROXY_ROOT_IS_TRUSTED ? [] : ["client (a Proxy)"];
	if (provider === "google")
		return googleClientMoved(readThroughChain(readThroughChain(client, "models"), "apiClient"));
	const moved: string[] = [];
	const fetchOptions = readThroughChain(client, "fetchOptions");
	if (fetchOptions === UNREADABLE) {
		moved.push("client fetchOptions (unreadable)");
	} else if (fetchOptions !== undefined && fetchOptions !== null) {
		if (!plainObject(fetchOptions)) {
			moved.push("client fetchOptions (not a plain object)");
		} else {
			for (const key of ["body", "method"]) {
				if (Object.hasOwn(fetchOptions, key)) moved.push(`client fetchOptions.${key}`);
			}
		}
	}
	if (provider === "anthropic") {
		const middleware = readThroughChain(client, "middleware");
		if (middleware === UNREADABLE) {
			moved.push("client middleware (unreadable)");
		} else if (middleware !== undefined && middleware !== null) {
			// The SDK SPREADS this array whenever any middleware applies (a signing subclass's
			// `backendMiddleware()` included), so it must be one the spread reads as its length says.
			if (!plainArray(middleware)) moved.push("client middleware (not a plain array)");
			else if (middleware.length > 0) moved.push("client middleware");
		}
	}
	return moved;
}

/**
 * What a governed call carries that is not on the governed list, or that its client rewrites
 * (empty: nothing). Anthropic and OpenAI: the per-call request options, `args[1]`, must be a plain
 * object of `GOVERNED_REQUEST_OPTIONS`. Google: the request's `config.httpOptions` must be a plain
 * object of `GOVERNED_GOOGLE_HTTP_OPTIONS`. Both: the client options `movedClientOptions` names,
 * read through `target` (the SDK resource the call runs on), so a client changed after trust() is
 * refused too, as is anything on the way that cannot be read without running caller code.
 */
export function movedRequestOptions(
	provider: DefaultDenyProvider,
	args: readonly unknown[],
	target?: unknown,
): string[] {
	if (provider !== "google") {
		return [
			...ungovernedKeysOf(args[1], GOVERNED_REQUEST_OPTIONS, "", "options"),
			...(utilTypes.isProxy(target) && PROXY_ROOT_IS_TRUSTED
				? []
				: movedClientOptions(provider, readThroughChain(target, "_client"))),
		];
	}
	const request = args[0];
	if (utilTypes.isProxy(request)) return ["request (a Proxy)"];
	const config = readThroughChain(request, "config");
	return [
		...(config === UNREADABLE ? ["config (unreadable)"] : []),
		...ungovernedKeysOf(
			readThroughChain(config, "httpOptions"),
			GOVERNED_GOOGLE_HTTP_OPTIONS,
			"config.httpOptions.",
			"config.httpOptions",
		),
		...(utilTypes.isProxy(target) && PROXY_ROOT_IS_TRUSTED
			? []
			: googleClientMoved(readThroughChain(target, "apiClient"))),
	];
}

/**
 * A Google request's `config.httpOptions` as call start pins it, for every later read of the path
 * `params.config.httpOptions`: when `readOwn` finds a plain object there (an own data property,
 * enumerable or not), a NEW object holding only its governed keys, each read once, and whether it
 * was enumerable; when there is none, absent. `undefined` (nothing pinned, the SDK reads the path
 * as it would) only when the config inherits an `httpOptions`, which is left to the SDK as before.
 * Run after `movedRequestOptions` passed the request (which refused any key off the list), so
 * nothing here runs caller code: the prototype chain is walked through descriptors, stopping at a
 * Proxy.
 */
export function pinnedGoogleHttpOptions(
	request: unknown,
): { httpOptions: Record<string, unknown> | undefined; enumerable: boolean } | undefined {
	const config = readOwn(request, "config");
	const http = readOwn(config, "httpOptions");
	if (http === undefined && inheritsKey(config, "httpOptions")) return undefined;
	if (!plainObject(http)) return { httpOptions: undefined, enumerable: false };
	const d = Object.getOwnPropertyDescriptor(config as object, "httpOptions");
	return {
		httpOptions: governedCopy(http, GOVERNED_GOOGLE_HTTP_OPTIONS),
		enumerable: d?.enumerable === true,
	};
}

/** Does `obj` (not a Proxy) hold `key` below itself, on its prototype chain? Descriptors only, stopping at a Proxy. */
function inheritsKey(obj: unknown, key: string): boolean {
	if (obj === null || typeof obj !== "object" || utilTypes.isProxy(obj)) return false;
	for (let o = Object.getPrototypeOf(obj); o !== null; o = Object.getPrototypeOf(o)) {
		if (utilTypes.isProxy(o)) return false;
		if (Object.getOwnPropertyDescriptor(o, key) !== undefined) return true;
	}
	return false;
}

/**
 * The argument list to FORWARD for a governed call `movedRequestOptions` passed: the caller's
 * request, with its request options replaced by a new object holding only the governed keys, each
 * read once (Anthropic and OpenAI: `args[1]`; Google: `config.httpOptions`, in a shallow copy of
 * the request and its config, which keeps every callable member). A later change to the caller's
 * own options cannot reach the SDK, and the copy cannot carry an unlisted key.
 */
export function detachedArgs(provider: DefaultDenyProvider, args: readonly unknown[]): unknown[] {
	if (provider !== "google") {
		const options = args[1];
		if (!plainObject(options)) return [...args];
		return [args[0], governedCopy(options, GOVERNED_REQUEST_OPTIONS), ...args.slice(2)];
	}
	const request = args[0];
	const config = readThroughChain(request, "config");
	const http = readThroughChain(config, "httpOptions");
	if (!plainObject(http)) return [...args];
	return [
		{
			...(request as Record<string, unknown>),
			config: {
				...(config as Record<string, unknown>),
				httpOptions: governedCopy(http, GOVERNED_GOOGLE_HTTP_OPTIONS),
			},
		},
		...args.slice(1),
	];
}

/** The refusal for a governed call, or a client, carrying what `movedRequestOptions` / `movedClientOptions` name. */
export function movedRequestError(
	provider: DefaultDenyProvider,
	keys: readonly string[],
): PolicyDeniedError {
	return new PolicyDeniedError(
		`request_option_refused: ${PROVIDER_NAME[provider]} call carries request options that are not on the governed list (${keys.join(", ")})`,
		"A governed call is scanned, held and priced from its request parameters, so only request options that change neither its body nor where it is sent are allowed: timeout, maxRetries, signal, headers, query, method, idempotencyKey and stream (on Google, httpOptions apiVersion, headers, timeout and retryOptions). Every other option is refused, among them body, fetchOptions, middleware, path, defaultBaseURL and every internal __ option, as is a client constructed with middleware (Anthropic) or httpOptions.extraBody (Google). Put the request in the call's parameters. See LIMITATIONS.md, section 1.",
	);
}

/** The refusal for every call through a `withOptions()` client whose transport changed. */
export function transportChangedError(
	provider: DefaultDenyProvider,
	changed: readonly string[],
): PolicyDeniedError {
	const what = changed.length > 0 ? ` (${changed.join(", ")})` : " (the endpoint)";
	return new PolicyDeniedError(
		`ungoverned_method: withOptions is not governed on ${PROVIDER_NAME[provider]} client when it changes where or how calls are sent${what}`,
		"A governed client meters every call for the endpoint and transport trust() saw when it wrapped the client, so a withOptions() client with a different baseURL, fetch, fetchOptions, middleware, provider or credential source is refused. timeout, maxRetries, defaultHeaders, defaultQuery, logging and the API key stay governed. Wrap a client built for the new transport with its own trust() call.",
	);
}

/**
 * Validate `trust({ allowUngoverned })` at creation: an array of non-empty method paths. Refused
 * here, by name, rather than silently ignored at call time:
 *   - a path through a raw client (`_client`, or a client-level HTTP member; on a Google client
 *     also `apiClient`, `_nextGenClient`, `getNextGenClient`, `_interactions`, `_webhooks` and
 *     the Live transports `auth` / `webSocketFactory`);
 *   - on a Google client, `chats.create`, `live.connect`, `live.music.connect` and
 *     `processAfcStream`, whose one call hands out or drives
 *     further billable calls (`handsOutUnauditedCalls`), and a governed method's name at any other
 *     path (`chats.modelsModule.generateContent`: `isAliasOfGovernedGoogleMethod`);
 *   - a method on the FREE list or a GOVERNED one: the free branch or the governed trap runs
 *     first, so the entry would never be audited as `ungoverned_call`, which is what listing it
 *     promises.
 * `provider` is the detected client kind; when it is undefined only the shape and `_client`
 * checks apply. Returns the set the boundary reads.
 */
export function validateAllowUngoverned(
	value: unknown,
	provider?: DefaultDenyProvider,
): ReadonlySet<string> {
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
		if (provider === "google" && reachesGoogleRawClient(segments)) {
			throw new TypeError(
				`usertrust: allowUngoverned cannot list "${entry}": it reaches the SDK's raw client, which is always refused.`,
			);
		}
		if (provider === "google" && handsOutUnauditedCalls(segments)) {
			throw new TypeError(
				`usertrust: allowUngoverned cannot list "${entry}": it hands out or drives further billable calls that its one ungoverned_call record would not cover.`,
			);
		}
		if (provider !== undefined) {
			if (FREE_METHODS[provider].has(entry)) {
				throw new TypeError(
					`usertrust: allowUngoverned cannot list "${entry}": it is free on ${PROVIDER_NAME[provider]} client and already runs without governance.`,
				);
			}
			if (GOVERNED_PATHS[provider].has(entry)) {
				throw new TypeError(
					`usertrust: allowUngoverned cannot list "${entry}": it is governed on ${PROVIDER_NAME[provider]} client.`,
				);
			}
		}
		if (provider === "google" && isAliasOfGovernedGoogleMethod(segments)) {
			throw new TypeError(
				`usertrust: allowUngoverned cannot list "${entry}": it is an alias of a governed method: call it on models.`,
			);
		}
		paths.add(entry);
	}
	return paths;
}

/**
 * The members of a Google client that hold, or hand out, a raw transport. Each is read as a
 * refusing stand-in, and a path through one cannot be listed in `allowUngoverned`:
 *   - `apiClient` (on the client and every namespace): the SDK's `ApiClient`, whose `request` /
 *     `requestStream` send any verb to any path with the client's credentials;
 *   - `_nextGenClient`: the raw next-gen client the first `getNextGenClient()` caches;
 *   - `auth` and `webSocketFactory` on `live` and `live.music` (`GOOGLE_TRANSPORT_OBJECTS`): the
 *     credential writer and the socket factory a Live session is built from, without `connect`.
 * `_interactions` / `_webhooks` (the raw next-gen resources the `interactions` / `webhooks`
 * getters cache) are guarded at their own paths, where nothing is free; only the public
 * `interactions.*` / `webhooks.*` paths can be listed. `getNextGenClient` returns the raw
 * next-gen client and is never listable.
 */
const GOOGLE_RAW_MEMBERS: ReadonlySet<string> = new Set(["apiClient", "_nextGenClient"]);
const GOOGLE_TRANSPORT_OBJECTS: ReadonlySet<string> = new Set(["auth", "webSocketFactory"]);
const GOOGLE_UNLISTABLE_SEGMENTS: ReadonlySet<string> = new Set([
	"_interactions",
	"_webhooks",
	"getNextGenClient",
]);

/** `live.auth`, `live.webSocketFactory` and the same two on `live.music` (and deeper under `live`). */
function isGoogleTransportObject(path: string, prop: string): boolean {
	return GOOGLE_TRANSPORT_OBJECTS.has(prop) && (path === "live" || path.startsWith("live."));
}

function reachesGoogleRawClient(segments: readonly string[]): boolean {
	return segments.some(
		(seg, i) =>
			GOOGLE_RAW_MEMBERS.has(seg) ||
			GOOGLE_UNLISTABLE_SEGMENTS.has(seg) ||
			(GOOGLE_TRANSPORT_OBJECTS.has(seg) && segments[0] === "live" && i > 0),
	);
}

/** The last segments of the governed Google paths: `generateContent`, `generateContentStream`. */
const GOOGLE_GOVERNED_METHOD_NAMES: ReadonlySet<string> = new Set(
	[...GOVERNED_PATHS.google].map((path) => path.slice(path.lastIndexOf(".") + 1)),
);

/**
 * A governed Google method's NAME (`generateContent`, `generateContentStream`) reached at any path
 * other than its governed `models.*` one, such as `chats.modelsModule.generateContent` (the SDK's
 * raw `Models`). Listed, it would run the SDK's own method raw: with a callable tool, its own
 * automatic-function-calling loop, up to `maximumRemoteCalls` generations on one record (the
 * stream through `processAfcStream`). The `*Internal` methods each send one request and stay
 * listable.
 */
function isAliasOfGovernedGoogleMethod(segments: readonly string[]): boolean {
	const last = segments[segments.length - 1] ?? "";
	return GOOGLE_GOVERNED_METHOD_NAMES.has(last) && !GOVERNED_PATHS.google.has(segments.join("."));
}

/**
 * Google methods whose ONE listed call would hand out, or drive, billable calls that the single
 * `ungoverned_call` record does not cover, so they cannot be listed in `allowUngoverned`:
 *   - `chats.create` (at any path ending so): it sends nothing, but the `Chat` it returns is built
 *     on the SDK's raw `Models`, so every later `sendMessage` / `sendMessageStream` is an
 *     unaudited generation;
 *   - `live.connect` and `live.music.connect` (at any path ending so): the `Session` /
 *     `LiveMusicSession` they return sends billable frames over the open socket
 *     (`sendClientContent`, `sendRealtimeInput`, `sendToolResponse`; `setWeightedPrompts`, `play`
 *     and the other music controls);
 *   - `processAfcStream` (on any namespace, `chats.modelsModule` included): one call drives a
 *     repeated `streamGenerateContent` loop.
 * `authTokens.create` stays listable: a minted key used outside governance is out of scope, as
 * reading `apiKey` is.
 */
function handsOutUnauditedCalls(segments: readonly string[]): boolean {
	const last = segments[segments.length - 1];
	const parent = segments[segments.length - 2];
	return (
		last === "processAfcStream" ||
		(last === "create" && parent === "chats") ||
		(last === "connect" && (parent === "live" || parent === "music"))
	);
}

/**
 * Whether a non-array object has a function member: an own property, or one inherited from a
 * prototype below `Object.prototype` (a class's methods, its `constructor` included), that holds a
 * function or is an accessor (a getter may return one). Read through property descriptors, so no
 * getter runs.
 */
function hasFunctionMember(value: object): boolean {
	for (
		let o: object | null = value;
		o !== null && o !== Object.prototype;
		o = Object.getPrototypeOf(o) as object | null
	) {
		for (const name of Object.getOwnPropertyNames(o)) {
			const d = Object.getOwnPropertyDescriptor(o, name);
			if (d === undefined) continue;
			if (!("value" in d) || typeof d.value === "function") return true;
		}
	}
	return false;
}

/** Names that pass whatever they hold: Object.prototype's members, and JSON's `toJSON` hook. */
function isInertName(prop: string): boolean {
	return prop in Object.prototype || prop === "toJSON";
}

/**
 * The client's own OBJECTS that steer where or how calls are sent: Anthropic's `middleware` array
 * (each entry rewrites a request) and `_authState` (holds the resolved base URL), and on both SDKs
 * `_options` (the constructor options, `fetch` and `baseURL` among them) and `fetchOptions`. They
 * are read through a read-only view, so `client.middleware.push(fn)` cannot reach the raw client.
 * The SDK's own code reads them off the raw client and is unaffected.
 */
const TRANSPORT_OBJECTS: ReadonlySet<string> = new Set([
	"middleware",
	"_authState",
	"_options",
	"fetchOptions",
]);

function writeRefusal(path: string, prop: string | symbol): TypeError {
	const name = typeof prop === "symbol" ? prop.toString() : prop;
	const where = path === "" ? "the governed client" : `${path} on the governed client`;
	return new TypeError(
		`usertrust: cannot change "${name}" on ${where}: the write would reach the SDK's raw client, outside governance. Configure the client before trust() wraps it.`,
	);
}

/**
 * Proxy traps that refuse every write: assignment, `Object.defineProperty` and `delete`. Every
 * object the governed client hands out (the client, its resources, `_client` stand-ins, transport
 * objects) carries them, because the proxy's target IS the raw SDK object: a write the proxy does
 * not trap lands on it. A sync TypeError, since a write is not a call.
 */
export function refuseWrites<T extends object>(
	path: string,
): Pick<ProxyHandler<T>, "set" | "defineProperty" | "deleteProperty"> {
	return {
		set(_target, prop) {
			throw writeRefusal(path, prop);
		},
		defineProperty(_target, prop) {
			throw writeRefusal(path, prop);
		},
		deleteProperty(_target, prop) {
			throw writeRefusal(path, prop);
		},
	};
}

/**
 * A read-only view of a transport object: reads pass (nested objects as further views), writes
 * throw. A property the raw object pins (non-configurable and non-writable) is returned as it is,
 * as the Proxy invariants require; a pinned property cannot be written anyway.
 */
function readOnlyView(raw: object, path: string, boundary: MethodBoundary): object {
	const cached = boundary.readOnly.get(raw);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(raw, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			const own = Reflect.getOwnPropertyDescriptor(target, prop);
			const pinned = own !== undefined && own.configurable === false && own.writable === false;
			if (pinned || value === null || typeof value !== "object") return value;
			return readOnlyView(value, `${path}.${String(prop)}`, boundary);
		},
		...refuseWrites(path),
	});
	boundary.readOnly.set(raw, proxy);
	return proxy;
}

/**
 * An SDK resource. Anthropic and OpenAI: an object carrying `_client` (every APIResource stores
 * the client it was built from there). Google, by SHAPE: an object carrying `apiClient` (every
 * `BaseModule` namespace) or `_client` (the next-gen `interactions` / `webhooks`), or any other
 * non-array object with a function member, so a namespace of a duck-typed client, or an object
 * the classification never saw, is guarded too: each of its functions is free, listed or refused
 * by its path. Plain data (`httpOptions`) has no function member and is returned as it is.
 */
function isResource(value: unknown, provider: DefaultDenyProvider): value is object {
	if (value === null || typeof value !== "object") return false;
	if ("_client" in value) return true;
	if (provider !== "google") return false;
	return "apiClient" in value || (!Array.isArray(value) && hasFunctionMember(value));
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
	const google = boundary.provider === "google";
	// On Google the getters run on the RAW target: `interactions` / `webhooks` call
	// `this.getNextGenClient()` and cache on `this`, which through the proxy would be refused.
	const value: unknown = Reflect.get(target, prop, google ? target : receiver);
	if (typeof prop === "symbol" || isInertName(prop)) return value;
	const at = path === "" ? prop : `${path}.${prop}`;
	// The raw transports, by name, before the shape test: they have function members too.
	if (
		(prop === "_client" ||
			(google && (GOOGLE_RAW_MEMBERS.has(prop) || isGoogleTransportObject(path, prop)))) &&
		value !== null &&
		typeof value === "object"
	) {
		return rawClientStandIn(value, at, boundary, () => rawClientError(boundary.provider, at));
	}
	if (typeof value === "function") {
		return methodWrapper(target, prop, value as (...args: unknown[]) => unknown, path, boundary);
	}
	if (isResource(value, boundary.provider)) return guardResource(value, at, boundary);
	if (path === "" && TRANSPORT_OBJECTS.has(prop) && value !== null && typeof value === "object") {
		return readOnlyView(value, at, boundary);
	}
	return value;
}

/**
 * The function a governed read of method `prop` on `target` (reached at `path`) returns: free and
 * listed methods run on the RAW resource (see the module comment), everything else is refused.
 * Cached per (path, raw target, name), so a method keeps its identity across reads; the decision
 * is fixed per path, and a refused wrapper builds a fresh error per call.
 */
function methodWrapper(
	target: object,
	prop: string,
	fn: (...args: unknown[]) => unknown,
	path: string,
	boundary: MethodBoundary,
): (...args: unknown[]) => unknown {
	let byTarget = boundary.methods.get(path);
	if (byTarget === undefined) {
		byTarget = new WeakMap();
		boundary.methods.set(path, byTarget);
	}
	let byName = byTarget.get(target);
	if (byName === undefined) {
		byName = new Map();
		byTarget.set(target, byName);
	}
	const cached = byName.get(prop);
	if (cached !== undefined && cached.fn === fn) return cached.wrapper;
	const at = path === "" ? prop : `${path}.${prop}`;
	let wrapper: (...args: unknown[]) => unknown;
	if (path === "" && RAW_TRANSPORT_METHODS.has(prop)) {
		wrapper = (...args) => boundary.refuse(at, args, rawClientError(boundary.provider, at));
	} else if (FREE_METHODS[boundary.provider].has(at)) {
		wrapper = (...args) => fn.apply(target, args);
	} else if (boundary.allowUngoverned.has(at)) {
		wrapper = (...args) => boundary.callUngoverned(at, fn, target, args);
	} else {
		wrapper = (...args) => boundary.refuse(at, args);
	}
	byName.set(prop, { fn, wrapper });
	return wrapper;
}

/**
 * A nested SDK resource behind the boundary. One proxy per (path, raw resource): the proxy's
 * free-list and `allowUngoverned` decisions depend on its path, so a raw resource reachable at
 * two paths must not answer at the second with the first path's proxy.
 */
function guardResource(resource: object, path: string, boundary: MethodBoundary): object {
	let byRaw = boundary.resources.get(path);
	if (byRaw === undefined) {
		byRaw = new WeakMap();
		boundary.resources.set(path, byRaw);
	}
	const cached = byRaw.get(resource);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(resource, {
		get(target, prop, receiver) {
			return guardedGet(target, prop, receiver, path, boundary);
		},
		...refuseWrites(path),
	});
	byRaw.set(resource, proxy);
	return proxy;
}

/**
 * A stand-in for a raw client (or anything reached from one): every function reached through it,
 * at any depth, is refused under the one `path` the raw client was reached at, with a FRESH error
 * from `makeError` per call. Stand-ins are cached, and the denial boundary writes the event's hash
 * onto the error it is given: one shared instance would re-label every error a caller already
 * holds. `cacheKey` (default: the path) separates stand-ins whose errors differ at one path.
 * Values that are not functions read through unchanged, objects as further stand-ins. Getters run
 * on the raw object, so a getter that reads a `#private` field does not throw on the stand-in.
 * `own` names members the TOP level answers with as given: a `withOptions()` stand-in is a
 * `TrustedClient`, so it carries its governor's `destroy` and `governAction` (nested objects do not).
 */
export function rawClientStandIn(
	raw: object,
	path: string,
	boundary: MethodBoundary,
	makeError: () => PolicyDeniedError,
	cacheKey: string = path,
	own: Readonly<Record<string, unknown>> = {},
): object {
	let byRaw = boundary.standIns.get(cacheKey);
	if (byRaw === undefined) {
		byRaw = new WeakMap();
		boundary.standIns.set(cacheKey, byRaw);
	}
	const cached = byRaw.get(raw);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(raw, {
		get(target, prop) {
			if (typeof prop === "string" && Object.hasOwn(own, prop)) return own[prop];
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof prop === "symbol" || isInertName(prop)) return value;
			if (typeof value === "function") {
				return (...args: unknown[]) => boundary.refuse(path, args, makeError());
			}
			if (value !== null && typeof value === "object") {
				return rawClientStandIn(value, path, boundary, makeError, cacheKey);
			}
			return value;
		},
		...refuseWrites(path),
	});
	byRaw.set(raw, proxy);
	return proxy;
}
