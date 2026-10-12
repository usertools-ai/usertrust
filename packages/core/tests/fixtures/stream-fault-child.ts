// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * stream-fault-child.ts — a CUSTOMER process for the streaming-receipt rows, run as its
 * own Node process because an unhandled rejection ends the PROCESS, which an in-process
 * test cannot observe.
 *
 *   tsx stream-fault-child.ts <coreEntry> <surface> <fault> <caller>
 *
 *   coreEntry  path to the usertrust entry module to govern with (src/index.ts here)
 *   surface    anthropic         messages.create({ stream: true })
 *              anthropic-helper  messages.stream()
 *              openai            chat.completions.create({ stream: true })
 *              openai-responses  responses.create({ stream: true })
 *   fault      ok     a complete stream
 *              cut    the server closes the socket after the first events
 *              error  the provider sends an error event mid-stream
 *   caller     docs     catches the iteration error and never awaits `.receipt`
 *              receipt  catches it, then awaits `.receipt`
 *
 * A real SDK talks to a local SSE server, so the failure is the SDK's own. No
 * `unhandledRejection` handler is installed: Node's default (exit 1) is the point.
 * Prints ONE JSON line with what the caller saw, then exits normally.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const [coreEntry, surface, fault, caller] = process.argv.slice(2);
if (coreEntry === undefined || surface === undefined || fault === undefined) {
	process.stderr.write("usage: stream-fault-child <coreEntry> <surface> <fault> <caller>\n");
	process.exit(2);
}

const sse = (res: ServerResponse, event: string | null, data: unknown): void => {
	res.write(`${event !== null ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
};

const ANTHROPIC_HEAD: Array<[string, unknown]> = [
	[
		"message_start",
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-6",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 12, output_tokens: 1 },
			},
		},
	],
	[
		"content_block_start",
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	],
	[
		"content_block_delta",
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
	],
];
const ANTHROPIC_TAIL: Array<[string, unknown]> = [
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		},
	],
	["message_stop", { type: "message_stop" }],
];

const openaiChunk = (content: string | null, finish: string | null): unknown => ({
	id: "chatcmpl-1",
	object: "chat.completion.chunk",
	created: 0,
	model: "gpt-4o",
	choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
});

const RESPONSE = {
	id: "resp_1",
	object: "response",
	created_at: 0,
	model: "gpt-4o",
	output: [],
};

/** OpenAI Responses events: typed SSE events, as the Responses API streams them. */
function respondResponses(res: ServerResponse): void {
	sse(res, "response.created", {
		type: "response.created",
		sequence_number: 0,
		response: { ...RESPONSE, status: "in_progress", usage: null },
	});
	sse(res, "response.output_text.delta", {
		type: "response.output_text.delta",
		sequence_number: 1,
		item_id: "msg_1",
		output_index: 0,
		content_index: 0,
		delta: "Hel",
	});
	if (fault === "cut") {
		setTimeout(() => res.socket?.destroy(), 50);
		return;
	}
	if (fault === "error") {
		// The Responses API's mid-stream error event, in its documented shape.
		sse(res, "error", {
			type: "error",
			code: "server_error",
			message: "Internal server error",
			param: null,
			sequence_number: 2,
		});
	} else {
		sse(res, "response.completed", {
			type: "response.completed",
			sequence_number: 2,
			response: {
				...RESPONSE,
				status: "completed",
				usage: {
					input_tokens: 12,
					output_tokens: 5,
					total_tokens: 17,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		});
	}
	res.end();
}

const server = createServer((req, res) => {
	req.resume();
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	if (surface === "openai-responses") {
		respondResponses(res);
		return;
	}
	const anthropic = surface.startsWith("anthropic");
	if (anthropic) for (const [e, d] of ANTHROPIC_HEAD) sse(res, e, d);
	else {
		sse(res, null, openaiChunk("Hel", null));
		sse(res, null, openaiChunk("lo", null));
	}
	if (fault === "cut") {
		// Let the head reach the client, then drop the connection mid-stream.
		setTimeout(() => res.socket?.destroy(), 50);
		return;
	}
	if (fault === "error") {
		if (anthropic) {
			sse(res, "error", {
				type: "error",
				error: { type: "api_error", message: "Internal server error" },
			});
		} else {
			sse(res, null, { error: { message: "Internal server error", type: "server_error" } });
		}
		res.end();
		return;
	}
	if (anthropic) for (const [e, d] of ANTHROPIC_TAIL) sse(res, e, d);
	else {
		sse(res, null, openaiChunk(null, "stop"));
		sse(res, null, {
			...(openaiChunk(null, null) as object),
			choices: [],
			usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
		});
		res.write("data: [DONE]\n\n");
	}
	res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { trust } = (await import(pathToFileURL(coreEntry).href)) as {
	trust: <T>(client: T, opts: Record<string, unknown>) => Promise<unknown>;
};
const vaultBase = mkdtempSync(join(tmpdir(), "stream-fault-"));
const opts = { dryRun: true, budget: 50_000, vaultBase };

type Governed = {
	response: AsyncIterable<unknown> & { receipt?: Promise<{ settled?: boolean }> };
	receipt: { settled?: boolean };
};
// biome-ignore lint/suspicious/noExplicitAny: the governed client mirrors the SDK's own surface
let client: any;
let governed: Governed;
const messages = [{ role: "user", content: "probe" }];
if (surface === "openai" || surface === "openai-responses") {
	client = await trust(new OpenAI({ apiKey: "x", baseURL: `${origin}/v1`, maxRetries: 0 }), opts);
	governed =
		surface === "openai"
			? await client.chat.completions.create({ model: "gpt-4o", messages, stream: true })
			: await client.responses.create({ model: "gpt-4o", input: "probe", stream: true });
} else {
	client = await trust(new Anthropic({ apiKey: "x", baseURL: origin, maxRetries: 0 }), opts);
	const params = { model: "claude-sonnet-4-6", max_tokens: 64, messages };
	if (surface === "anthropic-helper") {
		const stream = await client.messages.stream(params);
		governed = { response: stream, receipt: { settled: false } };
	} else {
		governed = await client.messages.create({ ...params, stream: true });
	}
}

/** The error's class, e.g. APIError: its `name` is often just "Error". */
const errorClass = (err: unknown): string | undefined =>
	err instanceof Error ? err.constructor.name : typeof err;

const outcome: Record<string, unknown> = { outerReceiptSettled: governed.receipt.settled };
let iterationError: unknown;
try {
	for await (const _ of governed.response) {
		// consume
	}
	outcome.iteration = "ended";
} catch (err) {
	iterationError = err;
	outcome.iteration = "threw";
	outcome.iterationError = errorClass(err);
}

if (caller === "receipt") {
	try {
		const receipt = await governed.response.receipt;
		outcome.receipt = "resolved";
		outcome.receiptSettled = receipt?.settled;
	} catch (err) {
		outcome.receipt = "rejected";
		outcome.receiptError = errorClass(err);
		outcome.receiptIsIterationError = err === iterationError;
	}
}

// Give an unhandled rejection its chance to end the process, as a real caller's next
// awaits would.
await new Promise((resolve) => setTimeout(resolve, 300));
await client.destroy();
server.close();
process.stdout.write(`${JSON.stringify(outcome)}\n`);
