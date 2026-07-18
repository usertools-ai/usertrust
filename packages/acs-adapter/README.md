# usertrust-acs-adapter

ACS/AGT composite-evaluator adapter for the usertrust governance kernel. It occupies the
SpendGuard composite slot documented by Microsoft's Agent Governance Toolkit: a stateless
policy layer decides, and the usertrust ledger provides the stateful two-phase reservation
(PENDING hold → settle or void) behind it.

## The composite contract

1. The external policy decides FIRST (`allow` / `warn` / `deny` / `escalate` / `transform`).
2. On `allow`/`warn`, the usertrust ledger atomically reserves (a PENDING hold).
3. A denied action never consumes a reservation.

If the ledger cannot reserve, the `allow` is converted to `deny` with an ACS-vocabulary
reason (`budget_cost_usd_exceeded`, or `usertrust:policy_denied:<reason>`). A policy that
returns malformed output fails closed: `deny` with `runtime_error:policy_output_invalid`.
Each `CompositeResult` is one-shot — a second `settle()` returns `null` and a second (or
post-settle) `abort()` is a no-op.

## Usage

```ts
import { CompositeEvaluator, createMockGovernor } from "usertrust-acs-adapter";

const { governor } = createMockGovernor({ budget: 1000 }); // or createGovernor() from usertrust/headless
const evaluator = new CompositeEvaluator({
	policy: (action, { inputIdentity, budgets }) =>
		action.kind === "exfiltrate" ? { decision: "deny", reason: "blocked" } : { decision: "allow" },
	governor,
});

const result = await evaluator.evaluate({
	kind: "tool_call",
	model: "claude-sonnet-4-6",
	estimatedInputTokens: 200,
	maxOutputTokens: 500,
});
if (result.verdict.decision === "allow") {
	// ... run the action ...
	await evaluator.settle(result, { inputTokens: 210, outputTokens: 480 });
} // denied? nothing to clean up — no reservation was made
```

`runDemo()` produces an infrastructure-free transcript of all three contract lines.

## evaluate_only mode

With `mode: "evaluate_only"` the adapter is a pure shadow evaluator: the policy verdict is
**preserved exactly as decided** (a `deny` stays a `deny` in `result.verdict`), but nothing
is enforced — `result.enforced` is `false`, the ledger is never touched, no reservation is
made, and `settle()`/`abort()` are no-ops returning `null`. Use it to observe what a policy
would do before turning enforcement on. (Note: the usertrust-server layer defines its own,
different `evaluate_only` semantics — see that package's README.)

## ACS compatibility

The verdict set, the reserved `runtime_error:*` reason namespace, and the
`envelope.budgets` counters (`tool_call_count`, `token_count`, `elapsed_seconds`,
`cost_usd`) follow the Agent Control Specification so the adapter can sit behind an
ACS-style policy layer unchanged. usertrust meters in usertokens; `cost_usd` carries the
usertoken cost unless the deployment configures a conversion. Action identity
(`canonicalJson`/`actionIdentity`) is the adapter's own namespace — unrelated to core's
audit-chain canonicalization.

Patterns and schemas adapted from the Microsoft Agent Governance Toolkit (MIT License) —
see the repository `NOTICE` file. No Microsoft source code is included.
