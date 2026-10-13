// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Governed automatic function calling for the Google SDK.
 *
 * With a callable tool in `config.tools`, `@google/genai`'s `generateContent` runs a LOOP: it calls the model, executes the
 * tool for the function calls it returned, and calls the model again, up to `maximumRemoteCalls` (default 10) times, and
 * returns ONLY the last response. Its rounds go through the SDK's own instance method, not the public one the governor
 * traps, and the SDK exposes no per-round hook, so a governed `generateContent` saw only the last round's `usageMetadata`
 * and every earlier round was never held, metered or audited: real model spend with no ledger entry.
 *
 * DECISION: governance runs the loop itself and makes each round its own governed call. The SDK's own loop is switched off
 * for the call (`automaticFunctionCalling.disable`), the callable tools still run automatically, and the response still
 * carries `automaticFunctionCallingHistory`, so the caller sees the same result; what changes is that every round is
 * held, metered and audited. Alternatives rejected: disabling AFC outright would stop callable tools from running at all
 * (a silent behaviour change for every user), and metering through the SDK's private `generateContentInternal` would
 * depend on an unexported method that the type declarations mark `private`.
 *
 * Duck-typed: nothing here imports the SDK. The semantics mirror the SDK's loop (see `generateContent` in its source):
 * `maximumRemoteCalls` rounds of tool execution at most, then the last model response is returned as it is.
 */

import { types as utilTypes } from "node:util";
import { redactPII } from "./policy/pii.js";

type Loose = Record<string, unknown>;

const DEFAULT_MAX_REMOTE_CALLS = 10;

function isObject(v: unknown): v is Loose {
	return v !== null && typeof v === "object";
}

type CallableTool = {
	tool: () => Promise<unknown>;
	callTool: (calls: unknown[]) => Promise<unknown[]>;
};

/**
 * The SDK's own test: `'callTool' in tool && typeof tool.callTool === 'function'`. A function object (a callable tool
 * implemented as a function carrying `tool` and `callTool` properties) passes it, so it must pass here: rejecting it would
 * hand the call to the SDK's internal loop under ONE hold, which is an undercharge.
 */
function isCallableTool(tool: unknown): tool is CallableTool {
	return (
		(typeof tool === "function" || isObject(tool)) &&
		"callTool" in tool &&
		typeof (tool as Loose)["callTool"] === "function"
	);
}

/** A deep copy of a declaration (plain data); one that cannot be copied is used as it is rather than failing the call. */
function detach(value: unknown): unknown {
	try {
		return structuredClone(value);
	} catch {
		try {
			return JSON.parse(JSON.stringify(value)) as unknown;
		} catch {
			return value;
		}
	}
}

/**
 * A callable tool whose `tool()` is asked ONCE per call, LAZILY, and answers every later round from that one answer.
 *
 * The SDK's native loop awaits every `tool.tool()` once, before its first model call, and all of them start together
 * (`Promise.all` over the tools). Each governed round re-enters the public `generateContent`, which would await them again,
 * so a one-shot or stateful callable could fail on round two and a dynamic one could show different declarations between
 * rounds. The answer is taken lazily, by the FIRST round's own `generateContent` (inside the governed call, after the round
 * was authorized and a hold was placed): a denied call (policy, PII, budget) never runs user-supplied declaration code, a
 * `tool()` that throws goes through the governed lifecycle (hold voided, failure audited), and the SDK itself starts all the
 * tools' `tool()` calls together, as it does natively.
 *
 * REDACTION. In `pii: "redact"` mode the governed call forwards a deep CLONE of the request, and the SDK asks the tool on that
 * clone. `tool()` always runs on the REAL tool, so the state it sets up (a ready flag, a dispatch table, an MCP session)
 * lives where `callTool` finds it; when the SDK asked through the clone, the ANSWER is redacted, so the declaration the model
 * sees has passed the same redaction as the rest of the request, whether the tool held it as state or in a closure. When it
 * asked through the wrapper itself (nothing was cloned) the answer is given as it is, as natively. The memo lives in the
 * closure, so every later round reuses that one answer.
 *
 * The wrapper is a fresh object, never a Proxy: a frozen tool (`Object.freeze({ tool, callTool })`) cannot be proxied with
 * replacement functions without breaking the Proxy invariant. It keeps the tool's prototype, so `instanceof` checks such as
 * the SDK's MCP-usage header still hold, copies its own properties (a clone of the wrapper carries the same state), and
 * delegates `callTool` to the real tool.
 */
function snapshotTool(tool: CallableTool): CallableTool {
	let memo: Promise<unknown> | undefined;
	const wrapper = Object.create(Object.getPrototypeOf(tool)) as CallableTool;
	for (const key of Reflect.ownKeys(tool)) {
		const desc = Object.getOwnPropertyDescriptor(tool, key);
		if (desc === undefined) continue;
		const enumerable = desc.enumerable === true;
		const copy: PropertyDescriptor =
			"value" in desc
				? { value: desc.value, writable: true, enumerable, configurable: true }
				: {
						...(desc.get ? { get: desc.get } : {}),
						...(desc.set ? { set: desc.set } : {}),
						enumerable,
						configurable: true,
					};
		Object.defineProperty(wrapper, key, copy);
	}
	Object.defineProperty(wrapper, "tool", {
		value: function (this: unknown): Promise<unknown> {
			// Called synchronously on first use, like the SDK's own `await callableTool.tool()` inside its map.
			memo ??= (async () => {
				// ALWAYS on the real tool: the state `tool()` sets up (a ready flag, a dispatch table, a session) must live
				// where `callTool` finds it, which is also the real tool. The accessor is read here, at use, never at wrap time.
				const declaration = await (Reflect.get(tool, "tool") as () => Promise<unknown>).call(tool);
				// Asked through the redacted request CLONE (pii "redact" with PII in the prompt): redact the answer itself, so
				// the declaration the model sees has passed the same redaction as the rest of the request, whether it was held
				// as state or in a closure. Asked through the wrapper (nothing was cloned): the answer as it is, as natively.
				// redactPII hands its input back UNCHANGED when it detects nothing, so redact a DETACHED copy: the memo must never
				// alias the real tool's live object, or a later callTool() that writes PII into it would leak in later rounds.
				return this === wrapper ? declaration : redactPII(detach(declaration)).data;
			})();
			return memo;
		},
		writable: true,
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(wrapper, "callTool", {
		value: (calls: unknown[]): Promise<unknown[]> => tool.callTool(calls),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return wrapper;
}

// ── The ONE AFC decision, and the snapshot it is made on ──
// `sdkRunsAfc` (the SDK would run its own loop) and `afcRequested` (governance should run
// the loop itself: `sdkRunsAfc` and no plain declaration beside a callable tool, which the
// SDK rejects) are two views of ONE reading, `readAfc`. The governor uses their VERDICT
// forms, which add a third answer, "indeterminate": a Proxy, a hole, a primitive tool, a
// non-array `tools`, a non-object `config`, a getter that throws. `generateContent` runs
// `runGovernedAfc` on "afc"; `generateContentStream` with AFC is refused (a streamed loop
// is not metered round by round yet); "indeterminate" is refused on both. The verdict runs
// on `snapshotGoogleAfcParams`'s snapshot (accessors read ONCE, their values captured),
// and the snapshot is what is forwarded: to `runGovernedAfc`, to the single governed call,
// or to the governed stream.

/**
 * The SDK would run its AFC loop, or not; or it cannot be told without running caller
 * code. `proxyAt` names the first AFC-relevant object found to be a Proxy.
 */
export type GoogleAfcVerdict =
	| { kind: "afc" }
	| { kind: "no_afc" }
	| { kind: "indeterminate"; proxyAt?: string; uncloneableAt?: string };

/** A value property access would yield, found WITHOUT running a getter. */
type DataRead = { value: unknown } | undefined;

/**
 * Resolve `obj[key]` the way property access does (own, then up the prototype chain),
 * but return `undefined` (indeterminate) instead of invoking an accessor. Nullish `obj`
 * reads as `undefined`, which is what the SDK's optional chaining yields.
 */
function readDataProperty(obj: unknown, key: string, at: string): DataRead {
	if (obj == null) return { value: undefined };
	for (let o: object | null = Object(obj); o !== null; o = Object.getPrototypeOf(o)) {
		// Checked BEFORE the descriptor read and before the next getPrototypeOf, both of
		// which would run a Proxy's traps.
		rejectProxy(o, o === obj ? at : `${at} (its prototype chain)`);
		const d = Object.getOwnPropertyDescriptor(o, key);
		if (d !== undefined) return "value" in d ? { value: d.value } : undefined;
	}
	return { value: undefined };
}

/** Thrown inside the predicate when a read cannot be made without running caller code. */
const INDETERMINATE = Symbol("indeterminate");

/** Thrown inside the predicate when an AFC-relevant object is a Proxy; carries where. */
export class ProxyInAfcInput {
	constructor(readonly at: string) {}
}

/**
 * A NARROW fail-closed. A Proxy's `getOwnPropertyDescriptor` / `getPrototypeOf` traps can
 * show this check a config with no callable tool while its `get` trap hands the SDK one
 * that has one (the SDK reads with plain property access), so a Proxy anywhere the
 * check reads is refused rather than believed. `util.types.isProxy` runs no trap. The
 * planned replacement is a structural snapshot of exactly what was checked, forwarded so
 * the SDK receives what was checked; until then, a caller that MUTATES plain params
 * between the call and the SDK's read is still outside this check.
 */
function rejectProxy(value: unknown, at: string): void {
	if (utilTypes.isProxy(value)) throw new ProxyInAfcInput(at);
}

function dataValue(obj: unknown, key: string, at: string): unknown {
	const read = readDataProperty(obj, key, at);
	if (read === undefined) throw INDETERMINATE;
	return read.value;
}

/**
 * The SDK's `isCallableTool`: `'callTool' in tool && typeof tool.callTool === 'function'`.
 * `in` accepts any object, function objects included; on a primitive or `null` the SDK's
 * `in` throws a TypeError, which here is indeterminate.
 */
function isCallableToolLike(tool: unknown, at: string): boolean {
	if (tool === null || (typeof tool !== "object" && typeof tool !== "function")) {
		throw INDETERMINATE;
	}
	return typeof dataValue(tool, "callTool", at) === "function";
}

/**
 * The SDK's invalid-`maximumRemoteCalls` rule, which DISABLES AFC:
 * `(n && (n < 0 || !Number.isInteger(n))) || n == 0`. A value whose comparison would run
 * caller code (`valueOf` on an object or function) or throw (a symbol) is indeterminate.
 */
function sdkDisablesForMaxCalls(maxCalls: unknown): boolean {
	if (maxCalls !== null && (typeof maxCalls === "object" || typeof maxCalls === "function")) {
		throw INDETERMINATE;
	}
	if (typeof maxCalls === "symbol") throw INDETERMINATE;
	// Documented DIVERGENCE: NaN passes the SDK's rule (it is falsy and not `== 0`), and the
	// SDK then makes no model call at all (`remoteCalls < NaN` is false). It is counted
	// invalid here, so such a call is one ordinary governed call.
	if (typeof maxCalls === "number" && Number.isNaN(maxCalls)) return true;
	// biome-ignore lint/suspicious/noExplicitAny: the SDK's own loose comparison, mirrored verbatim
	const n = maxCalls as any;
	// biome-ignore lint/suspicious/noDoubleEquals: `== 0` is the SDK's test (it also matches "0" and false)
	return Boolean((n && (n < 0 || !Number.isInteger(n))) || n == 0);
}

/** The tools list as the SDK iterates it (`config?.tools ?? []`); only a plain array is read. */
function toolsList(config: unknown): unknown[] {
	const tools = dataValue(config, "tools", "params.config") ?? [];
	// Before Array.isArray (which sees through a Proxy) and before any element read.
	rejectProxy(tools, "params.config.tools");
	if (!Array.isArray(tools)) throw INDETERMINATE;
	return tools;
}

/** What the SDK's own reading of `params` decides, read by the rules above. */
interface AfcReading {
	/** `shouldDisableAfc(config)` is false: the SDK would run its loop. */
	sdkRuns: boolean;
	/** A non-callable tool carries `functionDeclarations` beside a callable one: the SDK throws. */
	incompatible: boolean;
}

/**
 * The SDK's AFC decision for `params`, a line-for-line mirror of @google/genai 1.52.0
 * (`shouldDisableAfc`, `isCallableTool`, `hasCallableTools`,
 * `findAfcIncompatibleToolIndexes`), reading only DATA properties:
 *
 *   - `sdkRuns` is false when `automaticFunctionCalling.disable` is truthy (the SDK's own
 *     truthiness test); when there is no callable tool (`'callTool' in tool && typeof
 *     tool.callTool === 'function'`, so a function object carrying `callTool` counts;
 *     the scan stops at the first; `generateContent`'s extra `hasCallableTools` test is
 *     then the same answer); or when `maximumRemoteCalls` is invalid,
 *     `(n && (n < 0 || !Number.isInteger(n))) || n == 0` (and NaN, see
 *     sdkDisablesForMaxCalls).
 *   - `incompatible` is the SDK's pre-request throw: a non-callable tool whose
 *     `functionDeclarations` is truthy with a length above 0.
 *
 * MCP needs no case of its own: `mcpToTool(...)` returns a CallableTool, and a raw MCP
 * client in `config.tools` also has `callTool`, so the SDK treats both as callable.
 *
 * Throws INDETERMINATE (or ProxyInAfcInput) for anything that cannot be read without
 * running caller code: an accessor, a Proxy, a non-array `tools`, a hole or a primitive
 * where the SDK's `in` would throw, a non-primitive `maximumRemoteCalls`. The governor
 * runs it on the SNAPSHOT, whose AFC fields are captured data, so an accessor can only
 * remain on a callable tool kept by reference (its `callTool`), which the snapshot
 * already refuses.
 */
function readAfc(params: unknown): AfcReading {
	const NONE: AfcReading = { sdkRuns: false, incompatible: false };
	// Every object is checked for a Proxy before anything is read from it: `dataValue`
	// does it for the object it reads, and `toolsList` for the array.
	const config = dataValue(params, "config", "params");
	const afcConfig = dataValue(config, "automaticFunctionCalling", "params.config");
	const afcAt = "params.config.automaticFunctionCalling";
	if (dataValue(afcConfig, "disable", afcAt)) return NONE;
	const tools = toolsList(config);
	let callablePresent = false;
	// By index, not `for...of`: an element getter must not run (a hole reads as
	// `undefined`, on which the SDK's `in` throws, so it is indeterminate).
	for (let i = 0; i < tools.length; i++) {
		const tool = dataValue(tools, String(i), "params.config.tools");
		if (isCallableToolLike(tool, `params.config.tools[${i}]`)) {
			callablePresent = true;
			break;
		}
	}
	if (!callablePresent) return NONE;
	if (sdkDisablesForMaxCalls(dataValue(afcConfig, "maximumRemoteCalls", afcAt))) return NONE;
	// The SDK's pre-request throw. Its inputs are Proxy-checked too: a lying `length`
	// would turn "the SDK throws" into a call that runs the AFC loop.
	for (let i = 0; i < tools.length; i++) {
		if (!(i in tools)) continue; // forEach skips holes
		const toolAt = `params.config.tools[${i}]`;
		const tool = dataValue(tools, String(i), "params.config.tools");
		if (isCallableToolLike(tool, toolAt)) continue;
		const declarations = dataValue(tool, "functionDeclarations", toolAt);
		if (declarations) {
			const length = dataValue(declarations, "length", `${toolAt}.functionDeclarations`);
			if (length !== undefined && typeof length !== "number") throw INDETERMINATE;
			if ((length as number) > 0) return { sdkRuns: true, incompatible: true };
		}
	}
	return { sdkRuns: true, incompatible: false };
}

function verdictOf(params: unknown, decide: (r: AfcReading) => boolean): GoogleAfcVerdict {
	try {
		return { kind: decide(readAfc(params)) ? "afc" : "no_afc" };
	} catch (err) {
		// A Proxy (named), INDETERMINATE, or a trap that threw: fail closed.
		return err instanceof ProxyInAfcInput
			? { kind: "indeterminate", proxyAt: err.at }
			: { kind: "indeterminate" };
	}
}

/** "afc" when the SDK would run its own loop (the STREAM refusal uses this). */
export function sdkRunsAfcVerdict(params: unknown): GoogleAfcVerdict {
	return verdictOf(params, (r) => r.sdkRuns);
}

/**
 * "afc" when governance should run the loop itself: the SDK would run it, and no plain
 * function declaration sits beside a callable tool (that makes the SDK throw a clear
 * error before any call, which is left to the SDK). `generateContent` uses this.
 */
export function afcRequestedVerdict(params: unknown): GoogleAfcVerdict {
	return verdictOf(params, (r) => r.sdkRuns && !r.incompatible);
}

/**
 * Would the SDK run its automatic-function-calling loop for these params? Boolean view of
 * `sdkRunsAfcVerdict`, for plain data. Params it cannot read safely answer `false`: the
 * governor never uses this view, it uses the verdict, which REFUSES them.
 */
export function sdkRunsAfc(params: unknown): boolean {
	return sdkRunsAfcVerdict(params).kind === "afc";
}

/** Should governance run the loop itself? Boolean view of `afcRequestedVerdict` (see `sdkRunsAfc`). */
export function afcRequested(params: unknown): boolean {
	return afcRequestedVerdict(params).kind === "afc";
}

/** Thrown while snapshotting when a tool cannot be copied as data; carries where. */
class UncloneableAfcInput {
	constructor(readonly at: string) {}
}

/**
 * `obj[key]` the way plain property access resolves it (own, then up the prototype
 * chain), reading an ACCESSOR exactly ONCE (its getter runs with `obj` as receiver) and
 * returning the value it gave, which the snapshot then CAPTURES as data: the check and
 * the SDK both see that one value, never a second read. Every object on the chain is
 * Proxy-checked BEFORE it is touched (a Proxy is refused, not read). A getter that throws
 * propagates, and the snapshot turns it into "indeterminate" (an audited refusal).
 */
function captureOnce(obj: unknown, key: string, at: string): unknown {
	if (obj == null) return undefined;
	for (let o: object | null = Object(obj); o !== null; o = Object.getPrototypeOf(o)) {
		rejectProxy(o, o === obj ? at : `${at} (its prototype chain)`);
		const d = Object.getOwnPropertyDescriptor(o, key);
		if (d === undefined) continue;
		if ("value" in d) return d.value;
		return d.get === undefined ? undefined : d.get.call(obj);
	}
	return undefined;
}

/**
 * `key in obj`, answered WITHOUT running caller code: own, then up the prototype chain,
 * descriptors only (no getter runs), each object Proxy-checked before it is touched (a
 * Proxy's `has` trap is caller code, so it is refused, not asked).
 */
function presentOnChain(obj: object, key: string, at: string): boolean {
	for (let o: object | null = obj; o !== null; o = Object.getPrototypeOf(o)) {
		rejectProxy(o, o === obj ? at : `${at} (its prototype chain)`);
		if (Object.getOwnPropertyDescriptor(o, key) !== undefined) return true;
	}
	return false;
}

/**
 * Write `key` on `obj` as an own data property. ALWAYS through `defineProperty`, never
 * `obj[key] = …`: for a caller-controlled key that is `"__proto__"` (an own property, as
 * `JSON.parse` makes one), plain assignment runs the prototype SETTER and the copy would
 * INHERIT the caller's object live. `defineProperty` makes it plain data.
 */
function setData(
	obj: Record<string | symbol, unknown>,
	key: string | symbol,
	value: unknown,
	enumerable = true,
): void {
	Object.defineProperty(obj, key, { value, writable: true, enumerable, configurable: true });
}

// ── What the SDK reads, field by field (@google/genai 1.52.0) ──
// The SDK reads these objects with plain property access, so a field they INHERIT (a class
// getter, prototype data) or hold as a NON-ENUMERABLE own property reaches the request. A
// copy that kept only own enumerable properties would drop it, and the request forwarded
// would no longer be the caller's.

/** `config.automaticFunctionCalling`: `shouldDisableAfc`, `shouldAppendAfcHistory`, and `generateContent`'s loop bound. */
const SDK_AFC_CONFIG_FIELDS = ["disable", "maximumRemoteCalls", "ignoreCallHistory"] as const;

/** `config.toolConfig`: `toolConfigToMldev` / `toolConfigToVertex`. */
const SDK_TOOL_CONFIG_FIELDS = [
	"functionCallingConfig",
	"retrievalConfig",
	"includeServerSideToolInvocations",
] as const;

/**
 * `config.toolConfig.functionCallingConfig`: `functionCallingConfigToMldev` (the Gemini API)
 * reads these by name, and `generateContentStream`'s AFC check reads
 * `streamFunctionCallArguments`. Vertex AI reads NONE of them: `toolConfigToVertex`
 * (`dist/node/index.mjs` 12188) passes the object through as it is (12200), so the request
 * carries whatever `JSON.stringify` makes of it (see `vertexWireForm`).
 */
const SDK_FUNCTION_CALLING_FIELDS = [
	"mode",
	"allowedFunctionNames",
	"streamFunctionCallArguments",
] as const;

/**
 * A non-callable tool's VALUE fields, in the order the converters read them: `toolToMldev` /
 * `toolToVertex` build the wire tool from exactly these (each tested with `!= null` or `!==
 * undefined`), both in this order; `tTool` and `findAfcIncompatibleToolIndexes` read
 * `functionDeclarations` before them (the read order is set out below).
 */
const SDK_TOOL_FIELDS = [
	"retrieval",
	"computerUse",
	"fileSearch",
	"googleSearch",
	"googleMaps",
	"codeExecution",
	"enterpriseWebSearch",
	"functionDeclarations",
	"googleSearchRetrieval",
	"parallelAiSearch",
	"urlContext",
	"mcpServers",
] as const;

/**
 * A non-callable tool's one PRESENCE-only field: `hasMcpToolUsage` tests `'inputSchema' in
 * tool` (the MCP usage header) and never reads the value, and no converter sends it. So the
 * snapshot carries its presence WITHOUT evaluating it: whatever its descriptor (a getter, which
 * the SDK never runs, or data of any kind), its value is never read, checked or cloned, and
 * the copy holds `undefined` there.
 */
const SDK_TOOL_PRESENCE_FIELD = "inputSchema";

// ── The order the SDK reads a non-callable tool in (@google/genai 1.52.0, dist/node/index.mjs) ──
// The snapshot reads in the same order, so a getter on one field runs only after every field the
// SDK read before it has been captured, as natively:
//
//   1. `generateContent` first awaits `processParamsMaybeAddMcpUsage` (call at 14592, defined at
//      14927), which iterates every tool (14933) and then calls `hasMcpToolUsage` (14948, defined
//      at 13583): `'inputSchema' in tool` for EVERY tool (13588), before any field is read.
//   2. When its AFC loop would run (a callable tool, AFC not disabled: 14594),
//      `findAfcIncompatibleToolIndexes` (14597, defined at 14470) reads EVERY tool's
//      `functionDeclarations` (14482), and the SDK rejects the call there if one is non-empty.
//   3. Then the request converters, TOOL BY TOOL (`toolToMldev$1(tTool(item))` at 10064,
//      `toolToVertex(tTool(item))` at 10237): `tTool` (3322) reads `functionDeclarations` (3323),
//      then `toolToMldev$1` (12208) / `toolToVertex` (12275) read SDK_TOOL_FIELDS in order.
//
// So `inputSchema` presence is captured for every tool first; then, with a callable tool, every
// tool's `functionDeclarations`; then, tool by tool, its `functionDeclarations` (unless step 2 took
// it) and the rest in the converters' order. Each field is still read ONCE: where the SDK reads one
// twice (`functionDeclarations`, in step 2 or `tTool` and again in its converter), the snapshot
// keeps the FIRST read, the one the SDK decides on. `generateContentStream` makes the same reads,
// except that with a callable tool it runs step 2 (14690) before step 1 (14994); the governed
// stream refuses every such call before the SDK reads anything, so that order cannot reach it.

/** The converters' fields that follow `functionDeclarations`'s first read (step 3 above). */
const SDK_TOOL_FIELDS_AFTER_DECLARATIONS = SDK_TOOL_FIELDS.filter(
	(key) => key !== "functionDeclarations",
);

/** A canonical numeric string (`"0"`, `"12"`; never `"01"`): the form an array index key takes. */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/** The largest array index, 2^32 - 2: a key of 2^32 - 1 or more is a named property, not an index. */
const MAX_ARRAY_INDEX = 4294967294;

/** `key` is an array index: canonical, and numerically at most 2^32 - 2. */
function isArrayIndex(key: string): boolean {
	return ARRAY_INDEX.test(key) && Number(key) <= MAX_ARRAY_INDEX;
}

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
 * `proto` is SOME realm's `Array.prototype`, authenticated the way `isRealmObjectPrototype`
 * authenticates Object's: it is an array (every realm's `Array.prototype` is), its own
 * prototype is some realm's `Object.prototype`, and its own `constructor` is a DATA property
 * holding a native function named "Array" whose own `prototype` is `proto` itself. Descriptors
 * only, and a Proxy anywhere is not plain, so no caller code runs. A plain array used as a
 * prototype (it has no own `constructor`), or an array subclass's prototype, fails it.
 */
function isRealmArrayPrototype(proto: unknown): boolean {
	if (proto === Array.prototype) return true;
	if (proto === null || typeof proto !== "object" || utilTypes.isProxy(proto)) return false;
	if (!Array.isArray(proto) || !isRealmObjectPrototype(Object.getPrototypeOf(proto))) return false;
	return hasNativeConstructor(proto, "Array");
}

/**
 * `proto`'s own `constructor` is a DATA property holding a non-Proxy native function whose own
 * `name` is `name` and whose own `prototype` is `proto`, read through descriptors and the
 * captured `Function.prototype.toString` only.
 *
 * This recognises a realm's prototype by SHAPE; it does not prove it. A deliberately forged
 * prototype passes: a bound function's toString reads as native code, and a bound function
 * can be given an own `name` ("Object" or "Array") and an own `prototype` that points back.
 * Fields inherited from such a prototype are then missing from the forwarded copy. What is
 * checked, metered and sent is still that same copy, so the effect is on how faithfully
 * nested fields are copied, never on what governance decides or charges.
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

/**
 * Refuse (UncloneableAfcInput, naming the path) a value that `structuredClone` would copy
 * LOSSILY for the SDK. The SDK reads below a tool field with plain property access too (a
 * declaration's `name`, a `parameters` Schema, recursively), so an inherited getter or a
 * non-enumerable property there reaches the provider natively, while structuredClone keeps
 * own enumerable data only. Per-type field lists cannot follow a recursive Schema, so below
 * the tool's top-level fields the snapshot does not capture, it REFUSES: "can't tell".
 *
 * Allowed: primitives; plain objects (prototype `null` or ANY realm's `Object.prototype`, so
 * data built in a `vm` context or a test runner's realm counts) whose own string-keyed
 * properties are all enumerable DATA; and DENSE arrays (any realm's `Array.prototype`)
 * holding enumerable data at every index below `length` and no other key besides `length`
 * (an index is canonical, `"0"` or no leading zero, and at most 2^32 - 2). Refused: an object
 * whose prototype is not Object's or null (a class instance: a user class, `Date`, `Map`, a
 * typed array; or one made with `Object.create` from another object), an array whose
 * prototype is not Array's (an array subclass, or another array used as a prototype), an
 * accessor, a non-enumerable property, a sparse array, an array with an extra named property
 * (`"01"` and `"4294967295"` are named properties, not indexes), a function. Symbol keys are
 * neither read by the SDK nor copied by structuredClone, so they are ignored.
 *
 * The walk runs NO caller code: every object is Proxy-checked (`util.types.isProxy`, no
 * trap) before its prototype or descriptors are read, and only descriptors are read, never
 * a value through an accessor. It is iterative (no recursion depth limit) and visits each
 * object once, so a cycle ends it.
 */
function refuseLossyClone(root: unknown, rootAt: string): void {
	const visited = new Set<object>();
	const pending: Array<{ value: unknown; at: string }> = [{ value: root, at: rootAt }];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const { value, at } = next;
		if (typeof value === "function") throw new UncloneableAfcInput(at);
		if (value === null || typeof value !== "object") continue;
		if (visited.has(value)) continue;
		visited.add(value);
		rejectProxy(value, at);
		const isArray = Array.isArray(value);
		const proto = Object.getPrototypeOf(value);
		const plainProto = isArray
			? isRealmArrayPrototype(proto)
			: proto === null || isRealmObjectPrototype(proto);
		if (!plainProto) throw new UncloneableAfcInput(at);
		const keys = Reflect.ownKeys(value).filter((k): k is string => typeof k === "string");
		if (isArray) {
			const length = (value as unknown[]).length; // `length` is own data on a real array
			for (const key of keys) {
				if (key === "length") continue;
				if (!isArrayIndex(key)) throw new UncloneableAfcInput(`${at}.${key}`);
			}
			// Dense: EVERY index below `length` is own (its descriptor is checked below, with the
			// other keys). This stops at the first hole, so it never runs past the own keys + 1,
			// and a dense array costs O(length), as its clone does.
			for (let i = 0; i < length; i++) {
				if (Object.getOwnPropertyDescriptor(value, String(i)) === undefined) {
					throw new UncloneableAfcInput(at); // sparse
				}
			}
		}
		for (const key of keys) {
			if (isArray && key === "length") continue;
			const keyAt = isArray ? `${at}[${key}]` : `${at}.${key}`;
			const d = Object.getOwnPropertyDescriptor(value, key);
			if (d === undefined || !("value" in d) || d.enumerable !== true) {
				throw new UncloneableAfcInput(keyAt);
			}
			pending.push({ value: d.value, at: keyAt });
		}
	}
}

/**
 * A non-callable tool as data WE own: EXACTLY the fields the SDK reads, nothing else (its
 * other properties are neither read nor sent by the SDK, so they are never read here).
 * `copyDataTools` fills it in the SDK's read order (see above), across all the tools of one
 * request, with the helpers below. So the copy holds every field the SDK reads,
 * `functionDeclarations` included, and the verdict, which reads the copy, sees what the SDK
 * will see: a declarations getter beside a callable tool is the SDK's own local error, not an
 * AFC loop.
 */
interface DataToolCopy {
	/** The caller's tool, read field by field, each field once. */
	tool: object;
	at: string;
	/** The copy, forwarded in the tool's place. */
	out: Record<string, unknown>;
}

/**
 * SDK_TOOL_PRESENCE_FIELD carried as PRESENT (`undefined`) when `in` would find it (own,
 * inherited or non-enumerable), with no getter run and `undefined` whatever it holds: the SDK
 * only tests `in`, and never reads the value.
 */
function captureToolPresence(copy: DataToolCopy): void {
	if (presentOnChain(copy.tool, SDK_TOOL_PRESENCE_FIELD, copy.at)) {
		setData(copy.out, SDK_TOOL_PRESENCE_FIELD, undefined);
	}
}

/**
 * One field CAPTURED once (`captureOnce`: own, non-enumerable or inherited, a getter run once),
 * checked to clone faithfully at every depth (`refuseLossyClone`) and `structuredClone`d AT
 * ONCE, before the next field is read: no live reference is kept, so a later getter that changes
 * an already-captured value (or a tool that holds itself) cannot reach the copy. A field that
 * cannot be copied as data is UncloneableAfcInput, naming it.
 */
function captureToolField(copy: DataToolCopy, key: string): void {
	const value = captureOnce(copy.tool, key, copy.at);
	if (value === undefined) return; // the SDK's `!= null` / `!== undefined`: as absent
	const keyAt = `${copy.at}.${key}`;
	// Checked, then cloned at once: neither runs caller code (the walk reads descriptors
	// only; a value that passed it is plain data, which structuredClone copies without a
	// getter), so the clone is exactly what was checked.
	refuseLossyClone(value, keyAt);
	let cloned: unknown;
	try {
		cloned = structuredClone(value);
	} catch {
		throw new UncloneableAfcInput(keyAt);
	}
	setData(copy.out, key, cloned);
}

/**
 * The data tools of one request, read in the SDK's order: every tool's `inputSchema` presence;
 * with a callable tool in the request (`afcRuns`), every tool's `functionDeclarations`; then,
 * tool by tool, the converters' reads. Each field is read once.
 */
function copyDataTools(copies: readonly DataToolCopy[], afcRuns: boolean): void {
	for (const copy of copies) captureToolPresence(copy);
	if (afcRuns) {
		for (const copy of copies) captureToolField(copy, "functionDeclarations");
	}
	for (const copy of copies) {
		if (!afcRuns) captureToolField(copy, "functionDeclarations");
		for (const key of SDK_TOOL_FIELDS_AFTER_DECLARATIONS) captureToolField(copy, key);
	}
}

/** A tool that is not an object, copied as data (`structuredClone`), or UncloneableAfcInput. */
function cloneNonObjectTool(tool: unknown, at: string): unknown {
	try {
		return structuredClone(tool);
	} catch {
		throw new UncloneableAfcInput(at);
	}
}

/**
 * `obj` as an object WE own, for an AFC-relevant config object (`automaticFunctionCalling`,
 * `toolConfig`, `functionCallingConfig`): a NULL-PROTOTYPE object, so nothing is inherited
 * from the caller or from `Object.prototype`; every own property captured (an accessor
 * read once, on the original receiver) and written with `setData`; and the named `keys`
 * (every field the SDK reads from that object, the SDK_*_FIELDS lists above) also
 * resolved through the caller's prototype chain, read once, as the SDK's plain reads would
 * find them. The SDK only reads properties of these objects (and spreads them), so a null
 * prototype is safe for it. The values are the caller's (shallow); the fields the AFC
 * decision reads are primitives.
 */
function ownedDataCopy(obj: unknown, at: string, keys: readonly string[]): unknown {
	if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return obj;
	rejectProxy(obj, at);
	const out = Object.create(null) as Record<string | symbol, unknown>;
	for (const key of Reflect.ownKeys(obj)) {
		const d = Object.getOwnPropertyDescriptor(obj, key);
		if (d === undefined) continue;
		setData(out, key, "value" in d ? d.value : d.get === undefined ? undefined : d.get.call(obj));
	}
	for (const key of keys) {
		if (!Object.hasOwn(out, key)) {
			const value = captureOnce(obj, key, at);
			if (value !== undefined) setData(out, key, value);
		}
	}
	return out;
}

/**
 * `functionCallingConfig` as Vertex AI sends it, computed ONCE, as plain JSON data. On Vertex AI
 * the SDK sends the caller's object through `JSON.stringify`, so its wire form is whatever that
 * makes of it: a `toJSON` hook runs (own or inherited, enumerable or not), and its result is
 * what is sent; otherwise own enumerable properties only (an accessor read once), recursively,
 * hooks included. A copy of the object's fields cannot be that: a hook hidden from `Object.keys`
 * (non-enumerable, or a class method) survives the forwarded copy but not the PII redaction
 * clone, which rebuilds the request from `Object.keys`, so with PII in the prompt a hook that
 * restricts function calling (`toJSON` returning `{ mode: "NONE" }`) was silently dropped.
 *
 * So the snapshot runs that same serialization here, once, under the key the request
 * converter gives it (`toJSON` receives the key), and forwards the result: plain data, sent
 * byte for byte as the SDK would send the caller's object, and every field of it walked by
 * redaction. The SDK's later `JSON.stringify` runs no caller code on it. Caller code runs once,
 * as it does natively per request; a Proxy is refused before any trap runs. A serialization
 * that throws (a throwing hook or getter, a cycle, a BigInt), and one that yields `null`
 * (natively sent as `null`, but the converter drops a `null` value before serializing), are
 * UncloneableAfcInput: the call is refused, naming the path. A hook that yields `undefined`
 * leaves the field out, as natively. No AFC decision reads this object on Vertex AI: the SDK's
 * one read of it by name (`streamFunctionCallArguments`, 14699) is in the AFC stream branch,
 * which the governed stream refuses before the SDK runs.
 */
function vertexWireForm(callingConfig: unknown, at: string): unknown {
	if (
		callingConfig === null ||
		(typeof callingConfig !== "object" && typeof callingConfig !== "function")
	) {
		return callingConfig;
	}
	rejectProxy(callingConfig, at);
	let wire: unknown;
	try {
		const text = JSON.stringify({ functionCallingConfig: callingConfig });
		wire = (JSON.parse(text) as Record<string, unknown>)["functionCallingConfig"];
	} catch {
		throw new UncloneableAfcInput(at);
	}
	if (wire === null) throw new UncloneableAfcInput(at);
	return wire;
}

/**
 * `config.toolConfig` as data we own (`ownedDataCopy`), with its `functionCallingConfig` copied
 * as the backend's converter reads it: field by field on the Gemini API, as its JSON wire form on
 * Vertex AI (`vertexWireForm`). The snapshot calls this after every tool has been read.
 */
function copyToolConfig(callerToolConfig: unknown, vertexAI: boolean): unknown {
	const toolConfigAt = "params.config.toolConfig";
	const toolConfig = ownedDataCopy(callerToolConfig, toolConfigAt, SDK_TOOL_CONFIG_FIELDS);
	if (toolConfig !== null && typeof toolConfig === "object") {
		const callingAt = `${toolConfigAt}.functionCallingConfig`;
		const captured = (toolConfig as Record<string, unknown>)["functionCallingConfig"];
		// The Gemini API reads its fields by name; Vertex AI serializes it whole.
		const callingConfig = vertexAI
			? vertexWireForm(captured, callingAt)
			: ownedDataCopy(captured, callingAt, SDK_FUNCTION_CALLING_FIELDS);
		setData(toolConfig as Record<string, unknown>, "functionCallingConfig", callingConfig);
	}
	return toolConfig;
}

/**
 * Copy the request object `obj` (`params`, `params.config`) onto a fresh object with its
 * prototype, re-installing NO accessor: every accessor found on `obj` or up its prototype
 * chain (to `Object.prototype`, exclusive) is CAPTURED once, on the ORIGINAL receiver
 * (`get.call(obj)`), and stored as own data, so a getter backed by a `#private` field (which
 * would throw on any other receiver) still works, and a getter is never read twice. Own
 * data properties are copied, and inherited non-function data captured, the same way.
 * EVERY value is written ENUMERABLE (`setData`): the copy is an ordinary data object, so the
 * PII scan and redaction, which walk `Object.keys`, see everything the SDK can read (a class
 * getter is non-enumerable, and a captured `contents` kept that flag would be detected by
 * the prompt scan yet skipped by redaction, and sent raw). Methods stay inherited. The
 * `captured` keys are skipped: the snapshot sets those itself. Each prototype on the walk
 * is Proxy-checked before it is touched.
 *
 * `ownEnumerableOnly` is the copy the SDK itself makes of `params.config` when `config.tools`
 * is set (`processParamsMaybeAddMcpUsage`: `Object.assign({}, params.config, …)`), and its
 * request converters read that copy: only `obj`'s OWN ENUMERABLE properties, string and symbol
 * keys in `Reflect.ownKeys` order, an accessor among them run once on `obj`. An inherited or
 * non-enumerable field is neither read nor copied, and the prototype chain is not walked. The
 * copy's prototype is then `Object.prototype`, as `Object.assign({}, …)` makes it, NOT the
 * caller's. The SDK still reads a few config fields BY NAME from the object it is given
 * (`maybeMoveToResponseJsonSchem`'s `responseSchema` and `responseJsonSchema`,
 * `processParamsMaybeAddMcpUsage`'s `httpOptions`). Through the caller's prototype those reads
 * would find fields this copy never captured, run an inherited getter a second time with the
 * copy as its receiver (a `#private`-backed one throws there), and on the stream move what they
 * found into the request. The snapshot decides those reads itself.
 */
function capturedCopy(
	obj: object,
	captured: readonly string[],
	at: string,
	ownEnumerableOnly = false,
): Record<string | symbol, unknown> {
	const out = Object.create(
		ownEnumerableOnly ? Object.prototype : Object.getPrototypeOf(obj),
	) as Record<string | symbol, unknown>;
	const seen = new Set<string | symbol>(captured);
	for (
		let o: object | null = obj;
		o !== null && o !== Object.prototype;
		o = ownEnumerableOnly ? null : Object.getPrototypeOf(o)
	) {
		rejectProxy(o, o === obj ? at : `${at} (its prototype chain)`);
		for (const key of Reflect.ownKeys(o)) {
			if (seen.has(key)) continue;
			seen.add(key);
			const d = Object.getOwnPropertyDescriptor(o, key);
			if (d === undefined) continue;
			if (ownEnumerableOnly && d.enumerable !== true) continue;
			if ("value" in d) {
				// Own data is copied; inherited NON-function data is captured too (a value the
				// SDK would read through the prototype is one the redactor must see). Methods
				// stay inherited.
				if (o === obj || typeof d.value !== "function") setData(out, key, d.value);
				continue;
			}
			setData(out, key, d.get === undefined ? undefined : d.get.call(obj));
		}
	}
	return out;
}

/** `key` is an OWN ENUMERABLE property of `obj`, the keys `Object.assign` copies; read from its descriptor, no getter run. */
function isOwnEnumerable(obj: object, key: string): boolean {
	return Object.getOwnPropertyDescriptor(obj, key)?.enumerable === true;
}

/**
 * `generateContentStream` with `config.tools` set: the SDK runs `maybeMoveToResponseJsonSchem`
 * on the caller's config BEFORE `processParamsMaybeAddMcpUsage` copies it, so a move it makes
 * there reaches the request through the copy. It reads `responseSchema` and `responseJsonSchema`
 * BY NAME, and when `responseSchema` is truthy, `responseJsonSchema` falsy and
 * `Object.keys(responseSchema)` includes `"$schema"`, writes an OWN `responseJsonSchema` holding
 * it and deletes the own `responseSchema`. The SDK then makes the same move on the snapshot
 * (`outConfig`, the own enumerable copy), which matches natively except in two shapes:
 *
 *   - `responseSchema` is not in the copy (inherited, non-enumerable) and the move happens: natively
 *     the copy carries `responseJsonSchema`, so the snapshot carries it the same way, as an own
 *     `responseJsonSchema` holding the value read once, and no `responseSchema`.
 *   - `responseSchema` is in the copy with `"$schema"` and `responseJsonSchema` is truthy by name
 *     but not in it: natively nothing moves and `responseSchema` is sent, but the SDK would move it
 *     on the snapshot, and a copy cannot hold a field that is truthy by name yet never sent (the
 *     redaction clone rebuilds the request from `Object.keys`). Can't tell: INDETERMINATE.
 *
 * Each field is read once, in the SDK's order, and only where the SDK reads it.
 */
function moveResponseSchemaAsTheStreamDoes(
	config: object,
	outConfig: Record<string | symbol, unknown>,
): void {
	const schemaCopied = Object.hasOwn(outConfig, "responseSchema");
	const jsonSchemaCopied = Object.hasOwn(outConfig, "responseJsonSchema");
	if (schemaCopied && jsonSchemaCopied) return; // the SDK's move on the copy is the native one
	const schema = schemaCopied
		? outConfig["responseSchema"]
		: captureOnce(config, "responseSchema", "params.config");
	if (!schema) return;
	const jsonSchema = jsonSchemaCopied
		? outConfig["responseJsonSchema"]
		: captureOnce(config, "responseJsonSchema", "params.config");
	if (jsonSchema) {
		if (schemaCopied && Object.keys(schema).includes("$schema")) throw INDETERMINATE;
		return;
	}
	if (!schemaCopied && Object.keys(schema).includes("$schema")) {
		setData(outConfig, "responseJsonSchema", schema);
	}
}

/**
 * Does this Google client send to Vertex AI? The SDK picks its request converters per call
 * with `this.apiClient.isVertexAI()` (`dist/node/index.mjs` 12987: `clientOptions.vertexai`,
 * tested for truthiness), and `GoogleGenAI`'s constructor stores that same value as its own
 * `vertexai` data property (21266, `resolveCloudFlag`: the `vertexai` or `enterprise` option, or
 * their environment variables) before handing it to the ApiClient. Read from the RAW client,
 * once, from its descriptor: no getter or Proxy trap runs. Anything else (no such property, an
 * accessor, a Proxy) answers false, the Gemini API reading, under which every captured field is
 * enumerable and so seen by redaction.
 */
export function googleClientIsVertexAI(client: unknown): boolean {
	if (client === null || (typeof client !== "object" && typeof client !== "function")) {
		return false;
	}
	if (utilTypes.isProxy(client)) return false;
	return Boolean(ownDataValue(client, "vertexai")?.value);
}

/**
 * "Send what was checked", for AUTOMATIC FUNCTION CALLING only. The SDK reads
 * `params.config` after an `await` (`generateContent` awaits
 * `processParamsMaybeAddMcpUsage(params)` before `hasCallableTools` /
 * `shouldDisableAfc`), and the governor itself awaits authorization first, so a caller
 * that keeps a reference could add a callable tool, or flip `disable`, after the check
 * and before the SDK's read. The verdict therefore runs on — and the SDK receives — a
 * snapshot whose AFC-relevant parts are objects the caller never held:
 *
 *   - `params` and `params.config`: fresh shallow copies with the same prototype
 *     (`capturedCopy`): own data copied, every accessor (own or inherited) CAPTURED once on
 *     the original receiver, none re-installed. `config` itself must be an object (or
 *     absent): anything else is indeterminate.
 *   - `params.config` is copied AS THE SDK COPIES IT. `config.tools` is read first, by name;
 *     when it is truthy (`[]` included), `processParamsMaybeAddMcpUsage` sends
 *     `Object.assign({}, params.config, { tools })`, so the snapshot keeps only the config's
 *     OWN ENUMERABLE fields, on an `Object.prototype` copy (`capturedCopy`'s
 *     `ownEnumerableOnly`): an inherited or non-enumerable field is never read and never sent,
 *     as natively. `toolConfig` is then read only when own enumerable; `automaticFunctionCalling`
 *     is read by name, as `shouldDisableAfc` reads it. Two shapes are indeterminate there: an
 *     `httpOptions` present but not own enumerable (the SDK reads it by name only on its MCP
 *     path, which turns on a flag the snapshot cannot see), and, for `generateContentStream`
 *     (`options.method`), the one move `maybeMoveToResponseJsonSchem` makes before the copy that
 *     the snapshot cannot express (`moveResponseSchemaAsTheStreamDoes`). Without tools the SDK
 *     passes `params` through, its converters read every config field by name, and the snapshot
 *     captures them all, inherited ones included.
 *   - `config.automaticFunctionCalling`, `config.toolConfig` and its
 *     `functionCallingConfig`: owned NULL-PROTOTYPE copies (`ownedDataCopy`), so `disable`, `maximumRemoteCalls` and
 *     `streamFunctionCallArguments` are values we own, and every field the SDK reads from
 *     them (`mode` and `allowedFunctionNames` too) is carried, inherited ones included. With
 *     `options.vertexAI` (the client sends to Vertex AI, which serializes
 *     `functionCallingConfig` whole), that object is instead forwarded as its wire form,
 *     computed once (`vertexWireForm`): plain data, sent as natively, all of it seen by
 *     redaction. `toolConfig`'s fields (and that hook) are read AFTER every tool, where the
 *     SDK's request converters read them (`copyToolConfig`).
 *   - `config.tools`: a NEW array. When the snapshot says AFC is NOT disabled, every
 *     non-callable tool is copied as exactly the fields the SDK reads, in the order the SDK
 *     reads them (`copyDataTools`: each captured once, a `functionDeclarations` getter
 *     included, and cloned at once; a
 *     field that cannot be copied as data, including one holding a function, symbol,
 *     object whose prototype is not Object's or null (a class instance, or one made with
 *     `Object.create` from another object), array whose prototype is not Array's,
 *     accessor, non-enumerable property, sparse array or array with a named property at
 *     any depth (`refuseLossyClone`, then `structuredClone`),
 *     is indeterminate, so the call is refused naming where);
 *     callable tools keep their
 *     reference (generateContent then runs them through runGovernedAfc, which needs the
 *     original objects; the stream refuses them). When the snapshot says AFC IS disabled
 *     (`disable` truthy, or a `maximumRemoteCalls` the SDK reads as invalid), the tool
 *     REFERENCES are kept: callable tools are the documented way to run tools yourself,
 *     and they carry functions that cannot be cloned. That is safe because the
 *     `disable` / `maximumRemoteCalls` the SDK will read are OUR copies: mutating a tool,
 *     or the caller's config, afterwards cannot turn AFC back on.
 *
 * ACCESSORS are read ONCE and their values captured (`captureOnce`): `params.config`,
 * `config.tools`, each `tools[i]`, and the AFC config objects' fields. A getter that
 * answers differently on each read cannot split the check from the SDK, because the SDK
 * only ever reads the captured snapshot. A getter that throws is indeterminate. PROXIES are
 * refused, not read. A callable tool whose `callTool` is an accessor is indeterminate too:
 * a callable tool travels by REFERENCE (it cannot be captured), so its `callTool` would be
 * read again. This closes AFC only. A general snapshot (`contents`, and what the PII and
 * injection scans read) is separate future work; everything outside `config`, and the
 * non-AFC fields inside it, are still read live.
 */
export function snapshotGoogleAfcParams(
	params: unknown,
	options: { vertexAI?: boolean; method?: "generateContent" | "generateContentStream" } = {},
): { params: unknown } | { verdict: Exclude<GoogleAfcVerdict, { kind: "no_afc" | "afc" }> } {
	try {
		if (params === null || (typeof params !== "object" && typeof params !== "function")) {
			return { params }; // nothing a caller could mutate; the SDK handles the shape
		}
		rejectProxy(params, "params");
		const config = captureOnce(params, "config", "params");
		const outParams = capturedCopy(params, ["config"], "params");
		if (config === undefined || config === null) {
			setData(outParams, "config", config);
			return { params: outParams };
		}
		// A config that is not an object cannot be read as one: can't tell.
		if (typeof config !== "object" && typeof config !== "function") throw INDETERMINATE;
		rejectProxy(config, "params.config");
		// `tools` FIRST, by name: `processParamsMaybeAddMcpUsage`'s `params.config?.tools` is the
		// SDK's first read of the config, and ANY truthy value (`[]` included) makes it send a copy.
		const tools = captureOnce(config, "tools", "params.config");
		const sdkCopiesConfig = Boolean(tools);
		// With the copy, an own enumerable `httpOptions` reaches the request through it; any other
		// reaches it only by name, when `hasMcpToolUsage` is true, which also reads a process-global
		// flag (set by the SDK's `mcpToTool`) the snapshot cannot see. Can't tell.
		if (
			sdkCopiesConfig &&
			presentOnChain(config, "httpOptions", "params.config") &&
			!isOwnEnumerable(config, "httpOptions")
		) {
			throw INDETERMINATE;
		}
		const outConfig = capturedCopy(
			config,
			["tools", "automaticFunctionCalling", "toolConfig"],
			"params.config",
			sdkCopiesConfig,
		);
		if (sdkCopiesConfig && options.method === "generateContentStream") {
			moveResponseSchemaAsTheStreamDoes(config, outConfig);
		}

		// By name in both cases: the SDK reads it from the caller's config (`shouldDisableAfc`), and
		// never sends it.
		const afcAt = "params.config.automaticFunctionCalling";
		const afcConfig = ownedDataCopy(
			captureOnce(config, "automaticFunctionCalling", "params.config"),
			afcAt,
			SDK_AFC_CONFIG_FIELDS,
		);
		setData(outConfig, "automaticFunctionCalling", afcConfig);

		// The config's own `toolConfig` accessor is read here, with the other config fields; the
		// object's FIELDS are read last (copyToolConfig below), as the SDK reads them. With the
		// SDK's copy, only an own enumerable `toolConfig` reaches the request; any other is not read.
		const callerToolConfig =
			sdkCopiesConfig && !isOwnEnumerable(config, "toolConfig")
				? undefined
				: captureOnce(config, "toolConfig", "params.config");

		const callables: Array<{ tool: object; at: string; callTool: unknown }> = [];
		// The AFC keys are always set as OWN data properties, `undefined` included: a copy
		// made without tools keeps the caller's prototype, and an own key shadows anything a
		// prototype could be given later.
		setData(outConfig, "tools", tools);
		if (tools !== undefined && tools !== null) {
			rejectProxy(tools, "params.config.tools");
			if (!Array.isArray(tools)) throw INDETERMINATE;
			// The SNAPSHOT's own AFC switch, read the way the SDK reads it. Callable tools are
			// ALWAYS kept by reference (runGovernedAfc wraps them and delegates callTool to the
			// original object); only non-callable tools are ever cloned.
			const disable = dataValue(afcConfig, "disable", afcAt);
			const n = dataValue(afcConfig, "maximumRemoteCalls", afcAt);
			// A value the rule cannot read without running caller code counts as NOT
			// disabling here, which takes the stricter (cloning) path; the verdict decides
			// about it only if a callable tool is present, as the SDK does.
			let invalidMax = false;
			try {
				invalidMax = sdkDisablesForMaxCalls(n);
			} catch {
				invalidMax = false;
			}
			const afcDisabled = Boolean(disable) || invalidMax;
			const outTools: unknown[] = new Array(tools.length);
			// Each callable tool is classified ONCE, here, from a CAPTURED `callTool` reference,
			// and kept by reference (runGovernedAfc needs the original object). Caller code can
			// still run after a callable was read: a later tool's array-index getter, or a data
			// tool's field getter. Such code could clear a callable's `callTool` so the verdict
			// (`readAfc`, which reads the snapshot) sees no callable tool, and restore it before
			// the SDK reads the request: one governed call over the SDK's own AFC loop. So, once
			// every tool is read, each callable must still hold the SAME captured function, or
			// the request is "can't tell".
			const dataTools: DataToolCopy[] = [];
			// Every element first, each read once, as the SDK iterates the whole array
			// (`tools.map` in processParamsMaybeAddMcpUsage) before it reads any tool's field.
			for (let i = 0; i < tools.length; i++) {
				if (!(i in tools)) continue; // keep holes as holes
				const at = `params.config.tools[${i}]`;
				const tool = captureOnce(tools, String(i), "params.config.tools");
				if (afcDisabled) {
					outTools[i] = tool; // references: see the doc comment
					continue;
				}
				if (tool === null || (typeof tool !== "object" && typeof tool !== "function")) {
					outTools[i] = cloneNonObjectTool(tool, at);
					continue;
				}
				rejectProxy(tool, at);
				const callTool = dataValue(tool, "callTool", at);
				if (typeof callTool === "function") {
					callables.push({ tool, at, callTool });
					outTools[i] = tool; // callable: by reference, never cloned
					continue;
				}
				// A function that is not a callable tool cannot be copied as data.
				if (typeof tool === "function") throw new UncloneableAfcInput(at);
				const copy: DataToolCopy = { tool, at, out: {} };
				dataTools.push(copy);
				outTools[i] = copy.out;
			}
			// Then their fields, in the SDK's read order. AFC is not disabled here, so with a
			// callable tool the SDK would run findAfcIncompatibleToolIndexes.
			copyDataTools(dataTools, callables.length > 0);
			setData(outConfig, "tools", outTools);
		}
		// toolConfig LAST, after every tool read: the SDK reads its fields only in its request
		// converters (`toolConfigToMldev(fromToolConfig)` at 10071, `toolConfigToVertex` at
		// 10244), after `findAfcIncompatibleToolIndexes` and after every tool's converter (10064,
		// 10237), and Vertex AI runs a `toJSON` hook later still, when it serializes. A getter or
		// hook there that changes a tool therefore cannot reach the snapshot's tools, as natively.
		setData(outConfig, "toolConfig", copyToolConfig(callerToolConfig, options.vertexAI === true));
		// The callable check runs after ALL caller code the snapshot runs (tool getters, toolConfig
		// getters, a toJSON hook). No caller code runs between it and the verdict (both read data
		// only), and a tool classified non-callable is our CLONE (or AFC is off on our own copy),
		// so the classification cannot change at the boundary in a way that unmeters a round: a
		// callable that stops being one later goes into rounds whose AFC is off.
		for (const { tool, at, callTool } of callables) {
			if (dataValue(tool, "callTool", at) !== callTool) throw INDETERMINATE;
		}
		setData(outParams, "config", outConfig);
		return { params: outParams };
	} catch (err) {
		if (err instanceof ProxyInAfcInput)
			return { verdict: { kind: "indeterminate", proxyAt: err.at } };
		if (err instanceof UncloneableAfcInput) {
			return { verdict: { kind: "indeterminate", uncloneableAt: err.at } };
		}
		return { verdict: { kind: "indeterminate" } };
	}
}

function isContent(v: unknown): v is Loose {
	return isObject(v) && "parts" in v && Array.isArray(v["parts"]);
}

function hasFunctionPart(v: unknown): boolean {
	return isObject(v) && ("functionCall" in v || "functionResponse" in v);
}

function toPart(v: unknown): unknown {
	if (v === null || v === undefined) throw new Error("PartUnion is required");
	if (typeof v === "object") return v;
	if (typeof v === "string") return { text: v };
	throw new Error(`Unsupported part type: ${typeof v}`);
}

/**
 * `contents` as a list of `Content`, EXACTLY as the SDK's `tContents` normalises it (including the errors it throws, so a
 * malformed request fails the same way governed and ungoverned, before any round is charged): an item is a `Content` only
 * if it has a `parts` ARRAY; an array whose first item is not a Content is ONE user turn of every item (strings become
 * `{ text }`); mixing Content and Parts is an error; function-call and function-response parts must be wrapped in a
 * Content.
 */
function toContents(contents: unknown): Loose[] {
	if (
		contents === null ||
		contents === undefined ||
		(Array.isArray(contents) && contents.length === 0)
	) {
		throw new Error("contents are required");
	}
	if (!Array.isArray(contents)) {
		if (hasFunctionPart(contents)) {
			throw new Error(
				"To specify functionCall or functionResponse parts, please wrap them in a Content object, specifying the role for them",
			);
		}
		return [isContent(contents) ? contents : { role: "user", parts: [toPart(contents)] }];
	}
	const result: Loose[] = [];
	const accumulated: unknown[] = [];
	const isContentArray = isContent(contents[0]);
	for (const item of contents as unknown[]) {
		const itemIsContent = isContent(item);
		if (itemIsContent !== isContentArray) {
			throw new Error(
				"Mixing Content and Parts is not supported, please group the parts into a the appropriate Content objects and specify the roles for them",
			);
		}
		if (itemIsContent) {
			result.push(item as Loose);
		} else if (hasFunctionPart(item)) {
			throw new Error(
				"To specify functionCall or functionResponse parts, please wrap them, and any other parts, in Content objects as appropriate, specifying the role for them",
			);
		} else {
			accumulated.push(item);
		}
	}
	if (!isContentArray) result.push({ role: "user", parts: accumulated.map(toPart) });
	return result;
}

export interface AfcRoundResult {
	response: unknown;
	receipt?: unknown;
}

export type AfcRound = (roundParams: Loose) => Promise<AfcRoundResult>;

/**
 * Run the loop, one governed `round` per model call. Resolves the envelope the governed call returns: the LAST round's
 * `response` (carrying `automaticFunctionCallingHistory` unless `ignoreCallHistory`) and receipt, plus `receipts`, one per
 * round, so the caller can see every charge. A round that throws (a denied policy, an exhausted budget, a provider error)
 * ends the call there: earlier rounds are already settled, and nothing after it runs.
 */
export async function runGovernedAfc(
	params: Loose,
	round: AfcRound,
): Promise<AfcRoundResult & { receipts: unknown[] }> {
	// The request is read ONCE, as the SDK reads it, not re-read from the caller's object every round (a getter could answer
	// differently on each read). The fields the loop consumes are read EXPLICITLY: a spread copies only own properties, so
	// a `contents` or `tools` defined as a prototype getter (a class-instance request) would otherwise be lost.
	const rawConfig = params["config"] as Loose;
	const config: Loose = {
		...rawConfig,
		tools: rawConfig["tools"],
		automaticFunctionCalling: rawConfig["automaticFunctionCalling"],
	};
	const baseParams: Loose = {
		...params,
		...(params["model"] !== undefined ? { model: params["model"] } : {}),
		contents: params["contents"],
	};
	const afc = isObject(config["automaticFunctionCalling"])
		? config["automaticFunctionCalling"]
		: {};
	const max =
		typeof afc["maximumRemoteCalls"] === "number"
			? afc["maximumRemoteCalls"]
			: DEFAULT_MAX_REMOTE_CALLS;
	const appendHistory = afc["ignoreCallHistory"] !== true;
	const configTools = config["tools"] as unknown[];
	const tools = configTools.filter(isCallableTool);
	// Declarations are NOT resolved here: the first round's own generateContent asks each tool once, inside the governed call
	// (see snapshotTool).
	const roundTools = configTools.map((t) => (isCallableTool(t) ? snapshotTool(t) : t));

	// The first round is sent the caller's `contents` exactly as given (the SDK normalises only once it appends a turn);
	// the history starts from the normalised form.
	let contents: unknown = baseParams["contents"];
	const history: Loose[] = [...toContents(contents)];
	const receipts: unknown[] = [];
	let last: AfcRoundResult | undefined;
	let remoteCalls = 0;

	while (remoteCalls < max) {
		// The SDK's own loop is off for this round; everything else about the call is the caller's.
		const roundParams: Loose = {
			...baseParams,
			contents,
			config: { ...config, tools: roundTools, automaticFunctionCalling: { ...afc, disable: true } },
		};
		last = await round(roundParams);
		if (last.receipt !== undefined) receipts.push(last.receipt);
		const response = last.response as Loose | null | undefined;
		const calls = isObject(response) ? response["functionCalls"] : undefined;
		if (!Array.isArray(calls) || calls.length === 0) break;
		const candidates = (response as Loose)["candidates"];
		const content =
			Array.isArray(candidates) && isObject(candidates[0]) ? candidates[0]["content"] : undefined;
		const parts: unknown[] = [];
		for (const tool of tools) parts.push(...(await tool.callTool(calls)));
		remoteCalls++;
		const modelTurn = content as Loose;
		const toolTurn: Loose = { role: "user", parts };
		contents = [...toContents(contents), modelTurn, toolTurn];
		if (appendHistory) history.push(modelTurn, toolTurn);
	}

	const response = last?.response;
	if (appendHistory && isObject(response)) {
		(response as Loose)["automaticFunctionCallingHistory"] = history;
	}
	return { response, ...(last?.receipt !== undefined ? { receipt: last.receipt } : {}), receipts };
}
