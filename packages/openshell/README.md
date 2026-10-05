# usertrust-openshell

**Not published. Work in progress.**

A supervisor middleware for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell). It turns each LLM call a sandbox makes into a usertrust two-phase transaction:
1. estimate the cost;
2. place a hold;
3. allow or deny the call;
4. settle to actual usage from the response, with a hash-chained receipt.

The pure core, plus the hold journal. There is no network or ledger wiring yet:

| Module | What it does |
|---|---|
| `routes` | Which provider route a request is. **Default-deny** for every other route, and for every host the config does not name; a pass-through entry is pinned to its host. |
| `gate` | The request gate. It refuses the request shapes v1 does not meter, bounds input tokens conservatively, and prices the hold. An **unpriced model is denied**, never billed at a fallback rate. It also returns the request mutations. |
| `settle` | Classifies a response: void, settle at the hold (body unreadable), or which body mode to read. |
| `usage` | Incremental usage parsers for Anthropic and OpenAI, JSON and SSE. Their result does not depend on how the body is split into units. |
| `hold-key` | The deterministic hold key from `(sandbox_id, request_id)`. |
| `journal` | The hold journal: one SQLite file per host (`node:sqlite`, WAL). It is the compare-and-set store that gives each hold **exactly one** terminal state:<ul><li>a caller wins only when exactly one row changed;</li><li>a busy lock **throws** and is never reported as a lost claim;</li><li>a reservation reads the debt, checks the headroom, places the hold and records it in **one** transaction;</li><li>each debt change applies once per ledger transfer;</li><li>the sweeper has a work list for each of its jobs.</li></ul>Every write transaction also takes an in-process lock, and in-transaction operations check a per-transaction token, so a call from another request can never run inside an open transaction. A claim commits before any ledger call: `writeTx` takes a synchronous body. Only a reservation holds its transaction across a ledger call, and each such call has a deadline. Reads outside a transaction use a separate connection and see only committed rows. A reservation's ledger calls must use the transfer id derived from the hold id, so a retry after a lost commit can never place a second hold. A placement that fails may still have landed, so it is committed as `voiding` (the release path voids the derived id) rather than rolled back into an orphan. A placement must set a ledger-side timeout no later than the hold's `ttlAt`. A void that finds no transfer finalizes the hold only after `ttlAt` plus a grace, because an abandoned placement may still land; until then the hold stays in flight and is re-voided. A late settlement may finish from `expiring`: it and the sweeper's expiry race on one compare-and-set. |
| `reasons` | Deny reason codes, checked against OpenShell's `^[a-z][a-z0-9_]{0,63}$`. |

## Spec gaps (decisions taken here, flagged for review)

- **No model maximum output.** The design holds a model's maximum output when a request sets no output limit, but core's pricing table has no such field. **Interim:** a request with no valid output limit is DENIED with `max_output_unbounded`. That's the only safe choice without a ceiling. A per-model maximum belongs in the pricing table.
- **No strict "is priced" check in core.** `getModelRates` silently falls back to a default rate, and its PREFIX match prices a variant at its base's row (`o3-pro` at `o3`, `gpt-4o-2024-05-13` at `gpt-4o`, `gpt-5.4-pro` at `gpt-5.4`) — up to 10× under. This slice adds core `isModelPriced`, which is true only for an EXACT table entry or an operator `customRates` entry; anything else is DENIED with `model_unpriced`. It is never billed at the fallback rate or a prefix's rate. `getModelRates` itself is unchanged.
- **Image bounds** come from the providers' documented formulas, not measurements.
  - Anthropic: 4,784 visual tokens per image, the high-resolution tier's cap for Claude 4.7 and later. Older models cap at 1,568, so they are over-held.
  - OpenAI tile models: base + 8 tiles. gpt-4o and gpt-4.1 are 1,445; gpt-5 and gpt-5.1 are 1,190; o1 and o3 are 1,275.
  - Every other OpenAI model, including gpt-4o-mini (up to 48,169 per image) and the patch-based models: 73,800. That is the 30,000-patch limit × the largest documented multiplier (2.46).
  - All three are configurable (`imageTokenMax`, `imageTokenMaxByModel`).
- **Two reason codes beyond the design's list:**
  - `content_unsupported`: a content part or input item v1 cannot bound, such as audio, a base64 PDF or a provider-run tool call in history. It is denied by allowlist, like tools.
  - `max_output_unbounded`: above.
- **Inline documents:** only a `text`-source document is bounded by its bytes. A `file` or `url` source is provider context. A base64 PDF is billed per page, so it is denied (`content_unsupported`).
- **Tiers priced above standard are DENIED, not counted** (`pricing_tier_unsupported`). Settlement has no tier input, so an admitted priority call would settle at standard rates: an under-charge, not a finding.
  - Anthropic: `speed` other than `standard` (fast mode), and `inference_geo` other than `global` (US-only is 1.1×).
  - OpenAI: `service_tier` `priority`, `fast`, `ultrafast` or `scale`. An absent or `auto` tier means the project's configured tier, which the gate cannot see, so it is pinned to `default` in the forwarded body. `flex` is cheaper and passes.
- **Top-level fields are allowlisted per route** (`parameter_unsupported`). A field the route's list does not name is denied. So is a documented field whose billing v1 does not bound: Anthropic `fallbacks`, `compaction`, `context_management`, `diagnostics`; OpenAI `audio`, `prediction`, `moderation`, `prompt_cache_options`, `prompt_cache_retention`, `context_management`, `access_programs`.
- **Known under-holds, documented rather than bounded:**
  - **1-hour cache writes.** Anthropic's 1-hour cache writes bill above the table's 5-minute cache-write rate, and the hold prices the cache-write tier at the table's rate.
  - **Long context.** OpenAI bills input above 272K tokens at a higher long-context rate; the hold and the settlement both use the table's standard rate.
  - **Regional endpoints.** OpenAI regional and FedRAMP endpoints carry a 10% uplift. Only `api.openai.com` is routed by default; an operator adding a regional host takes this on.
- **The forwarded body is the gate's own parse, re-serialized.** The provider reads exactly the document the gate checked, so duplicate keys cannot be read two ways, and the input bound is counted on those forwarded bytes.
- **Tool overhead.** A request with tools adds the provider's tool-use system prompt: Anthropic 1,024 tokens, above the largest documented figure of 804. OpenAI documents no fixed overhead; function definitions are billed as input and bounded by their bytes.
- **Settlement uses the hold's rates.** The hold snapshots the `ModelRates` it was priced with, and settlement prices usage with that snapshot. Operator rates lowered between reserve and settle cannot settle the call below its hold's pricing.
- **An Anthropic stream needs its final usage.** A `message_stop` with no `message_delta` usage settles at the hold (`no-final-usage`), not on `message_start`'s counts.
- **Streams must finish.** A stream without its route's terminal event settles at the hold (`usage_unreadable`, `truncated`):
  - Anthropic `message_stop`;
  - OpenAI chat `data: [DONE]`, settling on the LAST usage before it (an upstream reporting running counts sends cumulative usage, so the first report would under-charge). `stream_options.continuous_usage_stats` is refused;
  - Responses `response.completed`, `.incomplete` or `.failed`. Responses settles on the terminal event's usage whenever that event carries one.
- **Split invariance** is checked exhaustively over every single cut point, every pair of cut points on a stride, and one-byte units, rather than with a property-testing dependency.
