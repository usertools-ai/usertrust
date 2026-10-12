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

/**
 * Would the SDK run its automatic-function-calling loop for these params? The same test as its `generateContent`:
 * a callable tool is present, AFC is not disabled, and `maximumRemoteCalls` is not invalid (the SDK disables AFC with a
 * warning for 0, a negative or a non-integer, and then makes ONE plain call, which the ordinary path already governs).
 */
export function sdkRunsAfc(params: unknown): boolean {
	if (!isObject(params) || !isObject(params["config"])) return false;
	const config = params["config"];
	const tools = Array.isArray(config["tools"]) ? (config["tools"] as unknown[]) : [];
	if (!tools.some(isCallableTool)) return false;
	const afc = isObject(config["automaticFunctionCalling"])
		? config["automaticFunctionCalling"]
		: {};
	if (afc["disable"] === true) return false;
	const max = afc["maximumRemoteCalls"];
	if (max !== undefined && max !== null) {
		if (typeof max !== "number" || max === 0 || max < 0 || !Number.isInteger(max)) return false;
	}
	return true;
}

/**
 * Should governance run the loop itself? `sdkRunsAfc` and no plain function declaration beside a callable tool: that
 * combination makes the SDK throw a clear error before any call, which is left to the SDK. Any other guard on AFC (a
 * refusal until this loop exists, for example) should use `sdkRunsAfc` alone, so there is ONE predicate for "the SDK would
 * run its own loop".
 */
export function afcRequested(params: unknown): boolean {
	if (!sdkRunsAfc(params)) return false;
	const tools = ((params as Loose)["config"] as Loose)["tools"] as unknown[];
	for (const tool of tools) {
		if (isCallableTool(tool)) continue;
		const decls = isObject(tool) ? tool["functionDeclarations"] : undefined;
		if (Array.isArray(decls) && decls.length > 0) return false;
	}
	return true;
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
