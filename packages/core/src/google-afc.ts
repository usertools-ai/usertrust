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

/**
 * A callable tool whose `tool()` answers from a snapshot taken once. The SDK's native loop awaits every `tool.tool()` ONCE,
 * before its first round; each governed round re-enters the public `generateContent`, which would await it again, so a
 * one-shot or stateful callable could fail on round two and a dynamic one could show different declarations between
 * rounds. A Proxy keeps everything else about the tool (its prototype, so `instanceof` checks such as the SDK's MCP-usage
 * header still hold; `callTool` and every other method run against the real tool).
 */
function snapshotTool(tool: CallableTool, declaration: unknown): CallableTool {
	return new Proxy(tool, {
		get(target, prop) {
			if (prop === "tool") return () => Promise.resolve(declaration);
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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
	const config = params["config"] as Loose;
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
	// Declarations are resolved ONCE, in order, before the first round, as the SDK's native loop does; a failing `tool()`
	// ends the call here, before any round is charged.
	const declarations = new Map<CallableTool, unknown>();
	for (const tool of tools) declarations.set(tool, await tool.tool());
	const roundTools = configTools.map((t) =>
		isCallableTool(t) ? snapshotTool(t, declarations.get(t)) : t,
	);

	// The first round is sent the caller's `contents` exactly as given (the SDK normalises only once it appends a turn);
	// the history starts from the normalised form.
	let contents: unknown = params["contents"];
	const history: Loose[] = [...toContents(contents)];
	const receipts: unknown[] = [];
	let last: AfcRoundResult | undefined;
	let remoteCalls = 0;

	while (remoteCalls < max) {
		// The SDK's own loop is off for this round; everything else about the call is the caller's.
		const roundParams: Loose = {
			...params,
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
