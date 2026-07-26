# ollama-local-governance

Before/after demo of **first-class local-model governance** (M2): loopback/local
endpoints now settle at nominal local rates instead of silently billing frontier
fallback.

## What it shows

**Before (v1.3):** usertrust had no concept of a local endpoint. A free
`llama3.3:70b` call against `http://localhost:11434/v1` was priced like an
unknown cloud model — sonnet-class `FALLBACK_RATE`, and a streamed call (no
usage chunk without `stream_options.include_usage`) settled on the pre-call
*estimate*: ~615 usertokens of fake dollars per $0 stream. A $50 budget
evaporated after ~800 free calls.

**After (M2):** `classifyEndpoint()` labels the loopback endpoint `local`, and
`resolveRates()` settles it from `local.defaultRate` (`{0,0}` by default). The
per-call `>=1` cost floor turns that into **exactly 1 nominal usertoken per
call** — free inference stays *inside* budget, anomaly, and audit governance
instead of being exempted from it. For local OpenAI-compatible streams,
`stream_options: { include_usage: true }` is auto-injected so settlement uses
server-truth token counts (`usageSource: "provider"`).

The receipt carries the proof: `endpoint` (class/runtime), `meter.costBasis`
(`"nominal"` — never fake dollars), and `meter.rateSource` (`"local-default"`).

It also demos the **spoof defense**: `ollama cp llama3.2 gpt-4o` cannot buy
frontier billing — the *endpoint class*, not the model string, picks the
settlement regime.

## Run it

From a repo checkout (the script imports the workspace source directly — no
build step):

```sh
npm install
cd examples/ollama-local-governance
npx tsx run.ts
```

- **With Ollama running** on `localhost:11434`, the demo uses your first
  installed model (the spoof-defense call is skipped — a live Ollama 404s
  models it doesn't have).
- **Without Ollama**, it starts an inline mock OpenAI-compatible server
  (in `run.ts`, ~40 lines of `node:http`) that speaks the same shapes:
  `POST /v1/chat/completions` (stream + non-stream, usage chunk only when
  `include_usage` was requested) and `GET /v1/models`.

Everything runs in `dryRun` mode against throwaway temp vaults — no
TigerBeetle needed, nothing written to your project.

## Sample output (mock path)

```text
[BEFORE — v1.3 behavior: local.autoDetectLoopback: false]
  streamed "llama3.3:70b" (4 chunks):
    cost=615 ut  endpoint=cloud/unknown  meter=usd-proxy via fallback
    usageSource=estimated  budgetRemaining=499385
    → $0 inference billed 615 ut ($0.0615/call)
    → a $50 budget is exhausted after ~813 FREE streams

[AFTER — M2 default config]
  non-stream "llama3.3:70b":
    cost=1 ut  endpoint=local/openai-compat  meter=nominal via local-default
    usageSource=provider  budgetRemaining=499999
  streamed "llama3.3:70b" (include_usage injected):
    cost=1 ut  endpoint=local/openai-compat  meter=nominal via local-default
    usageSource=provider  budgetRemaining=499998
  spoofed model "gpt-4o" on the local endpoint:
    cost=1 ut  endpoint=local/openai-compat  meter=nominal via local-default
    usageSource=provider  budgetRemaining=499997

Showback: 3 calls, 510 real tokens metered, 3 ut nominal spend, $0.00 actual.
Free inference, fully governed.
```

(Against a live Ollama on port 11434 the runtime label is `ollama` and the
token counts are real.)

## Using it in your project

Loopback endpoints are classified automatically (`local.autoDetectLoopback`
defaults to `true`). For LAN GPU boxes, add explicit matchers; for
GPU-amortized showback, set per-model rates:

```jsonc
// .usertrust/usertrust.config.json
{
	"budget": 500000,
	"endpoints": [
		{ "match": "http://gpu-box:8000", "class": "local", "runtime": "vllm" },
		{ "match": "*.gpu.internal", "class": "local" }
	],
	"local": {
		"rateClass": "amortized-usd",
		"models": { "llama3.3*": { "inputPer1k": 0.2, "outputPer1k": 0.2 } }
	}
}
```

Or run `usertrust init` — the wizard's "Local inference" step writes the
endpoint entry and probes `GET /v1/models` for your installed models.

## Security posture

Endpoint classification (config matchers, overrides, loopback autodetect) is a
**trusted-operator decision** — never wire it to end-user or request input. In
server/multi-tenant deployments set `local.autoDetectLoopback: false` and
classify via explicit `endpoints[]` config: loopback inside a container can be
a forwarding sidecar to a paid API. A compromised local server can under-report
usage — receipts expose `usageSource` and `meter.rateSource` precisely so this
is auditable.
