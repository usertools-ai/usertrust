// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * anomaly/index.ts — Public exports for streaming anomaly governance.
 */

export { AnomalyError } from "../shared/errors.js";
export type { AnomalyDetector } from "./detector.js";
export { createAnomalyDetector, resolveAnomalyConfig } from "./detector.js";
export type {
	AnomalyChunkEvent,
	AnomalyConfig,
	AnomalyDetectorOptions,
	AnomalyDetectorState,
	AnomalyEvent,
	AnomalyInjectionEvent,
	AnomalyKind,
	AnomalyVerdict,
	InjectionCascadeConfig,
	ResolvedAnomalyConfig,
	SpendVelocityConfig,
	TokenRateConfig,
} from "./types.js";
