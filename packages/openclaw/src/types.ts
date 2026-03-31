// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * types.ts — OpenClaw Plugin API Types
 *
 * Type definitions for the OpenClaw plugin system and pi-ai streaming
 * events. These mirror the OpenClaw/pi-ai interfaces without requiring
 * the packages at compile time.
 */

// ── pi-ai Stream Events ──

export interface StreamUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface TextDeltaEvent {
	type: "text_delta";
	text: string;
}

export interface TextStartEvent {
	type: "text_start";
}

export interface TextEndEvent {
	type: "text_end";
}

export interface ThinkingDeltaEvent {
	type: "thinking_delta";
	text: string;
}

export interface ThinkingStartEvent {
	type: "thinking_start";
}

export interface ThinkingEndEvent {
	type: "thinking_end";
}

export interface ToolCallStartEvent {
	type: "toolcall_start";
	name: string;
	id: string;
}

export interface ToolCallDeltaEvent {
	type: "toolcall_delta";
	args: string;
}

export interface ToolCallEndEvent {
	type: "toolcall_end";
}

export interface StartEvent {
	type: "start";
}

export interface DoneEvent {
	type: "done";
	stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
	usage: StreamUsage;
}

export interface ErrorEvent {
	type: "error";
	error: unknown;
	usage?: StreamUsage;
}

export type StreamEvent =
	| StartEvent
	| TextStartEvent
	| TextDeltaEvent
	| TextEndEvent
	| ThinkingStartEvent
	| ThinkingDeltaEvent
	| ThinkingEndEvent
	| ToolCallStartEvent
	| ToolCallDeltaEvent
	| ToolCallEndEvent
	| DoneEvent
	| ErrorEvent;

// ── OpenClaw Plugin API ──

export interface OpenClawPluginApi {
	registerTool(tool: unknown): void;
	registerProvider(provider: unknown): void;
	registerChannel(channel: unknown): void;
	registerHttpRoute(route: unknown): void;
}

/** Configuration passed to the plugin from openclaw.json. */
export interface UsertrustPluginConfig {
	budget: number;
	tier?: "free" | "mini" | "pro" | "mega" | "ultra";
	dryRun?: boolean;
	configPath?: string;
	proxy?: string;
	proxyKey?: string;
}

// ── Stream Function Types ──

export interface StreamContext {
	messages: unknown[];
	model: string;
	maxTokens?: number;
	temperature?: number;
	[key: string]: unknown;
}

export type StreamFn = (
	model: string,
	context: StreamContext,
	options?: Record<string, unknown>,
) => AsyncIterable<StreamEvent>;

/** Receipt attached to governed stream events. */
export interface GovernedStreamMeta {
	transferId: string;
	estimatedCost: number;
	model: string;
}
