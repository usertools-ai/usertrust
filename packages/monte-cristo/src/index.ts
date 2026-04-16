// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust-monte-cristo — Monte Carlo simulation foundation
//
// Pure math library: deterministic PRNG + sampling primitives + N-iteration
// simulator. Governance-specific simulators (token spend, policy what-if,
// risk scenarios) consume these foundations.

export { Xoshiro256, createRng, hashInputs } from "./rng/xoshiro256.js";
export {
	rateToBetaParams,
	sampleBeta,
	sampleLognormal,
	sampleNormal,
	sampleTriangular,
	sampleUniform,
} from "./distributions/index.js";
export {
	computePercentiles,
	percentileFromSorted,
	runSimulation,
	runSimulationStreaming,
	type Percentiles,
	type SimulationComplete,
	type SimulationEvent,
	type SimulationProgress,
	type SimulationResult,
	type SimulatorConfig,
} from "./simulator/index.js";
