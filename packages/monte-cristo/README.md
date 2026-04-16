# usertrust-monte-cristo

Monte Carlo simulation foundation for [usertrust](https://usertrust.ai)
governance — budget projection, policy what-if, and risk quantification.

This is a **pure math library**: a deterministic 64-bit PRNG, a small
catalog of sampling primitives (triangular, beta, lognormal, normal,
uniform), and an N-iteration simulator that returns percentiles, mean,
and stddev. It has no AI- or governance-specific logic — that belongs
in higher-level simulators that consume this package.

## Status

`v0.1.0` — internal package within the usertrust monorepo. Not yet
published to npm. The API is unstable until v1.0.0.

## Provenance

The math is ported from the **PRISM Monte Carlo engine** originally
developed for the monday.com ROI calculator. The 32-bit `xoshiro128**`
RNG was upgraded to the canonical 64-bit `xoshiro256**` using `bigint`
for u64 arithmetic; sampling formulas are preserved bit-for-bit.

## Quick example

```ts
import {
  Xoshiro256,
  sampleLognormal,
  runSimulation,
} from "usertrust-monte-cristo";

const rng = new Xoshiro256(42); // deterministic seed

const result = runSimulation({
  iterations: 10_000,
  rng,
  // model: monthly token spend ~ lognormal(median=$3,000, sigma=0.4)
  sample: (rng) => sampleLognormal(rng, 3_000, 0.4),
});

console.log(result.percentiles); // { p5, p25, p50, p75, p95, p99 }
console.log(result.mean, result.stddev);
```

Same seed -> same percentiles, every run. That is the foundational
invariant the rest of the governance stack relies on.

## What's exported

- `Xoshiro256` — 64-bit PRNG class with `seed()`, `nextFloat()`,
  `nextUint64()`, `nextUint32()`, `snapshot()`.
- `createRng(seed)` — convenience wrapper returning `{ random, next, rng }`.
- `hashInputs(obj)` — deterministic hash for seeding from a config object.
- `sampleNormal`, `sampleTriangular`, `sampleLognormal`, `sampleBeta`,
  `sampleUniform` — distribution samplers (each takes a `Xoshiro256`).
- `rateToBetaParams(targetRate, spread)` — convert "X +/- Y" into
  Beta(alpha, beta) shape parameters.
- `runSimulation(config)` / `runSimulationStreaming(config)` —
  N-iteration simulator with percentile aggregation.
- `computePercentiles(samples)` / `percentileFromSorted(sorted, p)` —
  raw percentile helpers for custom aggregation.

## Not yet ported

The PRISM engine has 15 more domain-specific modules that build on this
foundation. They will land in follow-up PRs and remain ROI-shaped until
a governance-shaped wrapper is designed:

- `calculateROI`, `risk-quantification`, `sensitivity`
- `adoption`, `maturity`, `synergies`
- `unitEconomics`, `escalation`, `network-effects`
- `financial`, plus assorted helpers (math, currency, validators)

This package intentionally avoids importing from any other
`usertrust-*` package — it must remain a leaf dependency.

## License

Apache-2.0
