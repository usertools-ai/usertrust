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

function isCallableTool(
	tool: unknown,
): tool is { callTool: (calls: unknown[]) => Promise<unknown[]> } {
	return isObject(tool) && typeof tool["callTool"] === "function";
}

/**
 * Would the SDK run its automatic-function-calling loop for these params? The same test as its `generateContent`:
 * a callable tool is present, AFC is not disabled, and `maximumRemoteCalls` is not invalid (the SDK disables AFC with a
 * warning for 0, a negative or a non-integer, and then makes ONE plain call, which the ordinary path already governs).
 * Incompatible non-callable function declarations make the SDK throw; that is left to the SDK, so it is not "requested".
 */
export function afcRequested(params: unknown): boolean {
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
	// A plain function declaration beside a callable tool: the SDK throws a clear error before any call.
	for (const tool of tools) {
		if (isCallableTool(tool)) continue;
		const decls = isObject(tool) ? tool["functionDeclarations"] : undefined;
		if (Array.isArray(decls) && decls.length > 0) return false;
	}
	return true;
}

/** `contents` as a list of `Content`, the way the SDK normalises it before it appends the round's turns. */
function toContents(contents: unknown): Loose[] {
	const userText = (text: string): Loose => ({ role: "user", parts: [{ text }] });
	if (typeof contents === "string") return [userText(contents)];
	if (Array.isArray(contents)) {
		if (contents.length === 0) return [];
		const items = contents as unknown[];
		// An array of bare parts is ONE user turn; an array of turns (anything with `parts`) is already contents.
		if (items.every((c) => typeof c === "string")) {
			return [{ role: "user", parts: items.map((text) => ({ text })) }];
		}
		if (items.every((c) => isObject(c) && !("parts" in c) && !("role" in c))) {
			return [{ role: "user", parts: items }];
		}
		return items.map((c) => (typeof c === "string" ? userText(c) : (c as Loose)));
	}
	if (isObject(contents)) {
		return "parts" in contents ? [contents] : [{ role: "user", parts: [contents] }];
	}
	return [];
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
	const tools = (config["tools"] as unknown[]).filter(isCallableTool);

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
			config: { ...config, automaticFunctionCalling: { ...afc, disable: true } },
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
