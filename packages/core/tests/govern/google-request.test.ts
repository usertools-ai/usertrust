import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as utilTypes } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type GoogleModelsCtor, snapshotGoogleRequest } from "../../src/google-request.js";
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
function wire(rounds: Round[] = [{ text: "done" }]) {
	const requests: Array<{ url: string; body: Loose; testHeader: string | null }> = [];
	const fetchStub = async (
		url: unknown,
		init?: { body?: unknown; headers?: HeadersInit },
	): Promise<Response> => {
		requests.push({
			url: String(url),
			body: JSON.parse(String(init?.body)) as Loose,
			// a caller's own header, sent through `config.httpOptions.headers`
			testHeader: new Headers(init?.headers).get("x-test"),
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
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
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
	// the refusal carries the SDK's message (the audit record bounds its length)
	expect(String((r.events[0]?.data as Loose | undefined)?.["error"])).toContain(
		`rejected by the SDK before any request: ${r.rawResult.slice(0, 40)}`,
	);
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
	async function abortedRun(models: unknown, method: Method) {
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
		const run = runOn(models, method, request({ abortSignal: controller.signal }));
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

describe("the self-check compares every request argument, not only the body", () => {
	/** A data tool the SDK counts as MCP usage, so it re-reads config.httpOptions for its usage header. */
	const mcpTool = () => ({
		functionDeclarations: [{ name: "lookup" }],
		inputSchema: { type: "object" },
	});

	/** An own enumerable httpOptions getter answering `headers(n)` on its n-th read. */
	const withHttpOptions = (headers: (n: number) => string) => () => {
		let reads = 0;
		const config: Loose = { tools: [mcpTool()] };
		Object.defineProperty(config, "httpOptions", {
			enumerable: true,
			configurable: true,
			get: () => {
				reads++;
				return { headers: { "x-test": headers(reads) } };
			},
		});
		return request(config);
	};

	for (const method of METHODS) {
		for (const [backend, vertex] of BACKENDS) {
			it(`${method} on ${backend}: a stable httpOptions getter beside an MCP-usage tool: the same request and header as natively`, async () => {
				const r = await nativeThenGoverned(method, same(withHttpOptions(() => "same")), { vertex });
				expectSameSend(r);
				expect(r.raw.requests.map((q) => q.testHeader)).toEqual(["same"]);
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["same"]);
			});

			it(`${method} on ${backend}: an httpOptions getter answering differently on each of the SDK's three reads: the header comes from its second, and governed sends that one too`, async () => {
				const r = await nativeThenGoverned(method, same(withHttpOptions((n) => `read-${n}`)), {
					vertex,
				});
				// the SDK copies config (read 1), reads headers (read 2), then spreads the options (read 3)
				expectSameSend(r);
				expect(r.raw.requests.map((q) => q.testHeader)).toEqual(["read-2"]);
				expect(r.gov.requests.map((q) => q.testHeader)).toEqual(["read-2"]);
			});
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

			it(`${on}: httpOptions.extraBody is merged into the body as the transport merges it: governed == native`, async () => {
				const make = () =>
					request({
						temperature: 0.5,
						httpOptions: {
							extraBody: { generationConfig: { candidateCount: 2 }, labels: { a: "b" } },
						},
					});
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
				expect(r.raw.requests[0]?.body["generationConfig"]).toMatchObject({
					temperature: 0.5,
					candidateCount: 2,
				});
			});

			it(`${on}: an own map method on contents' parts, which the SDK calls, is refused (its output is not recorded); it ran as often as natively`, async () => {
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
				expect(runs.governed).toBe(runs.native);
				expect(r.govResult).toContain("could not be checked for automatic function calling");
				expect(r.gov.requests).toHaveLength(0);
			});

			it(`${on}: parts in an Array subclass (its map inherited from Array.prototype) go through: governed == native (control)`, async () => {
				class Parts extends Array<unknown> {}
				const make = () => request({}, [{ role: "user", parts: Parts.from([{ text: "safe" }]) }]);
				const r = await nativeThenGoverned(method, same(make), { vertex });
				expectSameSend(r);
			});

			it(`${on}: one object as both config.tools[0] (a callable whose tool() turns AFC back on) and config.automaticFunctionCalling { disable: true }: refused, never an unmetered loop`, async () => {
				const calls = { native: { tool: 0, callTool: 0 }, governed: { tool: 0, callTool: 0 } };
				const make = (side: "native" | "governed") => () => {
					const shared: Loose = { disable: true };
					shared["tool"] = async function (this: Loose) {
						calls[side].tool++;
						this["disable"] = false;
						return { functionDeclarations: [{ name: "lookup" }] };
					};
					shared["callTool"] = async () => {
						calls[side].callTool++;
						return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
					};
					return request({ tools: [shared], automaticFunctionCalling: shared });
				};
				const r = await nativeThenGoverned(
					method,
					{ native: make("native"), governed: make("governed") },
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
