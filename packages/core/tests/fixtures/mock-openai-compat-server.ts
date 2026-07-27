// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * mock-openai-compat-server.ts — zero-dependency OpenAI-compatible HTTP fixture.
 *
 * Emulates the /v1 surface local runtimes expose (Ollama, vLLM, LM Studio):
 *   - POST /v1/chat/completions — non-stream JSON, or an SSE stream whose final
 *     usage chunk is emitted ONLY when the request body carried
 *     `stream_options.include_usage: true` (mirrors Ollama's openai.go ChatWriter,
 *     the behavior that makes govern.ts's A4 usage injection load-bearing).
 *   - GET /v1/models — Ollama-style model ids.
 *
 * Consumed by tests/e2e/local-openai-compat.e2e.test.ts. The examples/ demo
 * carries its own inline copy (plan amendment A9) — never import this file from
 * outside packages/core.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockOpenAIServerOpts {
	/** prompt_tokens reported in usage. Default 100. */
	promptTokens?: number;
	/** completion_tokens reported in usage. Default 50. */
	completionTokens?: number;
	/** Number of SSE content chunks before the usage/[DONE] tail. Default 3. */
	chunkCount?: number;
}

export interface MockOpenAIServer {
	port: number;
	/** Server origin, e.g. "http://127.0.0.1:53211" — append "/v1" for a baseURL. */
	url: string;
	/** JSON body of the most recent POST /v1/chat/completions request. */
	lastRequest(): Record<string, unknown> | undefined;
	close(): Promise<void>;
}

interface ChatBody extends Record<string, unknown> {
	model?: unknown;
	stream?: unknown;
	stream_options?: unknown;
}

export async function startMockOpenAIServer(
	opts?: MockOpenAIServerOpts,
): Promise<MockOpenAIServer> {
	const promptTokens = opts?.promptTokens ?? 100;
	const completionTokens = opts?.completionTokens ?? 50;
	const chunkCount = opts?.chunkCount ?? 3;
	let lastBody: Record<string, unknown> | undefined;

	const server: Server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "llama3.3:70b", object: "model" }] }));
			return;
		}

		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			const raw: Buffer[] = [];
			req.on("data", (c: Buffer) => raw.push(c));
			req.on("end", () => {
				let body: ChatBody = {};
				try {
					body = JSON.parse(Buffer.concat(raw).toString("utf-8")) as ChatBody;
				} catch {
					// permissive mock — treat unparseable bodies as empty
				}
				lastBody = body;
				const model = typeof body.model === "string" ? body.model : "llama3.3:70b";
				const usage = {
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					total_tokens: promptTokens + completionTokens,
				};

				if (body.stream === true) {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					});
					const sse = (payload: unknown): void => {
						res.write(`data: ${JSON.stringify(payload)}\n\n`);
					};
					for (let i = 0; i < chunkCount; i++) {
						sse({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							model,
							choices: [
								{
									index: 0,
									delta: { content: `tok${i} ` },
									finish_reason: i === chunkCount - 1 ? "stop" : null,
								},
							],
						});
					}
					const streamOptions =
						body.stream_options != null && typeof body.stream_options === "object"
							? (body.stream_options as Record<string, unknown>)
							: undefined;
					// The usage tail is emitted ONLY on explicit opt-in — exactly like Ollama.
					if (streamOptions?.include_usage === true) {
						sse({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							model,
							choices: [],
							usage,
						});
					}
					res.write("data: [DONE]\n\n");
					res.end();
					return;
				}

				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-mock",
						object: "chat.completion",
						model,
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "mock completion" },
								finish_reason: "stop",
							},
						],
						usage,
					}),
				);
			});
			return;
		}

		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${req.url}` } }));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		port,
		url: `http://127.0.0.1:${port}`,
		lastRequest: () => lastBody,
		close: () =>
			new Promise<void>((resolve, reject) => {
				// Undici's fetch pools keep-alive sockets; sever them so close() resolves.
				server.closeAllConnections();
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
