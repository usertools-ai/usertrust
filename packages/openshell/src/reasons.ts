// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every reason the request gate denies a call with. OpenShell accepts a
 * `reason_code` only when it matches {@link REASON_CODE_PATTERN}; a test pins
 * every member against it.
 */
export const DenyReason = {
	/** Over budget, outstanding debt included (the reservation, a later slice). */
	budgetExceeded: "budget_exceeded",
	/** The model has no rates of its own. Never billed at a fallback rate. */
	modelUnpriced: "model_unpriced",
	/** Not one of the metered routes, and not on the pass-through allowlist. */
	routeUnsupported: "route_unsupported",
	/** A metered route whose body is not a JSON object with a model. */
	requestUnparseable: "request_unparseable",
	/** OpenAI `background: true`: usage arrives only by polling. */
	backgroundUnsupported: "background_unsupported",
	/** Any tool that is not a client-executed function tool. */
	hostedToolUnsupported: "hosted_tool_unsupported",
	/** Context the provider expands and bills but the body does not contain. */
	providerContextUnsupported: "provider_context_unsupported",
	/** `n > 1`: output is billed per choice. */
	multipleChoicesUnsupported: "multiple_choices_unsupported",
	/**
	 * The request sets no output limit. Interim (see README "Spec gaps"): the
	 * spec says to hold the model's maximum output from the pricing table, and
	 * the table has no such field.
	 */
	maxOutputUnbounded: "max_output_unbounded",
	/** A content part or input item of a type v1 does not bound. */
	contentUnsupported: "content_unsupported",
	/** A tier, speed or region priced ABOVE the table's standard rates. */
	pricingTierUnsupported: "pricing_tier_unsupported",
	/** A top-level request field not on the route's allowlist. */
	parameterUnsupported: "parameter_unsupported",
} as const;

export type DenyReason = (typeof DenyReason)[keyof typeof DenyReason];

/** OpenShell's `reason_code` grammar (supervisor_middleware.proto). */
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
