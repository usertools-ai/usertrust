// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Prompt Injection Detector
 *
 * Multi-layer heuristic detection for prompt injection attempts.
 * Recursively scans strings in objects/arrays and returns
 * which injection patterns were matched and at which paths.
 *
 * Pure module — no side effects, no network calls.
 *
 * Layers:
 *   1. Keyword combo matching (verb × object phrases)
 *   2. Role boundary detection (role redefinition attempts)
 *   3. Base64 evasion detection (encoded injection payloads)
 *   4. Delimiter injection detection (escape attempts)
 */

import type { InjectionDetection } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Layer 1: Keyword combo matching
// ---------------------------------------------------------------------------

const VERBS = [
	"ignore",
	"disregard",
	"skip",
	"forget",
	"bypass",
	"override",
	"do not follow",
	"stop following",
	"forget about",
];

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Injection intent regex: a directive verb, then up to a few OPTIONAL filler
 * words (all/any/the/your/those/these/prior/previous/preceding/earlier/above/
 * following/original/system/of/to), then a target noun. The filler window lets
 * "ignore ALL previous instructions" and "disregard all prior instructions"
 * match where the old literal "verb object" substrings did not.
 *
 * Filler is bounded to `{0,4}` and every alternative is a literal, so the
 * pattern is linear-time and cannot itself become a ReDoS vector. Homoglyph and
 * heavy-obfuscation evasions remain explicitly out of scope.
 */
const VERB_ALT = VERBS.map(escapeRegExp).join("|");
const OBJECT_ALT = [
	"instructions",
	"instruction",
	"rules",
	"guidelines",
	"directives",
	"system prompt",
	"system message",
	"prompt",
	"context",
	"constraints",
	"restrictions",
].join("|");
const FILLER =
	"(?:all|any|the|your|those|these|prior|previous|preceding|earlier|above|following|original|system|of|to)";
const INJECTION_INTENT_RE = new RegExp(
	`(?:${VERB_ALT})\\s+(?:${FILLER}\\s+){0,4}(?:${OBJECT_ALT})`,
	"i",
);

function checkKeywordCombo(lower: string): boolean {
	return INJECTION_INTENT_RE.test(lower);
}

// ---------------------------------------------------------------------------
// Layer 2: Role boundary detection
// ---------------------------------------------------------------------------

const ROLE_PATTERNS: string[] = [
	// Role redefinition
	"you are now",
	"act as if",
	"pretend you are",
	"from now on",
	"new instructions:",
	"### instruction",
	"## system",
	// System prompt extraction
	"repeat your instructions",
	"print your system prompt",
	"what are your instructions",
	"show me your prompt",
	"output your system",
];

function checkRoleBoundary(lower: string): boolean {
	for (const pattern of ROLE_PATTERNS) {
		if (lower.includes(pattern)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Layer 3: Base64 evasion detection
// ---------------------------------------------------------------------------

const BASE64_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9=])/g;

function checkBase64Evasion(value: string): boolean {
	const candidates = value.match(BASE64_RE);
	if (!candidates) return false;

	for (const candidate of candidates) {
		try {
			const decoded = Buffer.from(candidate, "base64").toString("utf-8");
			// Filter binary data: require printable ASCII only
			if (!/^[\x20-\x7E\t\n\r]+$/.test(decoded)) continue;
			const lower = decoded.toLowerCase();
			if (checkKeywordCombo(lower) || checkRoleBoundary(lower)) return true;
		} catch {
			// Invalid base64 — skip
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Layer 4: Delimiter injection detection
// ---------------------------------------------------------------------------

/** Triple backtick escape followed by system-like content. */
const DELIMITER_BACKTICK_RE = /```[\s\S]*?(?:system|instruction|admin)/i;

/** XML tag injection closing a role-like tag. */
const DELIMITER_XML_RE = /<\/(?:system|user|assistant|human|ai)>/i;

/** Markdown heading injection for role. */
const DELIMITER_HEADING_RE = /^#{1,3}\s*(?:system|instruction|new role)/im;

function checkDelimiterInjection(value: string): boolean {
	return (
		DELIMITER_BACKTICK_RE.test(value) ||
		DELIMITER_XML_RE.test(value) ||
		DELIMITER_HEADING_RE.test(value)
	);
}

// ---------------------------------------------------------------------------
// Recursive scanner (mirrors pii.ts pattern)
// ---------------------------------------------------------------------------

interface ScanState {
	score: number;
	patterns: Set<string>;
	paths: string[];
}

function scanString(value: string, currentPath: string, state: ScanState): void {
	const normalized = value
		.normalize("NFKC")
		.replace(/\u200B|\u200C|\u200D|\uFEFF|\u00AD|\u200E|\u200F/g, "")
		.toLowerCase();

	if (checkKeywordCombo(normalized)) {
		state.patterns.add("keyword_combo");
		state.paths.push(currentPath ? `${currentPath}(keyword_combo)` : "(keyword_combo)");
		if (0.9 > state.score) state.score = 0.9;
	}

	if (checkRoleBoundary(normalized)) {
		state.patterns.add("role_boundary");
		state.paths.push(currentPath ? `${currentPath}(role_boundary)` : "(role_boundary)");
		if (0.85 > state.score) state.score = 0.85;
	}

	if (checkBase64Evasion(value)) {
		state.patterns.add("base64_evasion");
		state.paths.push(currentPath ? `${currentPath}(base64_evasion)` : "(base64_evasion)");
		if (0.95 > state.score) state.score = 0.95;
	}

	if (checkDelimiterInjection(value)) {
		state.patterns.add("delimiter_injection");
		state.paths.push(currentPath ? `${currentPath}(delimiter_injection)` : "(delimiter_injection)");
		if (0.8 > state.score) state.score = 0.8;
	}
}

function scanValue(value: unknown, currentPath: string, state: ScanState): void {
	if (typeof value === "string") {
		scanString(value, currentPath, state);
		return;
	}

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
			scanValue(value[i], itemPath, state);
		}
		return;
	}

	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const fieldPath = currentPath ? `${currentPath}.${key}` : key;
			scanValue(record[key], fieldPath, state);
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect prompt injection attempts in any value by recursively scanning
 * strings in objects/arrays.
 *
 * Returns which injection patterns were matched and at which dot-paths.
 */
export function detectInjection(data: unknown): InjectionDetection {
	const state: ScanState = {
		score: 0,
		patterns: new Set<string>(),
		paths: [],
	};

	scanValue(data, "", state);

	return {
		detected: state.patterns.size > 0,
		score: state.score,
		patterns: [...state.patterns],
		paths: state.paths,
	};
}
