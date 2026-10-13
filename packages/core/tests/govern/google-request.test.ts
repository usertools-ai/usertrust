import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as utilTypes } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import {
	type GoogleModelsCtor,
	resolveGooglePipeline,
	snapshotGoogleRequest,
} from "../../src/google-request.js";
import { trust } from "../../src/govern.js";
import type { AuditEvent } from "../../src/shared/types.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

/**
 * The governed Google request is read by the SDK's OWN pipeline (google-request.ts): the SDK runs once over the
 * caller's request behind a recording membrane, the recording becomes plain data, and a self-check runs the SDK
 * again over that data. These rows run the real `@google/genai` with only `fetch` stubbed, natively and governed, on
 * both backends and both methods, and compare what reaches the provider, what caller code ran, and what was audited.
 */

type Loose = Record<string, unknown>;
type Method = "generateContent" | "generateContentStream";
type Round = { functionCalls?: Loose[]; text: string };

const METHODS = ["generateContent", "generateContentStream"] as const;
const BACKENDS = [
	["Gemini API", false],
	["Vertex AI", true],
] as const;
const EMAIL = "jane.doe@example.com";
const REDACTED = "[REDACTED:email]";
/** The stand-ins' probe function: it must never surface to the caller or the audit trail. */
const PROBE = "__usertrust_probe";
const LOOP: Round[] = [
	{ functionCalls: [{ name: "lookup", args: {} }], text: "" },
	{ text: "done" },
];

/** A `fetch` stand-in recording each provider request and answering with the next scripted round. */
function wire(
	rounds: Round[] = [{ text: "done" }],
	usage = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
) {
	const requests: Array<{
		url: string;
		body: Loose;
		testHeader: string | null;
		timeoutHeader: string | null;
	}> = [];
	const fetchStub = async (
		url: unknown,
		init?: { body?: unknown; headers?: HeadersInit },
	): Promise<Response> => {
		requests.push({
			url: String(url),
			body: JSON.parse(String(init?.body)) as Loose,
			// a caller's own header, sent through `config.httpOptions.headers`
			testHeader: new Headers(init?.headers).get("x-test"),
			// the transport's header for `config.httpOptions.timeout`
			timeoutHeader: new Headers(init?.headers).get("x-server-timeout"),
		});
		const r = rounds[Math.min(requests.length - 1, rounds.length - 1)] as Round;
		const payload = {
			candidates: [
				{
					content: {
						role: "model",
						parts: [
							...(r.functionCalls ?? []).map((functionCall) => ({ functionCall })),
							{ text: r.text },
						],
					},
				},
			],
			usageMetadata: usage,
		};
		return String(url).includes(":streamGenerateContent")
			? new Response(`data: ${JSON.stringify(payload)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			: new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
	};
	return { requests, fetchStub };
}

/** One call, a stream drained to its end: "ok", or the error's message (and the error itself). */
async function runOn(
	models: unknown,
	method: Method,
	params: unknown,
): Promise<{ result: string; error?: unknown }> {
	try {
		const out = await (models as Record<Method, (p: unknown) => Promise<unknown>>)[method](params);
		if (method === "generateContentStream") {
			for await (const _ of out as AsyncIterable<unknown>) {
				// drained
			}
		}
		return { result: "ok" };
	} catch (error) {
		return { result: (error as Error).message, error };
	}
}

function recordingAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: String(events.length).padStart(64, "0"),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		},
		getWriteFailures: () => 0,
		isDegraded: () => false,
		flush: async () => {},
		release: () => {},
	};
}

/** A callable tool (the SDK's CallableTool shape) declaring `name`, its `tool()` / `callTool()` calls counted. */
function callable(name = "lookup") {
	const calls = { tool: 0, callTool: 0 };
	return {
		calls,
		tool: {
			tool: async () => {
				calls.tool++;
				return { functionDeclarations: [{ name }] };
			},
			callTool: async () => {
				calls.callTool++;
				return [{ functionResponse: { name, response: { ok: true } } }];
			},
		},
	};
}

const request = (config: object, contents: unknown = "go") => ({
	model: "gemini-2.5-flash",
	contents,
	config,
});

let vault: string;
const realFetch = globalThis.fetch;
beforeEach(() => {
	vault = join(tmpdir(), `trust-google-request-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
});
afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(vault, { recursive: true, force: true });
});

const sdkClient = (vertex: boolean) =>
	new GoogleGenAI(vertex ? { vertexai: true, apiKey: "test" } : { apiKey: "test" });

/**
 * `native()` on the SDK ungoverned, then `governed()` on a governed client of the same backend, each on its own
 * wire. Every row also checks that the stand-ins' probe name reaches neither the caller nor the audit trail.
 */
async function nativeThenGoverned(
	method: Method,
	params: { native: () => unknown; governed: () => unknown },
	opts: { vertex?: boolean; pii?: "redact" | "block"; rounds?: Round[] } = {},
) {
	const raw = wire(opts.rounds);
	globalThis.fetch = raw.fetchStub as typeof fetch;
	const native = await runOn(sdkClient(opts.vertex === true).models, method, params.native());
	const gov = wire(opts.rounds);
	globalThis.fetch = gov.fetchStub as typeof fetch;
	const audit = recordingAudit();
	const governed = await trust(sdkClient(opts.vertex === true), {
		dryRun: true,
		budget: 500_000,
		vaultBase: vault,
		_audit: audit,
		...(opts.pii !== undefined ? { pii: opts.pii } : {}),
	});
	const outcome = await runOn(governed.models, method, params.governed());
	await governed.destroy();
	expect(outcome.result).not.toContain(PROBE);
	expect(JSON.stringify(audit.events)).not.toContain(PROBE);
	expect(JSON.stringify(gov.requests)).not.toContain(PROBE);
	return {
		raw,
		rawResult: native.result,
		rawError: native.error,
		gov,
		govResult: outcome.result,
		govError: outcome.error,
		auditKinds: audit.events.map((e) => e.kind),
		events: audit.events,
	};
}

type Outcome = Awaited<ReturnType<typeof nativeThenGoverned>>;

/** The same factory for both calls: a fresh request each time. */
const same = (make: () => unknown) => ({ native: make, governed: make });

/** Governed sends exactly what the SDK sends natively, request for request. */
function expectSameSend(r: Outcome): void {
	expect(r.govResult).toBe(r.rawResult);
	expect(r.gov.requests.map((q) => q.url)).toEqual(r.raw.requests.map((q) => q.url));
	expect(r.gov.requests.map((q) => q.body)).toEqual(r.raw.requests.map((q) => q.body));
}

/** The native body with every string that IS the e-mail replaced by redaction's placeholder. */
function redactedNative(r: Outcome): unknown[] {
	return r.raw.requests.map(
		(q) => JSON.parse(JSON.stringify(q.body).replaceAll(`"${EMAIL}"`, `"${REDACTED}"`)) as unknown,
	);
}

/** The SDK's own local rejection: the native error, rethrown as it is, audited as a refusal, no request. */
function expectSdkError(r: Outcome): void {
	expect(r.rawError).toBeInstanceOf(Error);
	expect(r.govResult).toBe(r.rawResult);
	expect((r.govError as Error).constructor).toBe((r.rawError as Error).constructor);
	expect(r.auditKinds).toEqual(["policy_denied"]);
	// the refusal names the error's class, never its message: a message may carry the caller's content
	const audited = String((r.events[0]?.data as Loose | undefined)?.["error"]);
	expect(audited).toContain(
		`rejected by the SDK before any request (${(r.rawError as Error).constructor.name})`,
	);
	expect(JSON.stringify(r.events)).not.toContain(r.rawResult);
	expect(r.raw.requests).toHaveLength(0);
	expect(r.gov.requests).toHaveLength(0);
}

/** The streamed AFC loop is refused: audited, no request. */
function expectAfcStreamRefused(r: Outcome): void {
	expect(r.govResult).toContain("with automatic function calling is not governed yet");
	expect(r.auditKinds).toEqual(["policy_denied"]);
	expect(r.gov.requests).toHaveLength(0);
}

describe("caller code observing the SDK's own writes runs as natively (write-through)", () => {
	/** A declaration whose `description` getter observes tTool's in-place rewrite of `parameters`. */
	const observingDeclaration = () => {
		const parameters = { type: "object", properties: { q: { type: "string" } } };
		const declaration: Loose = { name: "lookup", parameters };
		Object.defineProperty(declaration, "description", {
			enumerable: true,
			configurable: true,
			get(this: Loose) {
				return this["parameters"] === parameters ? `ask ${EMAIL}` : "plain";
			},
		});
		return request({ tools: [{ functionDeclarations: [declaration] }] });
	};

	/** An own `$schema` responseSchema, and a `systemInstruction` getter that observes whether it is still there. */
	const observingConfig = () => {
		const config: Loose = {
			tools: [{ googleSearch: {} }],
			responseMimeType: "application/json",
			responseSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
		};
		Object.defineProperty(config, "systemInstruction", {
			enumerable: true,
			configurable: true,
			get(this: Loose) {
				return Object.hasOwn(this, "responseSchema") ? `reply to ${EMAIL}` : undefined;
			},
		});
		return request(config);
	};

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: a declaration's description getter that observes the SDK's parameters rewrite sends what it sends natively`, async () => {
				const r = await nativeThenGoverned(method, same(observingDeclaration), { vertex });
				expectSameSend(r);
				expect(r.raw.requests).toHaveLength(1);
			});

			it(`${on}: a systemInstruction getter that observes the SDK's responseSchema move sends what it sends natively`, async () => {
				const r = await nativeThenGoverned(method, same(observingConfig), { vertex });
				expectSameSend(r);
				expect(r.raw.requests).toHaveLength(1);
			});
		}
	}

	for (const [backend, vertex] of BACKENDS) {
		it(`generateContent on ${backend}: tools and a $schema responseSchema send what the SDK's first pass sends (the self-check runs on its own copy)`, async () => {
			const make = () =>
				request({
					tools: [{ googleSearch: {} }],
					responseMimeType: "application/json",
					responseSchema: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
					},
				});
			const r = await nativeThenGoverned("generateContent", same(make), { vertex });
			expectSameSend(r);
			expect(r.raw.requests).toHaveLength(1);
			expect(JSON.stringify(r.raw.requests[0]?.body)).toContain("$schema");
		});
	}
});

describe("the AFC decision is the SDK's own, on both methods", () => {
	const afcCases: Array<[string, () => { config: object; tools: ReturnType<typeof callable>[] }]> =
		[
			[
				"a callable tool, AFC on",
				() => {
					const c = callable();
					return { config: { tools: [c.tool] }, tools: [c] };
				},
			],
			[
				"a callable tool, disable: true",
				() => {
					const c = callable();
					return {
						config: { tools: [c.tool], automaticFunctionCalling: { disable: true } },
						tools: [c],
					};
				},
			],
			[
				"a callable tool, maximumRemoteCalls 0",
				() => {
					const c = callable();
					return {
						config: { tools: [c.tool], automaticFunctionCalling: { maximumRemoteCalls: 0 } },
						tools: [c],
					};
				},
			],
			[
				"a callable tool, maximumRemoteCalls NaN",
				() => {
					const c = callable();
					return {
						config: {
							tools: [c.tool],
							automaticFunctionCalling: { maximumRemoteCalls: Number.NaN },
						},
						tools: [c],
					};
				},
			],
			["plain tools only", () => ({ config: { tools: [{ googleSearch: {} }] }, tools: [] })],
			[
				"two callable tools",
				() => {
					const a = callable("lookup");
					const b = callable("fetchPage");
					return { config: { tools: [a.tool, b.tool] }, tools: [a, b] };
				},
			],
		];

	for (const method of METHODS) {
		for (const [label, make] of afcCases) {
			it(`${method}, ${label}: governed follows the SDK's decision (a loop on the stream is refused; on generateContent each round is a governed call)`, async () => {
				const nat = make();
				const govern = make();
				const r = await nativeThenGoverned(
					method,
					{ native: () => request(nat.config), governed: () => request(govern.config) },
					{ rounds: LOOP },
				);
				const nativeLooped = nat.tools.some((t) => t.calls.callTool > 0);
				if (r.rawResult !== "ok") {
					// the SDK fails on its own: the same error governed, audited, nothing sent
					expect(r.govResult).toBe(r.rawResult);
					expect(r.raw.requests).toHaveLength(0);
					expect(r.gov.requests).toHaveLength(0);
					expect(r.auditKinds).toEqual(["policy_denied"]);
				} else if (!nativeLooped) {
					// no loop natively: one ordinary governed call, the same request(s)
					expectSameSend(r);
					expect(govern.tools.every((t) => t.calls.callTool === 0)).toBe(true);
				} else if (method === "generateContentStream") {
					expectAfcStreamRefused(r);
					expect(govern.tools.every((t) => t.calls.tool === 0 && t.calls.callTool === 0)).toBe(
						true,
					);
				} else {
					// the governed loop: the same rounds, each one metered
					expectSameSend(r);
					expect(r.auditKinds.filter((k) => k === "llm_call")).toHaveLength(r.gov.requests.length);
					expect(govern.tools.map((t) => t.calls.callTool)).toEqual(
						nat.tools.map((t) => t.calls.callTool),
					);
				}
			});
		}
	}

	it("the SDK's own outcomes, pinned (natively): AFC on and two callables loop; disable, maximumRemoteCalls 0 and plain tools send once; NaN fails on generateContent and sends nothing on the stream", async () => {
		const outcomes: Record<string, string> = {};
		for (const method of METHODS) {
			for (const [label, make] of afcCases) {
				const t = make();
				const w = wire(LOOP);
				globalThis.fetch = w.fetchStub as typeof fetch;
				const { result } = await runOn(sdkClient(false).models, method, request(t.config));
				const looped = t.tools.some((c) => c.calls.callTool > 0);
				outcomes[`${method}, ${label}`] =
					result !== "ok"
						? `throws: ${result}`
						: looped
							? "loops"
							: `${w.requests.length} request(s)`;
			}
		}
		const nanThrows =
			"throws: Cannot set properties of undefined (setting 'automaticFunctionCallingHistory')";
		expect(outcomes).toEqual({
			"generateContent, a callable tool, AFC on": "loops",
			"generateContent, a callable tool, disable: true": "1 request(s)",
			"generateContent, a callable tool, maximumRemoteCalls 0": "1 request(s)",
			"generateContent, a callable tool, maximumRemoteCalls NaN": nanThrows,
			"generateContent, plain tools only": "1 request(s)",
			"generateContent, two callable tools": "loops",
			"generateContentStream, a callable tool, AFC on": "loops",
			"generateContentStream, a callable tool, disable: true": "1 request(s)",
			"generateContentStream, a callable tool, maximumRemoteCalls 0": "1 request(s)",
			"generateContentStream, a callable tool, maximumRemoteCalls NaN": "0 request(s)",
			"generateContentStream, plain tools only": "1 request(s)",
			"generateContentStream, two callable tools": "loops",
		});
	});

	it("generateContentStream: a tools[0] getter that APPENDS a callable tool is refused as an AFC stream, the getter run as natively", async () => {
		const reads = { native: 0, governed: 0 };
		const make = (side: "native" | "governed") => () => {
			const tools: unknown[] = [];
			let appended = false;
			Object.defineProperty(tools, "0", {
				enumerable: true,
				configurable: true,
				get() {
					reads[side]++;
					if (!appended) {
						appended = true;
						tools.push(callable().tool);
					}
					return { googleSearch: {} };
				},
			});
			return request({ tools });
		};
		const r = await nativeThenGoverned(
			"generateContentStream",
			{ native: make("native"), governed: make("governed") },
			{ rounds: LOOP },
		);
		expect(r.raw.requests.length).toBeGreaterThan(1); // natively the SDK loops on the appended callable
		expectAfcStreamRefused(r);
		expect(reads.governed).toBe(reads.native);
	});
});

describe('pii "redact" with a HIDDEN automaticFunctionCalling { disable: true } beside a callable tool: the SDK never loops unmetered', () => {
	const hidden: Array<[string, () => Loose]> = [
		[
			"an INHERITED automaticFunctionCalling",
			() => {
				class Cfg {
					get automaticFunctionCalling(): Loose {
						return { disable: true };
					}
				}
				return new Cfg() as unknown as Loose;
			},
		],
		[
			"a NON-ENUMERABLE own automaticFunctionCalling",
			() =>
				Object.defineProperty({}, "automaticFunctionCalling", {
					value: { disable: true },
					enumerable: false,
				}) as Loose,
		],
	];

	for (const method of METHODS) {
		for (const [shape, base] of hidden) {
			it(`${method}, ${shape}: exactly the native request count, callTool never called, every request metered`, async () => {
				const nat = callable();
				const govern = callable();
				const make = (c: ReturnType<typeof callable>) => () =>
					request(Object.assign(base(), { tools: [c.tool] }), EMAIL);
				const r = await nativeThenGoverned(
					method,
					{ native: make(nat), governed: make(govern) },
					{ pii: "redact", rounds: LOOP },
				);
				expect(r.rawResult).toBe("ok");
				expect(r.govResult).toBe("ok");
				expect(r.raw.requests).toHaveLength(1);
				expect(r.gov.requests).toHaveLength(r.raw.requests.length);
				expect(nat.calls.callTool).toBe(0);
				expect(govern.calls.callTool).toBe(0);
				expect(r.auditKinds.filter((k) => k === "llm_call")).toHaveLength(r.gov.requests.length);
				expect(JSON.stringify(r.gov.requests)).not.toContain(EMAIL);
				expect(r.gov.requests.map((q) => q.body)).toEqual(redactedNative(r));
			});
		}
	}
});

describe("built-ins with internal slots read through as natively (guards)", () => {
	const shapes: Array<[string, () => unknown]> = [
		[
			"a Date in config.labels",
			() => request({ labels: { when: new Date(0) } as unknown as Loose }),
		],
		[
			"a Uint8Array as inlineData.data",
			() =>
				request({}, [
					{
						role: "user",
						parts: [{ inlineData: { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) } }],
					},
				]),
		],
		[
			"a Buffer as inlineData.data",
			() =>
				request({}, [
					{
						role: "user",
						parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from([1, 2, 3]) } }],
					},
				]),
		],
		[
			"a URL as fileData.fileUri",
			() =>
				request({}, [
					{
						role: "user",
						parts: [
							{
								fileData: { mimeType: "text/plain", fileUri: new URL("https://example.com/a.txt") },
							},
						],
					},
				]),
		],
	];
	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			for (const [shape, make] of shapes) {
				it(`${method} on ${backend}, ${shape}: governed == native`, async () => {
					const r = await nativeThenGoverned(method, same(make), { vertex });
					expectSameSend(r);
				});
			}
		}
	}
});

describe("an AbortSignal travels to the transport, and aborting it aborts the governed call", () => {
	/** A fetch that waits for its signal: the call ends only when the caller aborts. */
	async function abortedRun(
		models: unknown,
		method: Method,
		make: (signal: AbortSignal) => unknown = (signal) => request({ abortSignal: signal }),
	) {
		const controller = new AbortController();
		let calls = 0;
		let called: () => void = () => {};
		const firstCall = new Promise<void>((resolve) => {
			called = resolve;
		});
		globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
			calls++;
			called();
			const signal = init?.signal;
			if (signal === undefined) throw new Error("no signal reached fetch");
			return await new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted by the caller")));
			});
		}) as typeof fetch;
		const run = runOn(models, method, make(controller.signal));
		await firstCall;
		controller.abort();
		return { ...(await run), calls };
	}

	for (const method of METHODS) {
		it(`${method}: the native and the governed call both end on the caller's abort, after one request`, async () => {
			const native = await abortedRun(sdkClient(false).models, method);
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: recordingAudit(),
			});
			const gov = await abortedRun(governed.models, method);
			await governed.destroy();
			expect(native.calls).toBe(1);
			expect(gov.calls).toBe(1);
			expect(native.result).not.toBe("ok");
			expect(gov.result).toBe(native.result);
		});

		/** The signal is also a value inside the request: a function response carrying it. */
		const aliased = (signal: AbortSignal) =>
			request({ abortSignal: signal }, [
				{ role: "user", parts: [{ text: "go" }] },
				{ role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
				{ role: "user", parts: [{ functionResponse: { name: "f", response: { sig: signal } } }] },
			]);

		it(`${method}: the same signal also inside a function response: governed == native (it serializes there as JSON does)`, async () => {
			const r = await nativeThenGoverned(method, {
				native: () => aliased(new AbortController().signal),
				governed: () => aliased(new AbortController().signal),
			});
			expect(r.rawResult).toBe("ok");
			expectSameSend(r);
		});

		it(`${method}: the same signal also inside a function response: aborting it still aborts the governed call, as natively`, async () => {
			const native = await abortedRun(sdkClient(false).models, method, aliased);
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: recordingAudit(),
			});
			const gov = await abortedRun(governed.models, method, aliased);
			await governed.destroy();
			expect(native.calls).toBe(1);
			expect(gov.calls).toBe(1);
			expect(native.result).not.toBe("ok");
			expect(gov.result).toBe(native.result);
		});
	}
});

describe("a Google-shaped client that is not the SDK runs requests through the installed SDK's pipeline", () => {
	function fakeClient() {
		const received: unknown[] = [];
		const response = {
			candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
			text: "hi",
		};
		const client = {
			models: {
				generateContent: vi.fn(async (params: unknown) => {
					received.push(params);
					return response;
				}),
				generateContentStream: vi.fn(async (params: unknown) => {
					received.push(params);
					return (async function* () {
						yield response;
					})();
				}),
			},
		};
		return { client, received };
	}

	async function governedFake() {
		const fake = fakeClient();
		const governed = await trust(fake.client, {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: recordingAudit(),
		});
		return { ...fake, governed };
	}

	for (const method of METHODS) {
		it(`${method}: a plain request is forwarded as equal plain data`, async () => {
			const { governed, received } = await governedFake();
			const params = request({ temperature: 0.5, systemInstruction: "be brief" });
			expect((await runOn(governed.models, method, params)).result).toBe("ok");
			await governed.destroy();
			expect(received).toHaveLength(1);
			// the single-call forward owns automaticFunctionCalling, with disable: true (never on the wire)
			expect(received[0]).toEqual({
				...params,
				config: { ...params.config, automaticFunctionCalling: { disable: true } },
			});
			expect(received[0]).not.toBe(params);
		});

		it(`${method}: the pipeline decides what is read (an INHERITED systemInstruction beside tools is not forwarded, as the SDK copies config)`, async () => {
			const { governed, received } = await governedFake();
			class Cfg {
				get systemInstruction(): string {
					return `reply to ${EMAIL}`;
				}
			}
			const params = request(Object.assign(new Cfg(), { tools: [{ googleSearch: {} }] }));
			expect((await runOn(governed.models, method, params)).result).toBe("ok");
			await governed.destroy();
			expect(received).toHaveLength(1);
			const config = (received[0] as { config: Loose }).config;
			expect(config["systemInstruction"]).toBeUndefined();
			expect(JSON.stringify(received)).not.toContain(EMAIL);
		});

		it(`${method}: the caller's AbortSignal is forwarded by reference`, async () => {
			const { governed, received } = await governedFake();
			const signal = new AbortController().signal;
			expect((await runOn(governed.models, method, request({ abortSignal: signal }))).result).toBe(
				"ok",
			);
			await governed.destroy();
			expect((received[0] as { config: { abortSignal: unknown } }).config.abortSignal).toBe(signal);
		});

		it(`${method}: a client whose models has its own constructor: that constructor is never run, and the installed SDK's pipeline decides what is read`, async () => {
			const fake = fakeClient();
			const constructed = { n: 0 };
			// a foreign Models class: running it as the pipeline would hand the request to code that is not the SDK
			class ForeignModels {
				constructor() {
					constructed.n++;
				}
			}
			Object.setPrototypeOf(fake.client.models, ForeignModels.prototype);
			const governed = await trust(fake.client, {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: recordingAudit(),
			});
			class Cfg {
				get systemInstruction(): string {
					return `reply to ${EMAIL}`;
				}
			}
			const params = request(Object.assign(new Cfg(), { tools: [{ googleSearch: {} }] }));
			expect((await runOn(governed.models, method, params)).result).toBe("ok");
			await governed.destroy();
			expect(constructed.n).toBe(0);
			// the installed SDK copies config beside tools, so the inherited field is not forwarded
			expect(fake.received).toHaveLength(1);
			expect((fake.received[0] as { config: Loose }).config["systemInstruction"]).toBeUndefined();
		});
	}
});

describe("a local SDK error is the SDK's own, audited as a refusal, with nothing sent", () => {
	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: empty contents: the SDK's own "contents are required", no request`, async () => {
				const r = await nativeThenGoverned(
					method,
					same(() => request({}, [])),
					{ vertex },
				);
				expectSdkError(r);
			});

			it(`${on}: a callable tool beside a data tool's functionDeclarations (incompatible tools): the SDK's own error, no request`, async () => {
				const make = () =>
					request({
						tools: [callable().tool, { functionDeclarations: [{ name: "other" }] }],
					});
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSdkError(r);
			});
		}
	}

	for (const method of METHODS) {
		it(`${method}: a config getter that throws: the caller's error object is rethrown as it is, and its text is in no audit event`, async () => {
			const TEXT = "CONFIDENTIAL-PROMPT-TEXT the merger closes friday";
			class SecretError extends Error {}
			const thrown: unknown[] = [];
			const make = () =>
				request({
					get systemInstruction(): string {
						const error = new SecretError(TEXT);
						thrown.push(error);
						throw error;
					},
				});
			const r = await nativeThenGoverned(method, same(make));
			expect(r.rawResult).toBe(TEXT);
			expect(r.govResult).toBe(TEXT);
			expect(r.govError).toBe(thrown.at(-1));
			expect(r.auditKinds).toEqual(["policy_denied"]);
			expect(JSON.stringify(r.events)).not.toContain("CONFIDENTIAL");
			expect(String((r.events[0]?.data as Loose | undefined)?.["error"])).toContain(
				"rejected by the SDK before any request (SecretError)",
			);
			expect(r.gov.requests).toHaveLength(0);
		});

		it(`${method}: a config getter that throws a string or a Proxy: rethrown as it is, audited as its class only, and its traps run as natively (none of ours)`, async () => {
			const TEXT = "CONFIDENTIAL-PROMPT-TEXT";
			/** An Error behind a Proxy whose every trap counts. */
			const proxied = (traps: { n: number }) => {
				const count =
					<A extends unknown[], R>(f: (...a: A) => R) =>
					(...a: A): R => {
						traps.n++;
						return f(...a);
					};
				return new Proxy(new Error(TEXT), {
					get: count(Reflect.get),
					has: count(Reflect.has),
					getPrototypeOf: count(Reflect.getPrototypeOf),
					getOwnPropertyDescriptor: count(Reflect.getOwnPropertyDescriptor),
					defineProperty: count(Reflect.defineProperty),
					ownKeys: count(Reflect.ownKeys),
				});
			};
			const throwing = (value: unknown) =>
				request({
					get systemInstruction(): string {
						throw value;
					},
				});
			const call = async (models: unknown, value: unknown): Promise<unknown> => {
				try {
					await (models as Record<Method, (p: unknown) => Promise<unknown>>)[method](
						throwing(value),
					);
				} catch (error) {
					return error;
				}
				return undefined;
			};
			const nativeTraps = { n: 0 };
			const governedTraps = { n: 0 };
			const nativeProxy = proxied(nativeTraps);
			expect(await call(sdkClient(false).models, TEXT)).toBe(TEXT);
			expect(await call(sdkClient(false).models, nativeProxy)).toBe(nativeProxy);
			for (const value of [TEXT, proxied(governedTraps)]) {
				const audit = recordingAudit();
				const governed = await trust(sdkClient(false), {
					dryRun: true,
					budget: 500_000,
					vaultBase: vault,
					_audit: audit,
				});
				expect(await call(governed.models, value)).toBe(value);
				await governed.destroy();
				expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
				expect(JSON.stringify(audit.events)).not.toContain("CONFIDENTIAL");
			}
			expect(governedTraps.n).toBe(nativeTraps.n);
		});
	}

	it("generateContent: a getter that throws only on the SDK's SECOND round fails after the first request natively; governed refuses before any request, and the probe name surfaces nowhere", async () => {
		// how often one round reads the getter, natively
		const perRound = { n: 0 };
		const counting = () =>
			request({
				tools: [callable().tool],
				toolConfig: {
					get functionCallingConfig() {
						perRound.n++;
						return { mode: "AUTO" };
					},
				},
			});
		const w = wire([{ text: "done" }]);
		globalThis.fetch = w.fetchStub as typeof fetch;
		expect((await runOn(sdkClient(false).models, "generateContent", counting())).result).toBe("ok");
		expect(w.requests).toHaveLength(1);
		const limit = perRound.n;
		expect(limit).toBeGreaterThan(0);

		const make = () => {
			let reads = 0;
			return request({
				tools: [callable().tool],
				toolConfig: {
					get functionCallingConfig() {
						reads++;
						if (reads > limit) throw new Error("functionCallingConfig is gone");
						return { mode: "AUTO" };
					},
				},
			});
		};
		const r = await nativeThenGoverned("generateContent", same(make), { rounds: LOOP });
		expect(r.rawResult).toBe("functionCallingConfig is gone");
		expect(r.raw.requests).toHaveLength(1);
		expect(r.govResult).toContain("could not be checked for automatic function calling");
		expect(r.auditKinds).toEqual(["policy_denied"]);
		expect(r.gov.requests).toHaveLength(0);
	});
});

describe("serialization hooks run as natively, and their output is what is checked and sent", () => {
	/** An array or object with a NON-ENUMERABLE own toJSON, counted. */
	function hooked<T extends object>(own: T, out: unknown, runs: { n: number }): T {
		return Object.defineProperty(own, "toJSON", {
			value: () => {
				runs.n++;
				return out;
			},
			enumerable: false,
		});
	}

	const places: Array<[string, (runs: { n: number }, out: string) => unknown]> = [
		[
			"functionCallingConfig.allowedFunctionNames",
			(runs, out) =>
				request(
					{
						tools: [{ functionDeclarations: [{ name: "lookup" }, { name: out }] }],
						toolConfig: {
							functionCallingConfig: {
								mode: "ANY",
								allowedFunctionNames: hooked(["lookup"], [out], runs),
							},
						},
					},
					EMAIL,
				),
		],
		[
			"toolConfig.retrievalConfig",
			(runs, out) =>
				request(
					{
						tools: [{ googleSearch: {} }],
						toolConfig: {
							retrievalConfig: hooked({ languageCode: "en" }, { languageCode: out }, runs),
						},
					},
					EMAIL,
				),
		],
		[
			"a content part",
			(runs, out) =>
				request({}, [{ role: "user", parts: [hooked({ text: EMAIL }, { text: out }, runs)] }]),
		],
	];

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			for (const [place, make] of places) {
				for (const [label, out] of [
					["clean hook output", "fromHook"],
					["hook output holding PII", EMAIL],
				] as const) {
					it(`${method} on ${backend}, pii "redact", a hidden toJSON on ${place} (${label}): governed == native after redaction, the hook run as often`, async () => {
						const runs = { native: { n: 0 }, governed: { n: 0 } };
						const r = await nativeThenGoverned(
							method,
							{ native: () => make(runs.native, out), governed: () => make(runs.governed, out) },
							{ vertex, pii: "redact" },
						);
						expect(r.govResult).toBe(r.rawResult);
						expect(r.gov.requests.map((q) => q.body)).toEqual(redactedNative(r));
						expect(JSON.stringify(r.gov.requests)).not.toContain(EMAIL);
						expect(runs.governed.n).toBe(runs.native.n);
					});
				}
			}

			it(`${method} on ${backend}: a toJSON counter on functionCallingConfig runs exactly as often as natively (no extra run from the governor's serialization)`, async () => {
				const runs = { native: { n: 0 }, governed: { n: 0 } };
				const make = (r: { n: number }) => () =>
					request({
						tools: [{ functionDeclarations: [{ name: "lookup" }] }],
						toolConfig: { functionCallingConfig: hooked({ mode: "AUTO" }, { mode: "ANY" }, r) },
					});
				for (const pii of [undefined, "redact"] as const) {
					runs.native.n = 0;
					runs.governed.n = 0;
					const r = await nativeThenGoverned(
						method,
						{ native: make(runs.native), governed: make(runs.governed) },
						{ vertex, ...(pii !== undefined ? { pii } : {}) },
					);
					expectSameSend(r);
					// natively Vertex serializes functionCallingConfig as it is (the hook runs); Gemini copies its fields
					expect(runs.native.n > 0).toBe(vertex);
					expect(runs.governed.n).toBe(runs.native.n);
				}
			});
		}
	}
});

describe('an own "__proto__" key (as JSON.parse makes one) on a config beside tools', () => {
	const make = (systemInstruction: string) => () =>
		request(
			JSON.parse(
				JSON.stringify({ tools: [{ googleSearch: {} }] }).replace(
					"{",
					`{"__proto__":{"systemInstruction":${JSON.stringify(systemInstruction)}},`,
				),
			) as Loose,
			EMAIL,
		);

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			it(`${method} on ${backend}: governed == native (the SDK's copy inherits from it, as natively)`, async () => {
				const r = await nativeThenGoverned(method, same(make("be brief")), { vertex });
				expectSameSend(r);
				expect(JSON.stringify(r.raw.requests[0]?.body)).toContain("be brief");
			});

			it(`${method} on ${backend}, pii "redact": governed == native after redaction (the key survives redaction)`, async () => {
				const r = await nativeThenGoverned(method, same(make(EMAIL)), { vertex, pii: "redact" });
				expect(r.govResult).toBe(r.rawResult);
				expect(r.gov.requests.map((q) => q.body)).toEqual(redactedNative(r));
				expect(JSON.stringify(r.gov.requests)).toContain(REDACTED);
				expect(JSON.stringify(r.gov.requests)).not.toContain(EMAIL);
			});
		}
	}
});

describe("config.httpOptions is read at call start, as per-call request options are", () => {
	/** A data tool the SDK counts as MCP usage, so it re-reads config.httpOptions for its usage header. */
	const mcpTool = () => ({
		functionDeclarations: [{ name: "lookup" }],
		inputSchema: { type: "object" },
	});

	/** Refused at call start as an option off the governed list: audited, nothing sent. */
	function expectOptionRefused(r: Outcome, named: string): void {
		expect(r.govResult).toContain("request_option_refused");
		expect(r.govResult).toContain(named);
		expect(r.auditKinds).toEqual(["policy_denied"]);
		expect(r.gov.requests).toHaveLength(0);
	}

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: an ACCESSOR config.httpOptions holding only allowed keys is read when the SDK reads it, and sent as natively`, async () => {
				const reads = { native: 0, governed: 0 };
				const make = (side: keyof typeof reads) => () => {
					const config: Loose = { tools: [mcpTool()] };
					Object.defineProperty(config, "httpOptions", {
						enumerable: true,
						configurable: true,
						get: () => {
							reads[side]++;
							return { headers: { "x-test": "from a getter" } };
						},
					});
					return request(config);
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expectSameSend(r);
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["from a getter"]);
				expect(reads.governed).toBe(reads.native);
			});

			it(`${on}: a data config.httpOptions beside an MCP-usage tool: the same request and header as natively`, async () => {
				const make = () =>
					request({ tools: [mcpTool()], httpOptions: { headers: { "x-test": "same" } } });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["same"]);
			});

			it(`${on}: a NON-ENUMERABLE own config.httpOptions is checked: carrying extraBody it is refused`, async () => {
				const make = () =>
					request(
						Object.defineProperty({}, "httpOptions", {
							value: { extraBody: { labels: { a: "b" } } },
							enumerable: false,
						}),
					);
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectOptionRefused(r, "config.httpOptions.extraBody");
			});

			it(`${on}: a NON-ENUMERABLE own config.httpOptions holding only allowed keys sends its copy: governed == native`, async () => {
				const make = () =>
					request(
						Object.defineProperty({ temperature: 0.5 }, "httpOptions", {
							value: { headers: { "x-test": "hidden" } },
							enumerable: false,
						}),
					);
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["hidden"]);
			});

			it(`${on}: replacing the caller's httpOptions.headers after the call starts never reaches the wire (natively the SDK, reading later, sends the new one)`, async () => {
				const run = async (models: unknown, w: ReturnType<typeof wire>) => {
					globalThis.fetch = w.fetchStub as typeof fetch;
					const httpOptions: Loose = { headers: { "x-test": "early" } };
					const pending = runOn(models, method, request({ httpOptions }));
					httpOptions["headers"] = { "x-test": "late" };
					return pending;
				};
				const raw = wire();
				await run(sdkClient(vertex).models, raw);
				const gov = wire();
				const governed = await trust(sdkClient(vertex), {
					dryRun: true,
					budget: 500_000,
					vaultBase: vault,
					_audit: recordingAudit(),
				});
				expect((await run(governed.models, gov)).result).toBe("ok");
				await governed.destroy();
				expect(raw.requests.map((q) => q.testHeader)).toEqual(["late"]);
				expect(gov.requests.map((q) => q.testHeader)).toEqual(["early"]);
			});

			if (method === "generateContentStream") {
				it(`${on}: a NON-ENUMERABLE own $schema responseSchema beside tools, with httpOptions present, is still moved and sent as the SDK sends it, nothing of the request being copied on its way out: governed == native`, async () => {
					const make = () =>
						request(
							Object.defineProperty(
								{
									tools: [{ googleSearch: {} }],
									responseMimeType: "application/json",
									httpOptions: { headers: { "x-test": "h" } },
								},
								"responseSchema",
								{
									value: {
										$schema: "https://json-schema.org/draft/2020-12/schema",
										type: "object",
									},
									enumerable: false,
									writable: true,
									configurable: true,
								},
							),
						);
					const r = await nativeThenGoverned(method, same(make), { vertex });
					expectSameSend(r);
					expect(JSON.stringify(r.raw.requests[0]?.body)).toContain("$schema");
				});
			}
		}
	}
});

describe("the self-check's contract, on a pipeline that sends a header from a later read than its first", () => {
	/** A Models stand-in: it reads the header twice and sends the SECOND answer; the body never changes. */
	function twoReadModels(): GoogleModelsCtor {
		const send = (api: Loose, stream: boolean, params: Loose) => {
			const options = (params["config"] as Loose)["httpOptions"] as { headers: Loose };
			void options.headers["x-test"];
			const headers = { "x-test": options.headers["x-test"] };
			const request = {
				path: "models/m:generateContent",
				httpMethod: "POST",
				body: JSON.stringify({ contents: params["contents"] }),
				httpOptions: { headers },
			};
			return (api[stream ? "requestStream" : "request"] as (r: unknown) => Promise<unknown>)(
				request,
			);
		};
		return class {
			constructor(readonly api: Loose) {}
			generateContent = async (params: unknown) => send(this.api, false, params as Loose);
			generateContentStream = async (params: unknown) => {
				await send(this.api, true, params as Loose);
				return (async function* () {})();
			};
		} as unknown as GoogleModelsCtor;
	}

	const params = (header: (n: number) => string) => {
		let reads = 0;
		return {
			model: "m",
			contents: "go",
			config: {
				httpOptions: {
					headers: {
						get "x-test"() {
							reads++;
							return header(reads);
						},
					},
				},
			},
		};
	};

	for (const method of METHODS) {
		it(`${method}: a header that answers the same on both reads: ok, the mirror holds it`, async () => {
			const snap = await snapshotGoogleRequest(
				{ Models: twoReadModels(), vertexAI: false },
				method,
				params(() => "same"),
			);
			expect(snap.kind).toBe("ok");
		});

		it(`${method}: a header that answers differently on its second read, the body unchanged: refused (the self-check compares the request's options, not only its body)`, async () => {
			const snap = await snapshotGoogleRequest(
				{ Models: twoReadModels(), vertexAI: false },
				method,
				params((n) => `read-${n}`),
			);
			expect(snap).toEqual({
				kind: "refuse",
				reason: "the mirror of the request does not send what the SDK sends for it",
			});
		});
	}
});

describe("the SDK's writes land on the caller's objects as natively, and no wrapper of ours is left in them", () => {
	/** Every object reachable from `value` (own enumerable data), checked for a Proxy. */
	function holdsProxy(value: unknown, seen = new Set<object>()): boolean {
		if (value === null || typeof value !== "object") return false;
		if (utilTypes.isProxy(value)) return true;
		if (seen.has(value)) return false;
		seen.add(value);
		return Object.values(value).some((v) => holdsProxy(v, seen));
	}

	const shapes: Array<[string, () => Loose]> = [
		[
			"a declaration whose parameters hold $schema (the SDK moves them to parametersJsonSchema)",
			() =>
				request({
					tools: [
						{
							functionDeclarations: [
								{
									name: "lookup",
									parameters: {
										$schema: "https://json-schema.org/draft/2020-12/schema",
										type: "object",
										properties: { q: { type: "string" } },
									},
								},
							],
						},
					],
				}),
		],
		[
			"a declaration whose parameters the SDK rewrites in place",
			() =>
				request({
					tools: [
						{
							functionDeclarations: [
								{
									name: "lookup",
									parameters: { type: "object", properties: { q: { type: "string" } } },
								},
							],
						},
					],
				}),
		],
		[
			"an own $schema responseSchema beside tools (the stream moves it to responseJsonSchema)",
			() =>
				request({
					tools: [{ googleSearch: {} }],
					responseMimeType: "application/json",
					responseSchema: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						properties: { a: { type: "string" } },
					},
				}),
		],
	];

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			for (const [shape, make] of shapes) {
				it(`${method} on ${backend}, ${shape}: after the call the caller's request is as after the native call, with no Proxy in it`, async () => {
					const native = make();
					const governed = make();
					const r = await nativeThenGoverned(
						method,
						{ native: () => native, governed: () => governed },
						{ vertex },
					);
					expectSameSend(r);
					expect(holdsProxy(native)).toBe(false);
					expect(holdsProxy(governed)).toBe(false);
					expect(governed).toEqual(native);
				});
			}
		}
	}
});

describe("caller code reached from the request cannot change what is sent after the snapshot", () => {
	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: a header value that is an object (its toJSON and toString answer differently) is refused; natively the transport sends its toString`, async () => {
				const note = { toJSON: () => EMAIL, toString: () => "safe" };
				const make = () =>
					request({ httpOptions: { headers: { "x-test": note as unknown as string } } });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(r.raw.requests.map((q) => q.testHeader)).toEqual(["safe"]);
				expect(r.govResult).toContain("could not be checked for automatic function calling");
				expect(r.auditKinds).toEqual(["policy_denied"]);
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: a per-call httpOptions.extraBody is refused at call start (request_option_refused), nothing sent`, async () => {
				const make = () =>
					request({
						temperature: 0.5,
						httpOptions: { extraBody: { generationConfig: { candidateCount: 2 } } },
					});
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(r.raw.requests).toHaveLength(1); // natively it is merged and sent
				expect(r.govResult).toContain("request_option_refused");
				expect(r.govResult).toContain("config.httpOptions.extraBody");
				expect(r.auditKinds).toEqual(["policy_denied"]);
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: an own map method on contents' parts, which the SDK calls, is refused without ever running (its output could hand the SDK anything)`, async () => {
				const runs = { native: 0, governed: 0 };
				const make = (side: "native" | "governed") => () => {
					const parts: unknown[] = [{ text: "safe" }];
					Object.defineProperty(parts, "map", {
						value(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => unknown) {
							runs[side]++;
							return runs[side] >= 3 ? [{ text: EMAIL }] : Array.prototype.map.call(this, fn);
						},
						enumerable: false,
					});
					return request({}, [{ role: "user", parts }]);
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expect(r.rawResult).toBe("ok");
				expect(runs.native).toBeGreaterThan(0);
				expect(runs.governed).toBe(0);
				expect(r.govResult).toContain("could not be checked for automatic function calling");
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: parts in an Array subclass (its map inherited from Array.prototype) go through: governed == native (control)`, async () => {
				class Parts extends Array<unknown> {}
				const make = () => request({}, [{ role: "user", parts: Parts.from([{ text: "safe" }]) }]);
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
			});

			/** Counters per side, so a native run never counts as governance's. */
			const counts = () => ({
				native: { json: 0, ctor: 0 },
				governed: { json: 0, ctor: 0 },
			});
			/** An Array subclass whose prototype (`levels` up) holds a toJSON rewriting it to `rewrite`. */
			const protoToJSON = (c: { json: number }, rewrite: unknown[], levels = 1) => {
				class A extends Array<unknown> {}
				Object.defineProperty(A.prototype, "toJSON", {
					value() {
						c.json++;
						return rewrite;
					},
				});
				class B extends A {}
				return levels === 1 ? A : B;
			};

			for (const [shape, levels] of [
				["prototype", 1],
				["prototype two levels up", 2],
			] as const) {
				it(`${on}: parts in an Array subclass whose ${shape} holds a toJSON are refused (natively the SDK's map builds that class, and its hook rewrites what is sent), the hook never run`, async () => {
					const c = counts();
					const make = (side: "native" | "governed") => () => {
						const Parts = protoToJSON(c[side], [{ text: "[redacted]" }], levels);
						return request({}, [{ role: "user", parts: Parts.from([{ text: EMAIL }]) }]);
					};
					const r = await nativeThenGoverned(
						method,
						{ native: make("native"), governed: make("governed") },
						{ vertex },
					);
					expect(r.rawResult).toBe("ok");
					expect(JSON.stringify(r.raw.requests)).not.toContain(EMAIL); // the hook's rewrite is sent natively
					expect(r.govResult).toContain("could not be checked for automatic function calling");
					expect(r.gov.requests).toHaveLength(0);
					expect(c.governed.json).toBe(0);
				});
			}

			it(`${on}: functionDeclarations in an Array subclass whose prototype holds a toJSON are refused, the hook never run`, async () => {
				const c = counts();
				const make = (side: "native" | "governed") => () => {
					const Decls = protoToJSON(c[side], [{ name: "redacted" }]);
					return request({
						tools: [{ functionDeclarations: Decls.from([{ name: "lookup_secret" }]) }],
					});
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expect(r.rawResult).toBe("ok");
				expect(JSON.stringify(r.raw.requests)).not.toContain("lookup_secret");
				expect(r.govResult).toContain("could not be checked for automatic function calling");
				expect(r.gov.requests).toHaveLength(0);
				expect(c.governed.json).toBe(0);
			});

			for (const place of ["parts", "tools"] as const) {
				it(`${on}: ${place} in an Array subclass with a constructor of its own go through as a plain array: governed == native, its constructor never run by governance`, async () => {
					const c = counts();
					const make = (side: "native" | "governed") => () => {
						class Counted extends Array<unknown> {
							constructor(...items: unknown[]) {
								super(...(items as []));
								c[side].ctor++;
							}
						}
						const list =
							place === "parts"
								? Counted.from([{ text: "safe" }])
								: Counted.from([{ googleSearch: {} }]);
						c[side].ctor = 0;
						return place === "parts"
							? request({}, [{ role: "user", parts: list }])
							: request({ tools: list });
					};
					const r = await nativeThenGoverned(
						method,
						{ native: make("native"), governed: make("governed") },
						{ vertex },
					);
					expectSameSend(r);
					expect(c.native.ctor).toBeGreaterThan(0); // natively the SDK's map constructs it
					expect(c.governed.ctor).toBe(0);
				});
			}

			it(`${on}: parts holding a toJSON of their own (on the array, not its class) go as natively: governed == native, the hook never run`, async () => {
				const c = counts();
				const make = (side: "native" | "governed") => () => {
					const parts: unknown[] = [{ text: "go" }];
					Object.defineProperty(parts, "toJSON", {
						value() {
							c[side].json++;
							return [{ text: "[redacted]" }];
						},
					});
					return request({}, [{ role: "user", parts }]);
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expectSameSend(r);
				expect(c.native.json).toBe(0); // the SDK's map builds a new array, without it
				expect(c.governed.json).toBe(0);
			});

			it(`${on}: parts in an Array subclass naming its own Symbol.species are refused, its species never constructed (natively the SDK's map builds one)`, async () => {
				const built = { native: 0, governed: 0 };
				const make = (side: "native" | "governed") => () => {
					class Built extends Array<unknown> {
						constructor(...items: unknown[]) {
							super(...(items as []));
							built[side]++;
						}
					}
					class Parts extends Array<unknown> {}
					Object.defineProperty(Parts, Symbol.species, { get: () => Built });
					return request({}, [{ role: "user", parts: Parts.from([{ text: "safe" }]) }]);
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expect(r.rawResult).toBe("ok");
				expect(built.native).toBeGreaterThan(0);
				expect(built.governed).toBe(0);
				expect(r.govResult).toContain("could not be checked for automatic function calling");
				expect(r.gov.requests).toHaveLength(0);
			});

			/** One object as both config.tools[0] and config.automaticFunctionCalling; its tool() turns AFC back on. */
			const aliasing = (calls: { tool: number; callTool: number }) => () => {
				const shared: Loose = { disable: true };
				shared["tool"] = async function (this: Loose) {
					calls.tool++;
					this["disable"] = false;
					return { functionDeclarations: [{ name: "lookup" }] };
				};
				shared["callTool"] = async () => {
					calls.callTool++;
					return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
				};
				return request({ tools: [shared], automaticFunctionCalling: shared });
			};

			it(`${on}: the aliasing callable never gets an unmetered loop: refused, or exactly one metered request with the caller's callTool never run`, async () => {
				const nat = { tool: 0, callTool: 0 };
				const gov = { tool: 0, callTool: 0 };
				const r = await nativeThenGoverned(
					method,
					{ native: aliasing(nat), governed: aliasing(gov) },
					{ vertex, rounds: LOOP },
				);
				expect(r.raw.requests).toHaveLength(method === "generateContent" ? 2 : 1);
				if (r.govResult === "ok") {
					expect(r.gov.requests).toHaveLength(1);
					expect(r.auditKinds.filter((k) => k === "llm_call")).toHaveLength(1);
					expect(gov.callTool).toBe(0);
				} else {
					expect(r.gov.requests).toHaveLength(0);
					expect(r.auditKinds).toEqual(["policy_denied"]);
				}
			});

			it(`${on}: one object as both config.tools[0] (a callable whose tool() turns AFC back on) and config.automaticFunctionCalling { disable: true }: refused, never an unmetered loop`, async () => {
				const calls = { native: { tool: 0, callTool: 0 }, governed: { tool: 0, callTool: 0 } };
				const r = await nativeThenGoverned(
					method,
					{ native: aliasing(calls.native), governed: aliasing(calls.governed) },
					{ vertex, rounds: LOOP },
				);
				// natively generateContent runs tool() before its AFC check, so the SDK's own loop runs inside
				// the one call (two provider requests); the stream checks first and sends one
				expect(r.raw.requests).toHaveLength(method === "generateContent" ? 2 : 1);
				expect(r.govResult).toContain("could not be checked for automatic function calling");
				expect(r.auditKinds).toEqual(["policy_denied"]);
				expect(r.gov.requests).toHaveLength(0);
				expect(calls.governed).toEqual({ tool: 0, callTool: 0 });
			});
		}

		it(`${method}: a callable whose own toJSON calls this.tool(): a call refused by policy runs neither`, async () => {
			const calls = { tool: 0, toJSON: 0 };
			const tool = {
				async tool() {
					calls.tool++;
					return { functionDeclarations: [{ name: "lookup" }] };
				},
				async callTool() {
					return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
				},
				toJSON(this: { tool: () => Promise<unknown> }) {
					calls.toJSON++;
					void this.tool();
					return {};
				},
			};
			const r = await nativeThenGoverned(
				method,
				{ native: () => request({ tools: [] }), governed: () => request({ tools: [tool] }, EMAIL) },
				{ pii: "block", rounds: LOOP },
			);
			expect(r.govResult).not.toBe("ok");
			expect(r.gov.requests).toHaveLength(0);
			expect(calls).toEqual({ tool: 0, toJSON: 0 });
		});
	}

	it("generateContent: a callable whose own toJSON calls this.tool(): an authorized loop runs tool() as often as natively, and the governor never runs the toJSON", async () => {
		const counts = { native: { tool: 0, toJSON: 0 }, governed: { tool: 0, toJSON: 0 } };
		const make = (side: "native" | "governed") => () =>
			request({
				tools: [
					{
						async tool() {
							counts[side].tool++;
							return { functionDeclarations: [{ name: "lookup" }] };
						},
						async callTool() {
							return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
						},
						toJSON(this: { tool: () => Promise<unknown> }) {
							counts[side].toJSON++;
							void this.tool();
							return {};
						},
					},
				],
			});
		const r = await nativeThenGoverned(
			"generateContent",
			{ native: make("native"), governed: make("governed") },
			{ rounds: LOOP },
		);
		expectSameSend(r);
		expect(r.raw.requests).toHaveLength(2);
		expect(counts.governed).toEqual(counts.native);
		expect(counts.governed.toJSON).toBe(0);
	});
});

describe('pii "redact" with a clean prompt: a hidden config field and the same field enumerable are treated alike', () => {
	// The Google PII scan reads the prompt (`contents`) only, never `config` (LIMITATIONS.md, section 11):
	// with a clean prompt nothing is redacted, whether a field is enumerable, non-enumerable or inherited.
	const SYSTEM = `reply to ${EMAIL}`;
	const shapes: Array<[string, () => Loose]> = [
		["ENUMERABLE", () => ({ systemInstruction: SYSTEM })],
		[
			"NON-ENUMERABLE",
			() =>
				Object.defineProperty({}, "systemInstruction", {
					value: SYSTEM,
					enumerable: false,
				}) as Loose,
		],
		[
			"INHERITED",
			() => {
				class Cfg {
					get systemInstruction(): string {
						return SYSTEM;
					}
				}
				return new Cfg() as unknown as Loose;
			},
		],
	];
	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			for (const tools of [false, true]) {
				it(`${method} on ${backend}, ${tools ? "with" : "without"} tools: each shape is sent as the SDK sends it, none redacted`, async () => {
					const sent: unknown[] = [];
					for (const [, make] of shapes) {
						const config = () =>
							tools ? Object.assign(make(), { tools: [{ googleSearch: {} }] }) : make();
						const r = await nativeThenGoverned(
							method,
							same(() => request(config())),
							{
								vertex,
								pii: "redact",
							},
						);
						expectSameSend(r);
						expect(JSON.stringify(r.gov.requests)).not.toContain("[REDACTED");
						sent.push(r.gov.requests[0]?.body["systemInstruction"] !== undefined);
					}
					// natively: by name without tools; with tools, only the own enumerable field survives the SDK's copy
					expect(sent).toEqual(tools ? [true, false, false] : [true, true, true]);
				});
			}
		}
	}
});

describe("the dry run never hands the SDK a caller's object past the membrane, nor writes its own answers into the request", () => {
	for (const method of METHODS) {
		it(`${method}: config.tools with its own Symbol.iterator yielding the raw callable is refused, and neither tool() nor callTool() runs`, async () => {
			const nat = callable();
			const gov = callable();
			const make = (c: ReturnType<typeof callable>) => () => {
				const tools: unknown[] = [c.tool];
				Object.defineProperty(tools, Symbol.iterator, {
					value: function* () {
						yield c.tool;
					},
					enumerable: false,
				});
				return request({ tools });
			};
			const r = await nativeThenGoverned(
				method,
				{ native: make(nat), governed: make(gov) },
				{ rounds: LOOP },
			);
			expect(nat.calls.tool).toBeGreaterThan(0); // natively the SDK runs it
			expect(r.govResult).toContain("could not be checked for automatic function calling");
			expect(r.auditKinds).toEqual(["policy_denied"]);
			expect(r.gov.requests).toHaveLength(0);
			expect(gov.calls).toEqual({ tool: 0, callTool: 0 });
		});
	}

	it("generateContentStream with AFC on: refused, and the caller's contents are left exactly as they were (the dry run's scripted turns are never written into them)", async () => {
		const c = callable();
		const contents = [{ role: "user", parts: [{ text: "go" }] }];
		const before = JSON.stringify(contents);
		const params = request({ tools: [c.tool] }, contents);
		const r = await nativeThenGoverned(
			"generateContentStream",
			{ native: () => request({ tools: [callable().tool] }), governed: () => params },
			{ rounds: LOOP },
		);
		expect(r.govResult).toContain("with automatic function calling is not governed yet");
		expect(params.contents).toBe(contents);
		expect(JSON.stringify(params.contents)).toBe(before);
		expect(JSON.stringify(params)).not.toContain(PROBE);
	});
});

describe("a local SDK rejection carries the denial's audit handle", () => {
	const incompatible = () =>
		request({ tools: [callable().tool, { functionDeclarations: [{ name: "other" }] }] });

	for (const method of METHODS) {
		it(`${method}: the SDK's own error carries auditEventHash, the hash of its policy_denied event`, async () => {
			const r = await nativeThenGoverned(method, same(incompatible));
			expectSdkError(r);
			const err = r.govError as { auditEventHash?: string; auditDegraded?: boolean };
			expect(err.auditEventHash).toBe("1".padStart(64, "0"));
			expect(err.auditDegraded).toBeUndefined();
			expect(Object.getOwnPropertyDescriptor(err, "auditEventHash")?.enumerable).toBe(true);
		});

		it(`${method}: with the audit append failing, the SDK's own error carries auditDegraded`, async () => {
			const audit = recordingAudit();
			audit.appendEvent = async () => {
				throw new Error("audit disk full");
			};
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: audit,
			});
			const { error } = await runOn(governed.models, method, incompatible());
			await governed.destroy();
			vi.restoreAllMocks();
			expect((error as Error).message).toContain("Incompatible tools");
			expect((error as { auditDegraded?: boolean }).auditDegraded).toBe(true);
		});
	}
});

describe("values inside a function response serialize as natively", () => {
	/** A conversation ending in a function response carrying `response`. */
	const withResponse = (response: unknown) =>
		request({}, [
			{ role: "user", parts: [{ text: "go" }] },
			{ role: "model", parts: [{ functionCall: { name: "lookup", args: {} } }] },
			{ role: "user", parts: [{ functionResponse: { name: "lookup", response } }] },
		]);

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: boxed primitives (new Boolean(false), new String("hello"), new Number(3)) are sent unboxed, as natively`, async () => {
				const make = () =>
					withResponse({ b: new Boolean(false), s: new String("hello"), n: new Number(3) });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				expect(JSON.stringify(r.raw.requests[0]?.body)).toContain('"b":false,"s":"hello","n":3');
			});

			it(`${on}: a function-valued field with its own toJSON is sent as its hook's output, as natively`, async () => {
				const make = () => {
					const ready = Object.assign(() => "never sent", { toJSON: () => ({ status: "ready" }) });
					return withResponse({ state: ready });
				};
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				expect(JSON.stringify(r.raw.requests[0]?.body)).toContain('"state":{"status":"ready"}');
			});

			it(`${on}: a shared object whose toJSON getter answers a different hook on each read: governed == native, or refused, never an altered request`, async () => {
				const make = () => {
					let reads = 0;
					const shared = {};
					Object.defineProperty(shared, "toJSON", {
						get: () => {
							reads++;
							const n = reads;
							return () => n;
						},
					});
					return withResponse({ a: shared, b: shared });
				};
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(JSON.stringify(r.raw.requests[0]?.body)).toContain('"a":1,"b":2');
				if (r.govResult === "ok") {
					expectSameSend(r);
				} else {
					expect(r.govResult).toContain("could not be checked for automatic function calling");
					expect(r.gov.requests).toHaveLength(0);
				}
			});
		}
	}
});

describe("a large function response is snapshot in linear time", () => {
	it("a 30,000-key response takes about 4 times a 7,500-key one, not 16 (the ratio, so the machine's speed cancels)", async () => {
		const pipeline = await resolveGooglePipeline(sdkClient(false), false);
		if (pipeline === undefined) throw new Error("the installed SDK's pipeline did not resolve");
		const make = (n: number) => {
			const response: Record<string, string> = {};
			for (let i = 0; i < n; i++) response[`key_${i}`] = `value ${i}`;
			return request({}, [
				{ role: "user", parts: [{ text: "go" }] },
				{ role: "model", parts: [{ functionCall: { name: "lookup", args: {} } }] },
				{ role: "user", parts: [{ functionResponse: { name: "lookup", response } }] },
			]);
		};
		const median = async (n: number) => {
			const times: number[] = [];
			for (let i = 0; i < 5; i++) {
				const params = make(n);
				const start = performance.now();
				expect((await snapshotGoogleRequest(pipeline, "generateContent", params)).kind).toBe("ok");
				times.push(performance.now() - start);
			}
			return times.sort((x, y) => x - y)[2] as number;
		};
		await median(2_000); // warm-up
		const small = await median(7_500);
		const large = await median(30_000);
		// linear: about 4 (measured 4.2 to 4.7); quadratic membership checks: about 13 to 16
		expect(large / small).toBeLessThan(8);
	});
});

describe("params.config.httpOptions is pinned at call start for its PATH, whichever config a later read finds", () => {
	const SECRET = "ssn 123-45-6789";
	const late = () => ({ extraBody: { systemInstruction: { parts: [{ text: SECRET }] } } });

	/** One governed call whose request the caller changes right after the call starts. */
	async function lateChange(
		method: Method,
		start: () => Loose,
		change: (params: Loose) => void,
	): Promise<{ n: number; leaked: boolean; result: string }> {
		const w = wire();
		globalThis.fetch = w.fetchStub as typeof fetch;
		const governed = await trust(sdkClient(false), {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: recordingAudit(),
		});
		const params = start();
		const pending = runOn(governed.models, method, params);
		change(params);
		const { result } = await pending;
		await governed.destroy();
		const bodies = w.requests.map((q) => JSON.stringify(q.body));
		return { n: bodies.length, leaked: bodies.some((b) => b.includes(SECRET)), result };
	}

	for (const method of METHODS) {
		it(`${method}: config present without httpOptions at call start, httpOptions with extraBody added late: never sent`, async () => {
			const r = await lateChange(
				method,
				() => request({}),
				(p) => {
					(p["config"] as Loose)["httpOptions"] = late();
				},
			);
			expect(r).toEqual({ n: 1, leaked: false, result: "ok" });
		});

		it(`${method}: no config at call start, a config carrying extraBody added late: never sent`, async () => {
			const r = await lateChange(
				method,
				() => ({ model: "gemini-2.5-flash", contents: "go" }),
				(p) => {
					p["config"] = { httpOptions: late() };
				},
			);
			expect(r).toEqual({ n: 1, leaked: false, result: "ok" });
		});

		it(`${method}: httpOptions present at call start, params.config REPLACED late by one carrying extraBody: never sent`, async () => {
			const r = await lateChange(
				method,
				() => request({ httpOptions: { timeout: 5000 } }),
				(p) => {
					p["config"] = { httpOptions: late() };
				},
			);
			expect(r).toEqual({ n: 1, leaked: false, result: "ok" });
		});

		it(`${method}: a config replaced late by a Proxy: its traps never run for httpOptions, and nothing of it is sent`, async () => {
			const trapped = { httpOptions: 0 };
			const r = await lateChange(
				method,
				() => request({}),
				(p) => {
					const target: Loose = { httpOptions: late() };
					const count = (key: string | symbol) => {
						if (key === "httpOptions") trapped.httpOptions++;
					};
					p["config"] = new Proxy(target, {
						get: (t, key, receiver) => {
							count(key);
							return Reflect.get(t, key, receiver);
						},
						has: (t, key) => {
							count(key);
							return Reflect.has(t, key);
						},
						getOwnPropertyDescriptor: (t, key) => {
							count(key);
							return Reflect.getOwnPropertyDescriptor(t, key);
						},
					});
				},
			);
			expect(r).toEqual({ n: 1, leaked: false, result: "ok" });
			expect(trapped.httpOptions).toBe(0);
		});

		it(`${method}: a config replaced late by one whose httpOptions is an accessor: the getter never runs, nothing of it is sent`, async () => {
			const getter = vi.fn(late);
			const r = await lateChange(
				method,
				() => request({}),
				(p) => {
					p["config"] = Object.defineProperty({}, "httpOptions", { get: getter, enumerable: true });
				},
			);
			expect(r).toEqual({ n: 1, leaked: false, result: "ok" });
			expect(getter).not.toHaveBeenCalled();
		});

		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: httpOptions with an allowed key and an unlisted one is refused (request_option_refused), nothing sent`, async () => {
				const make = () =>
					request({ httpOptions: { headers: { "x-test": "h" }, notAnOption: true } });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(r.govResult).toContain("request_option_refused");
				expect(r.govResult).toContain("config.httpOptions.notAnOption");
				expect(r.auditKinds).toEqual(["policy_denied"]);
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: httpOptions with allowed keys only (headers, timeout, apiVersion): the wire's url and headers are what the governed copy gives, as natively`, async () => {
				const make = () =>
					request({
						httpOptions: { headers: { "x-test": "h" }, timeout: 5000, apiVersion: "v1alpha" },
					});
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				const seen = (q: {
					url: string;
					testHeader: string | null;
					timeoutHeader: string | null;
				}) => [new URL(q.url).pathname.split("/")[1], q.testHeader, q.timeoutHeader];
				expect(r.gov.requests.map(seen)).toEqual([["v1alpha", "h", "5"]]);
				expect(r.gov.requests.map(seen)).toEqual(r.raw.requests.map(seen));
			});
		}

		it(`${method}: a PLAIN field changed after the call starts (systemInstruction) is sent as the SDK reads it, natively and governed alike`, async () => {
			const run = async (models: unknown) => {
				const w = wire();
				globalThis.fetch = w.fetchStub as typeof fetch;
				const config: Loose = {};
				const pending = runOn(models, method, request(config));
				config["systemInstruction"] = "answer in French";
				await pending;
				return w.requests.map((q) => q.body);
			};
			const native = await run(sdkClient(false).models);
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: recordingAudit(),
			});
			const sent = await run(governed.models);
			await governed.destroy();
			expect(JSON.stringify(native)).toContain("answer in French");
			expect(sent).toEqual(native);
		});

		it(`${method}, pii "redact": contents replaced after the call starts are what is scanned and sent (redacted), as the SDK reads them`, async () => {
			const run = async (models: unknown) => {
				const w = wire();
				globalThis.fetch = w.fetchStub as typeof fetch;
				const params: Loose = request({});
				const pending = runOn(models, method, params);
				params["contents"] = EMAIL;
				await pending;
				return JSON.stringify(w.requests.map((q) => q.body));
			};
			const native = await run(sdkClient(false).models);
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: recordingAudit(),
				pii: "redact",
			});
			const sent = await run(governed.models);
			await governed.destroy();
			expect(native).toContain(EMAIL); // natively the late contents are sent
			expect(sent).toContain(REDACTED); // governed: the scan saw them, and they went redacted
			expect(sent).not.toContain(EMAIL);
		});
	}
});

describe("the hold is sized from the request that is sent", () => {
	/** An engine recording each hold and each post (and any shortfall it reports). */
	function recordingEngine() {
		const held: number[] = [];
		const posted: number[] = [];
		const engine = {
			spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
				held.push(p.amount);
				return { transferId: p.transferId };
			}),
			postPendingSpend: vi.fn(async (_id: string, amount?: number) => {
				posted.push(amount ?? Number.NaN);
			}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};
		return { engine, held, posted };
	}

	it("generateContent: contents that grow to ~100,000 tokens just after the call starts are what is held for, since they are what is sent", async () => {
		const { engine, held, posted } = recordingEngine();
		const w = wire([{ text: "done" }], {
			promptTokenCount: 100_000,
			candidatesTokenCount: 10,
			totalTokenCount: 100_010,
		});
		globalThis.fetch = w.fetchStub as typeof fetch;
		const governed = await trust(sdkClient(false), {
			dryRun: false,
			budget: 50_000_000,
			vaultBase: vault,
			_engine: engine,
			_audit: recordingAudit(),
		});
		const long = "lorem ipsum dolor sit amet ".repeat(15_000); // ~405,000 characters
		const params: Loose = request({}, "short");
		const pending = runOn(governed.models, "generateContent", params);
		params["contents"] = long; // read by the SDK after its first await: this is what is sent
		const { result } = await pending;
		await governed.destroy();
		expect(result).toBe("ok");
		expect(JSON.stringify(w.requests[0]?.body)).toContain(long);
		expect(held).toHaveLength(1);
		expect(posted).toHaveLength(1);
		expect(held[0]).toBeGreaterThanOrEqual(posted[0] as number);
	});

	it("generateContent: the same, with a field beside model, contents and config: still held for what is sent, and the body is the native one (the field is never sent)", async () => {
		const long = "lorem ipsum dolor sit amet ".repeat(15_000);
		const usage = { promptTokenCount: 100_000, candidatesTokenCount: 10, totalTokenCount: 100_010 };
		const late = async (models: unknown, w: ReturnType<typeof wire>) => {
			globalThis.fetch = w.fetchStub as typeof fetch;
			const params: Loose = { ...request({}, "short"), metadata: { classification: "internal" } };
			const pending = runOn(models, "generateContent", params);
			params["contents"] = long;
			return (await pending).result;
		};
		const raw = wire([{ text: "done" }], usage);
		expect(await late(sdkClient(false).models, raw)).toBe("ok");
		const { engine, held, posted } = recordingEngine();
		const governed = await trust(sdkClient(false), {
			dryRun: false,
			budget: 50_000_000,
			vaultBase: vault,
			_engine: engine,
			_audit: recordingAudit(),
		});
		const gov = wire([{ text: "done" }], usage);
		expect(await late(governed.models, gov)).toBe("ok");
		await governed.destroy();
		expect(gov.requests.map((q) => q.body)).toEqual(raw.requests.map((q) => q.body));
		expect(JSON.stringify(gov.requests)).not.toContain("classification");
		expect(held).toHaveLength(1);
		expect(posted).toHaveLength(1);
		expect(held[0]).toBeGreaterThanOrEqual(posted[0] as number);
	});

	// REGRESSION GUARD, not evidence for the request pipeline: master's own hold estimate makes this
	// pass with or without it (it counts a Google prompt's contents). It stays to keep the Google path
	// on that estimate.
	it("REGRESSION GUARD: generateContent: a ~100,000-token prompt is held at or above what it costs", async () => {
		const held: number[] = [];
		const posted: number[] = [];
		const engine = {
			spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
				held.push(p.amount);
				return { transferId: p.transferId };
			}),
			postPendingSpend: vi.fn(async (_id: string, amount?: number) => {
				posted.push(amount ?? Number.NaN);
			}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};
		const w = wire([{ text: "done" }], {
			promptTokenCount: 100_000,
			candidatesTokenCount: 10,
			totalTokenCount: 100_010,
		});
		globalThis.fetch = w.fetchStub as typeof fetch;
		const audit = recordingAudit();
		const governed = await trust(sdkClient(false), {
			dryRun: false,
			budget: 50_000_000,
			vaultBase: vault,
			_engine: engine,
			_audit: audit,
		});
		const prompt = "lorem ipsum dolor sit amet ".repeat(15_000); // ~405,000 characters
		const { result } = await runOn(governed.models, "generateContent", request({}, prompt));
		await governed.destroy();
		expect(result).toBe("ok");
		expect(w.requests).toHaveLength(1);
		expect(held).toHaveLength(1);
		expect(posted).toHaveLength(1);
		// measured: held 559, settled 301 (gemini-2.5-flash rates)
		expect(held[0]).toBeGreaterThanOrEqual(posted[0] as number);
		expect(held[0]).toBeGreaterThanOrEqual(301);
		expect(posted[0]).toBe(301);
		expect(audit.events.map((e) => e.kind)).not.toContain("settlement_shortfall");
	});
});

describe("an inherited config.httpOptions is read at call start as the SDK finds it, through the prototype chain, and governed", () => {
	/** Refused at call start as a per-call option: audited, nothing sent. */
	function expectOptionRefused(r: Outcome, named: string): void {
		expect(r.govResult).toContain("request_option_refused");
		expect(r.govResult).toContain(named);
		expect(r.auditKinds).toEqual(["policy_denied"]);
		expect(r.gov.requests).toHaveLength(0);
	}

	/** A config whose prototype holds `proto`'s own properties (no tools: the SDK reads httpOptions by name). */
	const inheriting = (proto: object) => request(Object.create(proto) as Loose);

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: an INHERITED httpOptions holding only allowed keys is sent as natively (headers, timeout)`, async () => {
				const make = () =>
					inheriting({ httpOptions: { headers: { "x-test": "inherited" }, timeout: 7000 } });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				const seen = (q: { testHeader: string | null; timeoutHeader: string | null }) => [
					q.testHeader,
					q.timeoutHeader,
				];
				expect(r.raw.requests.map(seen)).toEqual([["inherited", "7"]]);
				expect(r.gov.requests.map(seen)).toEqual(r.raw.requests.map(seen));
			});

			it(`${on}: an INHERITED httpOptions carrying extraBody is refused at call start, before anything reads the request; nothing sent`, async () => {
				const reads = { native: 0, governed: 0 };
				const make = (side: keyof typeof reads) => () =>
					inheriting(
						Object.defineProperty(
							{ httpOptions: { extraBody: { labels: { a: "b" } } } },
							"systemInstruction",
							{
								get: () => {
									reads[side]++;
									return "be brief";
								},
							},
						),
					);
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expect(r.raw.requests).toHaveLength(1); // natively merged and sent
				expect(reads.native).toBeGreaterThan(0);
				expectOptionRefused(r, "config.httpOptions.extraBody");
				// refused at call start: the request's own getters never ran
				expect(reads.governed).toBe(0);
			});

			it(`${on}: an httpOptions ACCESSOR on the config's prototype holding only allowed keys is read when the SDK reads it, and sent as natively`, async () => {
				const reads = { native: 0, governed: 0 };
				const make = (side: keyof typeof reads) => () =>
					inheriting(
						Object.defineProperty({}, "httpOptions", {
							get: () => {
								reads[side]++;
								return { headers: { "x-test": "from a getter" } };
							},
						}),
					);
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expectSameSend(r);
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["from a getter"]);
				expect(reads.governed).toBe(reads.native);
			});

			it(`${on}: a Proxy on the config's prototype chain is refused, and none of its traps runs`, async () => {
				const traps = { n: 0 };
				const count = () => {
					traps.n++;
				};
				const proto = new Proxy(
					{ httpOptions: { headers: { "x-test": "behind a Proxy" } } },
					{
						get: (t, k, r) => {
							count();
							return Reflect.get(t, k, r);
						},
						has: (t, k) => {
							count();
							return Reflect.has(t, k);
						},
						getOwnPropertyDescriptor: (t, k) => {
							count();
							return Reflect.getOwnPropertyDescriptor(t, k);
						},
						getPrototypeOf: (t) => {
							count();
							return Reflect.getPrototypeOf(t);
						},
					},
				);
				const make = () => inheriting(proto);
				const r = await nativeThenGoverned(
					method,
					{ native: () => request({}), governed: make },
					{ vertex },
				);
				expectOptionRefused(r, "config.httpOptions (unreadable)");
				expect(traps.n).toBe(0);
			});

			it(`${on}: a config whose prototype chain is 65 objects deep is refused (past 64, it cannot be told), nothing sent`, async () => {
				const make = () => {
					let proto: object = {};
					for (let i = 0; i < 64; i++) proto = Object.create(proto) as object;
					return request(Object.create(proto) as Loose);
				};
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectOptionRefused(r, "config.httpOptions (unreadable)");
			});
		}
	}
});

describe("a config held by a getter is read by the SDK, as before; its httpOptions is governed on what is sent", () => {
	/** A request whose `config` is a getter answering `config` (the same object on every read). */
	const viaGetter = (config: Loose) =>
		Object.defineProperty({ model: "gemini-2.5-flash", contents: "go" }, "config", {
			get: () => config,
			enumerable: true,
		});

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: a getter config whose httpOptions carries extraBody is refused (the check on what the SDK read), nothing sent`, async () => {
				const make = () => viaGetter({ httpOptions: { extraBody: { labels: { a: "b" } } } });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(r.raw.requests).toHaveLength(1); // natively merged and sent
				expect(r.govResult).toContain("request_option_refused");
				expect(r.govResult).toContain("config.httpOptions.extraBody");
				expect(r.auditKinds).toEqual(["policy_denied"]);
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: a getter config whose httpOptions holds only allowed keys is sent as natively`, async () => {
				const make = () =>
					viaGetter({
						temperature: 0.5,
						httpOptions: { headers: { "x-test": "g" }, timeout: 5000 },
					});
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				expect(r.gov.requests.map((q) => [q.testHeader, q.timeoutHeader])).toEqual([["g", "5"]]);
			});

			it(`${on}: under a getter config, httpOptions is read when the SDK reads it: a header replaced after the call starts is sent, as natively`, async () => {
				const run = async (models: unknown, w: ReturnType<typeof wire>) => {
					globalThis.fetch = w.fetchStub as typeof fetch;
					const httpOptions: Loose = { headers: { "x-test": "early" } };
					const pending = runOn(models, method, viaGetter({ httpOptions }));
					httpOptions["headers"] = { "x-test": "late" };
					return pending;
				};
				const raw = wire();
				await run(sdkClient(vertex).models, raw);
				const gov = wire();
				const governed = await trust(sdkClient(vertex), {
					dryRun: true,
					budget: 500_000,
					vaultBase: vault,
					_audit: recordingAudit(),
				});
				expect((await run(governed.models, gov)).result).toBe("ok");
				await governed.destroy();
				expect(raw.requests.map((q) => q.testHeader)).toEqual(["late"]);
				expect(gov.requests.map((q) => q.testHeader)).toEqual(["late"]);
			});
		}
	}
});

describe("a getter config that answers a different httpOptions on its later reads: the send never reads it", () => {
	const SECRET = "ssn 123-45-6789";

	/** The getter answers `{ timeout }` on its first read and `later()` on every later one; its reads counted. */
	function flipping(tools: boolean, later: () => Loose) {
		const reads = { n: 0 };
		const params = Object.defineProperty({ model: "gemini-2.5-flash", contents: "go" }, "config", {
			get: () => {
				reads.n++;
				const httpOptions = reads.n === 1 ? { timeout: 5000 } : later();
				return tools ? { tools: [{ googleSearch: {} }], httpOptions } : { httpOptions };
			},
			enumerable: true,
		});
		return { params, reads };
	}

	/**
	 * The call natively, then governed on an engine that notes the getter's read count when the hold is
	 * placed: after the request gate, before the send. Reads past that count are the send's.
	 */
	async function run(method: Method, vertex: boolean, tools: boolean, later: () => Loose) {
		const native = flipping(tools, later);
		const raw = wire();
		globalThis.fetch = raw.fetchStub as typeof fetch;
		await runOn(sdkClient(vertex).models, method, native.params);

		const governed = flipping(tools, later);
		const atHold: number[] = [];
		const engine = {
			spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
				atHold.push(governed.reads.n);
				return { transferId: p.transferId };
			}),
			postPendingSpend: vi.fn(async () => {}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};
		const gov = wire();
		globalThis.fetch = gov.fetchStub as typeof fetch;
		const client = await trust(sdkClient(vertex), {
			dryRun: false,
			budget: 50_000_000,
			vaultBase: vault,
			_engine: engine,
			_audit: recordingAudit(),
		});
		const { result } = await runOn(client.models, method, governed.params);
		await client.destroy();
		return { raw, gov, result, native: native.reads.n, governed: governed.reads.n, atHold };
	}

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			for (const tools of [false, true]) {
				const on = `${method} on ${backend}, ${tools ? "with" : "without"} tools`;

				it(`${on}: a later answer carrying extraBody (SECRET): never on the wire; the copy holds what the SDK read and is refused before any hold`, async () => {
					const r = await run(method, vertex, tools, () => ({
						extraBody: { labels: { secret: SECRET } },
					}));
					expect(JSON.stringify(r.raw.requests)).toContain(SECRET); // natively it is sent
					// the SDK reads httpOptions from a later read of config: the copy holds that answer, and the
					// request-option check on the request that would be sent refuses it
					expect(r.result).toContain("request_option_refused");
					expect(r.result).toContain("config.httpOptions.extraBody");
					expect(r.gov.requests).toHaveLength(0);
					expect(r.atHold).toEqual([]);
					// every read is the dry run's (pass-through), which stops at the read the check refuses:
					// measured 6 of native's 7 without tools, 2 or 5 of native's 8 with
					expect(r.governed).toBeGreaterThan(0);
					expect(r.governed).toBeLessThan(r.native);
				});

				it(`${on}: a later answer holding only an allowed header: sent as natively, and the send makes no read of the caller's config`, async () => {
					const r = await run(method, vertex, tools, () => ({ headers: { "x-test": "later" } }));
					expect(r.result).toBe("ok");
					expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["later"]);
					expect(r.gov.requests.map((q) => q.testHeader)).toEqual(
						r.raw.requests.map((q) => q.testHeader),
					);
					expect(r.atHold).toEqual([r.governed]); // no read of the getter after the request gate
					expect(r.governed).toBe(r.native);
				});
			}
		}
	}
});

describe("an accessor config or httpOptions is read when the SDK reads it, and governed on what was read; an accessor key inside httpOptions is refused at call start", () => {
	const SECRET = "ssn 123-45-6789";
	const EXTRA = () => ({ extraBody: { labels: { secret: SECRET } } });

	/** Refused by the per-call option check on the request that would be sent: audited, nothing sent. */
	function expectRefusedOnWhatWasRead(r: Outcome): void {
		expect(JSON.stringify(r.raw.requests)).toContain(SECRET); // natively it is sent
		expect(r.govResult).toContain("request_option_refused");
		expect(r.govResult).toContain("config.httpOptions.extraBody");
		expect(r.auditKinds).toEqual(["policy_denied"]);
		expect(r.gov.requests).toHaveLength(0);
	}

	/** Each deferred accessor level, holding what `answer` gives. */
	const levels: Array<[string, (answer: () => Loose) => () => Loose]> = [
		[
			"a getter config.httpOptions (own)",
			(answer) => () =>
				request(
					Object.defineProperty({}, "httpOptions", { get: answer, enumerable: true }) as Loose,
				),
		],
		[
			"a getter config.httpOptions (inherited)",
			(answer) => () =>
				request(Object.create(Object.defineProperty({}, "httpOptions", { get: answer })) as Loose),
		],
	];

	/** A data httpOptions whose every key is a getter answering `value`'s, its runs counted. */
	function getterKeys(value: Loose, runs: { n: number }) {
		const options = {};
		for (const [key, v] of Object.entries(value)) {
			Object.defineProperty(options, key, {
				get: () => {
					runs.n++;
					return v;
				},
				enumerable: true,
			});
		}
		return request({ httpOptions: options });
	}

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;
			for (const [level, make] of levels) {
				it(`${on}, ${level} holding only allowed keys: sent as natively`, async () => {
					const r = await nativeThenGoverned(
						method,
						same(make(() => ({ headers: { "x-test": "via an accessor" } }))),
						{ vertex },
					);
					expectSameSend(r);
					expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["via an accessor"]);
				});

				it(`${on}, ${level} holding extraBody: refused on what the SDK read, nothing sent`, async () => {
					const r = await nativeThenGoverned(method, same(make(EXTRA)), { vertex });
					expectRefusedOnWhatWasRead(r);
				});
			}

			for (const [held, value, name] of [
				[
					"only an allowed key",
					{ headers: { "x-test": "via an accessor" } },
					"config.httpOptions.headers (an accessor)",
				],
				["extraBody", EXTRA(), "config.httpOptions.extraBody"],
			] as const) {
				it(`${on}, a getter key inside a data httpOptions holding ${held}: refused at call start, as on master, its getter never run, nothing sent`, async () => {
					const runs = { native: { n: 0 }, governed: { n: 0 } };
					const r = await nativeThenGoverned(
						method,
						{
							native: () => getterKeys(value, runs.native),
							governed: () => getterKeys(value, runs.governed),
						},
						{ vertex },
					);
					expect(r.rawResult).toBe("ok"); // natively it is sent
					expect(r.govResult).toContain("request_option_refused");
					expect(r.govResult).toContain(name);
					expect(r.auditKinds).toEqual(["policy_denied"]);
					expect(r.gov.requests).toHaveLength(0);
					expect(runs.governed.n).toBe(0);
				});
			}

			it(`${on}: a getter key inside a data httpOptions, made data just after the call starts: refused, as on the base, which checks it at call start`, async () => {
				const w = wire();
				globalThis.fetch = w.fetchStub as typeof fetch;
				const governed = await trust(sdkClient(vertex), {
					dryRun: true,
					budget: 500_000,
					vaultBase: vault,
					_audit: recordingAudit(),
				});
				const runs = { n: 0 };
				const options = Object.defineProperty({}, "headers", {
					get: () => {
						runs.n++;
						return { "x-test": "via an accessor" };
					},
					enumerable: true,
					configurable: true,
				});
				const pending = runOn(governed.models, method, request({ httpOptions: options }));
				Object.defineProperty(options, "headers", {
					value: { "x-test": "data" },
					enumerable: true,
				});
				const { result } = await pending;
				await governed.destroy();
				expect(result).toContain("request_option_refused");
				expect(result).toContain("(config.httpOptions.headers (an accessor))");
				expect(runs.n).toBe(0);
				expect(w.requests).toHaveLength(0);
			});

			it(`${on}: a Proxy as config.httpOptions on a data config is refused at call start, and none of its traps runs (get, has, getOwnPropertyDescriptor, getPrototypeOf, ownKeys)`, async () => {
				const traps = { n: 0 };
				const make = () =>
					request({
						httpOptions: new Proxy(
							{ headers: { "x-test": "behind a Proxy" } },
							{
								get: (t, k, r) => {
									traps.n++;
									return Reflect.get(t, k, r);
								},
								has: (t, k) => {
									traps.n++;
									return Reflect.has(t, k);
								},
								ownKeys: (t) => {
									traps.n++;
									return Reflect.ownKeys(t);
								},
								getOwnPropertyDescriptor: (t, k) => {
									traps.n++;
									return Reflect.getOwnPropertyDescriptor(t, k);
								},
								getPrototypeOf: (t) => {
									traps.n++;
									return Reflect.getPrototypeOf(t);
								},
							},
						),
					});
				const r = await nativeThenGoverned(
					method,
					{ native: () => request({}), governed: make },
					{ vertex },
				);
				expect(r.govResult).toContain("request_option_refused");
				expect(r.govResult).toContain("config.httpOptions (a Proxy)");
				expect(r.gov.requests).toHaveLength(0);
				expect(traps.n).toBe(0);
			});
		}
	}

	/** A data tool the SDK counts as MCP usage: it then re-reads config.httpOptions (three reads). */
	const mcpTool = () => ({
		functionDeclarations: [{ name: "lookup" }],
		inputSchema: { type: "object" },
	});

	/** A data config whose own httpOptions getter answers `{ timeout }` first and `later()` on every later read. */
	function flippingHttpOptions(mcp: boolean, later: () => Loose) {
		const reads = { n: 0 };
		const params = request(
			Object.defineProperty(mcp ? { tools: [mcpTool()] } : {}, "httpOptions", {
				get: () => {
					reads.n++;
					return reads.n === 1 ? { timeout: 5000 } : later();
				},
				enumerable: true,
			}) as Loose,
		);
		return { params, reads };
	}

	async function runFlip(method: Method, vertex: boolean, mcp: boolean, later: () => Loose) {
		const native = flippingHttpOptions(mcp, later);
		const raw = wire();
		globalThis.fetch = raw.fetchStub as typeof fetch;
		await runOn(sdkClient(vertex).models, method, native.params);
		const governed = flippingHttpOptions(mcp, later);
		const atHold: number[] = [];
		const engine = {
			spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
				atHold.push(governed.reads.n);
				return { transferId: p.transferId };
			}),
			postPendingSpend: vi.fn(async () => {}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};
		const gov = wire();
		globalThis.fetch = gov.fetchStub as typeof fetch;
		const client = await trust(sdkClient(vertex), {
			dryRun: false,
			budget: 50_000_000,
			vaultBase: vault,
			_engine: engine,
			_audit: recordingAudit(),
		});
		const { result } = await runOn(client.models, method, governed.params);
		await client.destroy();
		return { raw, gov, result, native: native.reads.n, governed: governed.reads.n, atHold };
	}

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: an httpOptions getter answering timeout first and extraBody (SECRET) later, no tools: the SDK reads it once, so both send the timeout only; SECRET nowhere`, async () => {
				const r = await runFlip(method, vertex, false, EXTRA);
				expect(JSON.stringify(r.raw.requests)).not.toContain(SECRET);
				expect(JSON.stringify(r.gov.requests)).not.toContain(SECRET);
				expect(r.gov.requests.map((q) => q.timeoutHeader)).toEqual(["5"]);
				expect(r.gov.requests.map((q) => q.timeoutHeader)).toEqual(
					r.raw.requests.map((q) => q.timeoutHeader),
				);
				expect(r.governed).toBe(r.native); // measured: 1
				expect(r.atHold).toEqual([r.governed]); // no read after the hold
			});

			it(`${on}: the same getter beside an MCP-usage tool (the SDK re-reads it): SECRET is sent natively, and governed it is refused on what was read, every read the dry run's`, async () => {
				const r = await runFlip(method, vertex, true, EXTRA);
				expect(JSON.stringify(r.raw.requests)).toContain(SECRET);
				expect(JSON.stringify(r.gov.requests)).not.toContain(SECRET);
				expect(r.result).toContain("request_option_refused");
				expect(r.result).toContain("config.httpOptions.extraBody");
				expect(r.gov.requests).toHaveLength(0);
				expect(r.atHold).toEqual([]);
				// the dry run stops at the read the check refuses: measured 2 of native's 3
				expect(r.governed).toBe(2);
				expect(r.native).toBe(3);
			});

			it(`${on}: the same getter beside an MCP-usage tool answering an allowed header later: sent as natively, no read of it after the hold`, async () => {
				const r = await runFlip(method, vertex, true, () => ({ headers: { "x-test": "later" } }));
				expect(r.result).toBe("ok");
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(
					r.raw.requests.map((q) => q.testHeader),
				);
				expect(r.atHold).toEqual([r.governed]);
				expect(r.governed).toBe(r.native);
			});
		}
	}
});

describe("a boxed primitive carrying the caller's own properties is governed as the caller's object", () => {
	/** A callable tool's two methods on a boxed Number: the SDK takes it for a callable tool, natively. */
	function boxedCallable() {
		const c = callable();
		return { calls: c.calls, tool: Object.assign(new Number(1), c.tool) };
	}

	for (const method of METHODS) {
		it(`${method}: a boxed Number carrying tool() and callTool(), with a budget of 1: neither runs before authorization, the call is refused, nothing is sent`, async () => {
			const w = wire(LOOP);
			globalThis.fetch = w.fetchStub as typeof fetch;
			const audit = recordingAudit();
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 1,
				vaultBase: vault,
				_audit: audit,
			});
			const boxed = boxedCallable();
			const out = await runOn(governed.models, method, request({ tools: [boxed.tool] }));
			await governed.destroy();
			expect(boxed.calls).toEqual({ tool: 0, callTool: 0 });
			expect(out.result).not.toBe("ok");
			expect(w.requests).toHaveLength(0);
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
		});
	}

	it("generateContent: with a budget, the same boxed callable loops as natively, each round governed: governed == native", async () => {
		const natives: Array<{ tool: number; callTool: number }> = [];
		const make = () => {
			const boxed = boxedCallable();
			natives.push(boxed.calls);
			return request({ tools: [boxed.tool] });
		};
		const r = await nativeThenGoverned("generateContent", same(make), { rounds: LOOP });
		expect(r.rawResult).toBe("ok");
		expectSameSend(r);
		expect(r.raw.requests).toHaveLength(2);
		expect(natives.map((c) => c.callTool)).toEqual([1, 1]);
	});

	for (const method of METHODS) {
		it(`${method}: a boxed String carrying its own data property, inside a function response: governed == native, or refused, never an altered request`, async () => {
			const make = () =>
				request({}, [
					{ role: "user", parts: [{ text: "go" }] },
					{ role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									name: "f",
									response: { s: Object.assign(new String("hi"), { note: "kept off the wire" }) },
								},
							},
						],
					},
				]);
			const r = await nativeThenGoverned(method, same(make));
			expect(JSON.stringify(r.raw.requests[0]?.body)).toContain('"s":"hi"');
			if (r.govResult === "ok") {
				expectSameSend(r);
			} else {
				expect(r.gov.requests).toHaveLength(0);
			}
			expect(JSON.stringify(r.gov.requests)).not.toContain("kept off the wire");
		});
	}
});

describe("a request's own fields beside model, contents and config reach the policy as before, and are never sent", () => {
	function denyClassified(): void {
		mkdirSync(join(vault, ".usertrust", "policies"), { recursive: true });
		writeFileSync(
			join(vault, ".usertrust", "policies", "default.yml"),
			"rules:\n  - name: classified\n    effect: deny\n    enforcement: hard\n    conditions:\n      - field: metadata.classification\n        operator: exists\n",
		);
	}

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			const on = `${method} on ${backend}`;

			it(`${on}: a hard-deny policy on metadata.classification denies the call, nothing sent`, async () => {
				denyClassified();
				const make = () => ({ ...request({}), metadata: { classification: "secret" } });
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(r.raw.requests).toHaveLength(1);
				expect(r.govResult).toContain("[classified]");
				expect(r.auditKinds).toEqual(["policy_denied"]);
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: the same field behind a getter: read once, and the call is denied, nothing sent`, async () => {
				denyClassified();
				const reads = { n: 0 };
				const params = request({});
				Object.defineProperty(params, "metadata", {
					get() {
						reads.n++;
						return { classification: "secret" };
					},
					enumerable: true,
				});
				const w = wire();
				globalThis.fetch = w.fetchStub as typeof fetch;
				const audit = recordingAudit();
				const governed = await trust(sdkClient(vertex), {
					dryRun: true,
					budget: 500_000,
					vaultBase: vault,
					_audit: audit,
				});
				const out = await runOn(governed.models, method, params);
				await governed.destroy();
				expect(out.result).toContain("[classified]");
				expect(reads.n).toBe(1);
				expect(w.requests).toHaveLength(0);
			});

			it(`${on}: with no policy on it, a getter for the field runs once, as on the base (measured there: 1), and the call is sent as natively`, async () => {
				const reads = { native: 0, governed: 0 };
				const make = (side: "native" | "governed") => () => {
					const params = request({ temperature: 0.5 });
					Object.defineProperty(params, "metadata", {
						get() {
							reads[side]++;
							return { classification: "secret" };
						},
						enumerable: true,
					});
					return params;
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
					{ vertex },
				);
				expect(r.govResult).toBe("ok");
				expectSameSend(r);
				expect(reads.native).toBe(0); // the SDK never reads it
				expect(reads.governed).toBe(1); // the base read it once, for the policy
			});

			it(`${on}: with no policy on it, the field is not on the wire: governed == native, the self-check passing`, async () => {
				const make = () => ({
					...request({ temperature: 0.5 }),
					metadata: { classification: "secret" },
				});
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expect(r.govResult).toBe("ok");
				expectSameSend(r);
				expect(JSON.stringify(r.gov.requests)).not.toContain("classification");
			});
		}
	}
});

describe("destroy() called right after a call starts waits for that call, as for any call in flight", () => {
	async function governedOnWire() {
		const w = wire();
		globalThis.fetch = w.fetchStub as typeof fetch;
		const governed = await trust(sdkClient(false), {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: recordingAudit(),
		});
		return { w, governed };
	}

	function ownMapParts() {
		const parts: unknown[] = [{ text: "safe" }];
		Object.defineProperty(parts, "map", { value: () => [], enumerable: false });
		return request({}, [{ role: "user", parts }]);
	}

	for (const method of METHODS) {
		it(`${method}: the call completes and is sent, and destroy() resolves after it`, async () => {
			const { w, governed } = await governedOnWire();
			const order: string[] = [];
			const call = runOn(governed.models, method, request({ temperature: 0.5 })).then((r) => {
				order.push("call");
				return r;
			});
			const destroyed = governed.destroy().then(() => {
				order.push("destroy");
			});
			await Promise.all([call, destroyed]);
			expect((await call).result).toBe("ok");
			expect(w.requests).toHaveLength(1);
			expect(order).toEqual(["call", "destroy"]);
			// a call started after destroy() is still refused
			expect((await runOn(governed.models, method, request({}))).result).toBe(
				"TrustedClient has been destroyed",
			);
		});

		it(`${method}: a call refused at its start, by the request gate, or as a local SDK error is released: destroy() does not wait for it`, async () => {
			const { w, governed } = await governedOnWire();
			const refusals = [
				request({ httpOptions: { extraBody: { x: 1 } } }), // call start: an option off the list
				ownMapParts(), // the request gate: a caller function the SDK would call
				request({}, []), // the SDK's own "contents are required"
			];
			const outcomes: string[] = [];
			for (const params of refusals) {
				outcomes.push((await runOn(governed.models, method, params)).result);
			}
			expect(outcomes.map((o) => o === "ok")).toEqual([false, false, false]);
			const started = Date.now();
			await governed.destroy();
			expect(Date.now() - started).toBeLessThan(1_000); // a leaked admission waits 5 s
			expect(w.requests).toHaveLength(0);
		});
	}
});

/**
 * THE SPECIFICATION of the request-options path for a Google request: every cell is the base's
 * measured outcome and request count (5a7b2cf7), and any change to this path keeps every cell equal.
 */
describe("every level of the option path refuses or sends as the base does (the base's measured table)", () => {
	const EXTRA_BODY = { extraBody: { injected: "SECRET-X" } };
	const ALLOWED = { headers: { "x-test": "ok" } };

	/** A data httpOptions whose every key is a getter answering `value`'s, its runs counted. */
	function keyGetters(value: object, runs: { n: number }): Loose {
		const options: Loose = {};
		for (const [key, v] of Object.entries(value)) {
			Object.defineProperty(options, key, {
				get: () => {
					runs.n++;
					return v;
				},
				enumerable: true,
			});
		}
		return options;
	}
	const getterConfig = (config: unknown) =>
		Object.defineProperty({ model: "gemini-2.5-flash", contents: "go" }, "config", {
			get: () => config,
			enumerable: true,
		});
	const getterHttpOptions = (options: unknown) =>
		request(Object.defineProperty({}, "httpOptions", { get: () => options, enumerable: true }));

	/** Each shape of the path, holding `v`. */
	const shapes: Array<[string, (v: object, runs: { n: number }) => unknown]> = [
		["a getter config", (v) => getterConfig({ httpOptions: v })],
		["a getter httpOptions", (v) => getterHttpOptions(v)],
		["a getter key", (v, runs) => request({ httpOptions: keyGetters(v, runs) })],
		["a Proxy config", (v) => request(new Proxy({ httpOptions: v }, {}))],
		["a Proxy httpOptions", (v) => request({ httpOptions: new Proxy(v, {}) })],
		["all data", (v) => request({ httpOptions: v })],
		["a getter httpOptions -> a getter key", (v, runs) => getterHttpOptions(keyGetters(v, runs))],
		[
			"a getter config -> a getter key",
			(v, runs) => getterConfig({ httpOptions: keyGetters(v, runs) }),
		],
		["a getter config -> a Proxy config", (v) => getterConfig(new Proxy({ httpOptions: v }, {}))],
		[
			"a getter config -> a Proxy httpOptions",
			(v) => getterConfig({ httpOptions: new Proxy(v, {}) }),
		],
		["a getter httpOptions -> a Proxy httpOptions", (v) => getterHttpOptions(new Proxy(v, {}))],
		[
			"an inherited getter httpOptions -> a getter key",
			(v, runs) =>
				request(
					Object.create(
						Object.defineProperty({}, "httpOptions", { get: () => keyGetters(v, runs) }),
					) as Loose,
				),
		],
		[
			"a getter httpOptions -> an internal data key",
			(v) => getterHttpOptions({ ...v, __internal: 1 }),
		],
	];

	/**
	 * The base's outcome for each shape, measured there (5a7b2cf7) on both methods and both backends,
	 * alike on all four: "ok" with one request, or refused with none and the name it gave. The two
	 * Proxy-config shapes are refused there as a request that could not be checked (a Proxy in
	 * params.config), here as an unreadable option path: refused, nothing sent, either way.
	 */
	const BASE: Record<string, { extraBody: string; allowed: string }> = {
		"a getter config": { extraBody: "config.httpOptions.extraBody", allowed: "ok" },
		"a getter httpOptions": { extraBody: "config.httpOptions.extraBody", allowed: "ok" },
		"a getter key": {
			extraBody: "config.httpOptions.extraBody",
			allowed: "config.httpOptions.headers (an accessor)",
		},
		"a Proxy config": { extraBody: "refused", allowed: "refused" },
		"a Proxy httpOptions": {
			extraBody: "config.httpOptions (a Proxy)",
			allowed: "config.httpOptions (a Proxy)",
		},
		"all data": { extraBody: "config.httpOptions.extraBody", allowed: "ok" },
		"a getter httpOptions -> a getter key": {
			extraBody: "config.httpOptions.extraBody",
			allowed: "config.httpOptions.headers (an accessor)",
		},
		"a getter config -> a getter key": {
			extraBody: "config.httpOptions.extraBody",
			allowed: "config.httpOptions.headers (an accessor)",
		},
		"a getter config -> a Proxy config": { extraBody: "refused", allowed: "refused" },
		"a getter config -> a Proxy httpOptions": {
			extraBody: "config.httpOptions (a Proxy)",
			allowed: "config.httpOptions (a Proxy)",
		},
		"a getter httpOptions -> a Proxy httpOptions": {
			extraBody: "config.httpOptions (a Proxy)",
			allowed: "config.httpOptions (a Proxy)",
		},
		"an inherited getter httpOptions -> a getter key": {
			extraBody: "config.httpOptions.extraBody",
			allowed: "config.httpOptions.headers (an accessor)",
		},
		"a getter httpOptions -> an internal data key": {
			extraBody: "config.httpOptions.extraBody, config.httpOptions.__internal (internal)",
			allowed: "config.httpOptions.__internal (internal)",
		},
	};

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			for (const [shape, make] of shapes) {
				for (const [variant, value] of [
					["extraBody", EXTRA_BODY],
					["allowed", ALLOWED],
				] as const) {
					const expected = BASE[shape]?.[variant] as string;
					it(`${method} on ${backend}, ${shape} holding ${variant}: ${expected === "ok" ? "sent, as on the base" : "refused before anything is sent, as on the base"}`, async () => {
						const w = wire();
						globalThis.fetch = w.fetchStub as typeof fetch;
						const audit = recordingAudit();
						const governed = await trust(sdkClient(vertex), {
							dryRun: true,
							budget: 500_000,
							vaultBase: vault,
							_audit: audit,
						});
						const runs = { n: 0 };
						const { result } = await runOn(governed.models, method, make(value, runs));
						await governed.destroy();
						expect(runs.n).toBe(0); // no getter key runs: the base ran none
						expect(JSON.stringify(w.requests)).not.toContain("SECRET-X");
						if (expected === "ok") {
							expect(result).toBe("ok");
							expect(w.requests).toHaveLength(1);
							return;
						}
						expect(result).toContain("request_option_refused");
						if (expected !== "refused") expect(result).toContain(`(${expected})`);
						expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
						expect(w.requests).toHaveLength(0);
					});
				}
			}
		}
	}
});

describe("policy fields beside the request are kept off the sent request, by reference, and a rule reads them as before", () => {
	function denyPolicy(field: string, operator = "exists"): void {
		mkdirSync(join(vault, ".usertrust", "policies"), { recursive: true });
		writeFileSync(
			join(vault, ".usertrust", "policies", "default.yml"),
			`rules:\n  - name: present\n    effect: deny\n    enforcement: hard\n    conditions:\n      - field: ${field}\n        operator: ${operator}\n`,
		);
	}
	async function governedRun(method: Method, params: unknown, budget = 500_000) {
		const w = wire();
		globalThis.fetch = w.fetchStub as typeof fetch;
		const audit = recordingAudit();
		const governed = await trust(sdkClient(false), {
			dryRun: true,
			budget,
			vaultBase: vault,
			_audit: audit,
		});
		const { result } = await runOn(governed.models, method, params);
		await governed.destroy();
		return { result, requests: w.requests, kinds: audit.events.map((e) => e.kind) };
	}

	for (const method of METHODS) {
		for (const enumerable of [true, false]) {
			it(`${method}: a request's own ${enumerable ? "enumerable" : "non-enumerable"} toJSON answering without its large config never sizes the hold: refused at a budget of 200, the hook never run`, async () => {
				const runs = { n: 0 };
				const params = request({ systemInstruction: "word ".repeat(40_000) });
				Object.defineProperty(params, "toJSON", {
					value: () => {
						runs.n++;
						return { model: "gemini-2.5-flash", contents: "go" };
					},
					enumerable,
					writable: true,
					configurable: true,
				});
				const r = await governedRun(method, params, 200);
				expect(r.result).toContain("block-budget-overshoot");
				expect(r.requests).toHaveLength(0);
				expect(r.kinds).toEqual(["policy_denied"]);
				expect(runs.n).toBe(0);
			});
		}

		it(`${method}: a hard deny on a function-valued field's existence denies, as before, and the function never runs`, async () => {
			denyPolicy("hook");
			const runs = { n: 0 };
			const r = await governedRun(method, {
				...request({}),
				hook: () => {
					runs.n++;
					return "x";
				},
			});
			expect(r.result).toContain("[present]");
			expect(r.requests).toHaveLength(0);
			expect(runs.n).toBe(0);
		});

		it(`${method}: a nested getter in a policy field is read when the rule asks for it, once, as on the base, and denies on what it answered`, async () => {
			denyPolicy("metadata.classification");
			const reads = { n: 0 };
			const r = await governedRun(method, {
				...request({}),
				metadata: {
					get classification() {
						reads.n++;
						return "secret";
					},
				},
			});
			expect(r.result).toContain("[present]");
			expect(reads.n).toBe(1);
			expect(r.requests).toHaveLength(0);
		});
		// The base's outcome for each shape, measured there (5a7b2cf7): denied, nothing sent.
		class Meta {
			get classification(): string {
				return "secret";
			}
		}
		for (const [shape, field, make] of [
			[
				"an inherited getter below a field",
				"metadata.classification",
				() => ({ ...request({}), metadata: new Meta() }),
			],
			[
				"inherited data below a field",
				"metadata.classification",
				() => ({ ...request({}), metadata: Object.create({ classification: "secret" }) as Loose }),
			],
			[
				"an own __proto__ field (JSON.parse)",
				"__proto__.classification",
				() =>
					JSON.parse(
						'{"model":"gemini-2.5-flash","contents":"go","__proto__":{"classification":"secret"}}',
					) as unknown,
			],
		] as const) {
			it(`${method}: a hard exists deny reaching ${shape} denies, nothing sent, as on the base`, async () => {
				denyPolicy(field);
				const r = await governedRun(method, make());
				expect(r.result).toContain("[present]");
				expect(r.requests).toHaveLength(0);
			});
		}

		// The base's outcome for a not_exists deny on `approval` (5a7b2cf7): present in any of these
		// forms, sent; absent, denied.
		for (const [shape, make, sent] of [
			["own enumerable", () => ({ ...request({}), approval: "yes" }), true],
			[
				"inherited",
				() => Object.assign(Object.create({ approval: "yes" }), request({})) as Loose,
				true,
			],
			[
				"own non-enumerable",
				() => Object.defineProperty(request({}), "approval", { value: "yes", enumerable: false }),
				true,
			],
			["absent", () => request({}), false],
		] as const) {
			it(`${method}: a not_exists deny on a field held ${shape}: ${sent ? "sent" : "denied"}, as on the base`, async () => {
				denyPolicy("approval", "not_exists");
				const r = await governedRun(method, make());
				if (sent) {
					expect(r.result).toBe("ok");
					expect(r.requests).toHaveLength(1);
				} else {
					expect(r.result).toContain("[present]");
					expect(r.requests).toHaveLength(0);
				}
			});
		}

		it(`${method}: a policy field holding its own toJSON and a getter, with a rule on another path: the hook never runs (on the base the hold ran it once), the getter runs as on the base (0), and the call is sent`, async () => {
			denyPolicy("other.thing");
			const runs = { json: 0, get: 0 };
			const r = await governedRun(method, {
				...request({}),
				metadata: {
					toJSON() {
						runs.json++;
						return {};
					},
					get inner() {
						runs.get++;
						return 1;
					},
				},
			});
			expect(r.result).toBe("ok");
			expect(r.requests).toHaveLength(1);
			expect(runs.json).toBe(0);
			expect(runs.get).toBe(0);
		});
	}

	it("generateContent: what is forwarded holds no caller object by reference but the abort signal at its path, and no policy field", async () => {
		const received: unknown[] = [];
		const response = {
			candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
			text: "hi",
		};
		const client = {
			models: {
				generateContent: vi.fn(async (p: unknown) => {
					received.push(p);
					return response;
				}),
				generateContentStream: vi.fn(),
			},
		};
		const governed = await trust(client, {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: recordingAudit(),
		});
		const signal = new AbortController().signal;
		const caller = new Set<object>();
		const note = <T extends object>(o: T): T => {
			caller.add(o);
			return o;
		};
		const params = note({
			model: "gemini-2.5-flash",
			contents: note([note({ role: "user", parts: note([note({ text: "go" })]) })]),
			config: note({
				abortSignal: signal,
				systemInstruction: note({ parts: note([note({ text: "be brief" })]) }),
				tools: note([note({ functionDeclarations: note([note({ name: "f" })]) })]),
			}),
			metadata: note({ classification: "internal" }),
		});
		expect((await runOn(governed.models, "generateContent", params)).result).toBe("ok");
		await governed.destroy();
		const shared: unknown[] = [];
		const walk = (v: unknown, seen = new Set<unknown>()): void => {
			if (v === null || typeof v !== "object" || seen.has(v)) return;
			seen.add(v);
			if (caller.has(v)) shared.push(v);
			if (v === signal) return;
			for (const key of Reflect.ownKeys(v)) {
				const d = Object.getOwnPropertyDescriptor(v, key);
				if (d !== undefined && "value" in d) walk(d.value, seen);
			}
		};
		walk(received[0]);
		expect(shared).toEqual([]);
		expect((received[0] as { config: Loose }).config["abortSignal"]).toBe(signal);
		expect(received[0]).not.toHaveProperty("metadata");
	});
});

describe("after destroy() begins, no new provider request starts; a request already sent settles", () => {
	/** A wire whose first answer asks for the callable's tool, then answers; each request recorded. */
	function loopWire() {
		const requests: Loose[] = [];
		const fetchStub = async (_url: unknown, init?: { body?: unknown }) => {
			requests.push(JSON.parse(String(init?.body)) as Loose);
			const parts =
				requests.length === 1
					? [{ functionCall: { name: "lookup", args: {} } }, { text: "" }]
					: [{ text: "done" }];
			return new Response(
				JSON.stringify({
					candidates: [{ content: { role: "model", parts } }],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		return { requests, fetchStub };
	}

	it("generateContent: an AFC round whose callTool is pending across destroy(): the next round is refused as destroyed, one request in all, and destroy() does not wait for it", async () => {
		let release: () => void = () => {};
		const pending = new Promise<void>((r) => {
			release = r;
		});
		let called: () => void = () => {};
		const callToolCalled = new Promise<void>((r) => {
			called = r;
		});
		const tool = {
			tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
			callTool: async () => {
				called();
				await pending;
				return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
			},
		};
		const w = loopWire();
		globalThis.fetch = w.fetchStub as typeof fetch;
		const audit = recordingAudit();
		const governed = await trust(sdkClient(false), {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: audit,
		});
		const call = runOn(governed.models, "generateContent", request({ tools: [tool] }));
		await callToolCalled;
		const started = Date.now();
		await governed.destroy();
		expect(Date.now() - started).toBeLessThan(1_000);
		release();
		expect((await call).result).toBe("TrustedClient has been destroyed");
		expect(w.requests).toHaveLength(1);
		expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
	});

	it("generateContent: an AFC round that would start while destroy() is still draining another call's request is refused: the drain waits for requests already sent, it starts none", async () => {
		let releaseTool: () => void = () => {};
		const toolPending = new Promise<void>((r) => {
			releaseTool = r;
		});
		let called: () => void = () => {};
		const callToolCalled = new Promise<void>((r) => {
			called = r;
		});
		const tool = {
			tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
			callTool: async () => {
				called();
				await toolPending;
				return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
			},
		};
		// The AFC call's requests, and a second call whose one request is held on the wire.
		const afc = loopWire();
		const held = wire();
		let answerHeld: () => void = () => {};
		const heldAnswered = new Promise<void>((r) => {
			answerHeld = r;
		});
		let heldSent: () => void = () => {};
		const heldOnWire = new Promise<void>((r) => {
			heldSent = r;
		});
		globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
			if (String(init?.body).includes("held")) {
				heldSent();
				await heldAnswered;
				return held.fetchStub(url, init);
			}
			return afc.fetchStub(url, init);
		}) as typeof fetch;
		const audit = recordingAudit();
		const governed = await trust(sdkClient(false), {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: audit,
		});
		const looping = runOn(governed.models, "generateContent", request({ tools: [tool] }));
		await callToolCalled;
		const onWire = runOn(governed.models, "generateContent", request({}, "held"));
		await heldOnWire;
		const destroyed = governed.destroy();
		releaseTool(); // the AFC call's next round now tries to start, during the drain
		expect((await looping).result).toBe("TrustedClient has been destroyed");
		answerHeld();
		expect((await onWire).result).toBe("ok");
		await destroyed;
		expect(afc.requests).toHaveLength(1);
		expect(held.requests).toHaveLength(1);
	});

	for (const method of METHODS) {
		it(`${method}: a request already on the wire when destroy() begins settles, is metered, and destroy() resolves after it`, async () => {
			let answer: () => void = () => {};
			const answered = new Promise<void>((r) => {
				answer = r;
			});
			let sent: () => void = () => {};
			const onWire = new Promise<void>((r) => {
				sent = r;
			});
			const w = wire();
			globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
				sent();
				await answered;
				return w.fetchStub(url, init);
			}) as typeof fetch;
			const audit = recordingAudit();
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: audit,
			});
			const order: string[] = [];
			const call = runOn(governed.models, method, request({})).then((r) => {
				order.push("call");
				return r;
			});
			await onWire;
			const destroyed = governed.destroy().then(() => order.push("destroy"));
			answer();
			await Promise.all([call, destroyed]);
			expect((await call).result).toBe("ok");
			expect(w.requests).toHaveLength(1);
			expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
			expect(order).toEqual(["call", "destroy"]);
		});

		it(`${method}: a call the caller aborts before its request answers releases its admission: destroy() does not wait for it, and nothing more is sent`, async () => {
			const controller = new AbortController();
			let sent: () => void = () => {};
			const onWire = new Promise<void>((r) => {
				sent = r;
			});
			let requests = 0;
			globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
				requests++;
				sent();
				return await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted by the caller")));
				});
			}) as typeof fetch;
			const governed = await trust(sdkClient(false), {
				dryRun: true,
				budget: 500_000,
				vaultBase: vault,
				_audit: recordingAudit(),
			});
			const call = runOn(governed.models, method, request({ abortSignal: controller.signal }));
			await onWire;
			controller.abort();
			expect((await call).result).not.toBe("ok");
			const started = Date.now();
			await governed.destroy();
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(requests).toBe(1);
		});
	}
});
