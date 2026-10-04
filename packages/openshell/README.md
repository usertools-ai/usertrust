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
| `routes` | Which provider route a request is. **Default-deny** for every other route on a metered host. |
| `gate` | The request gate. It refuses the request shapes v1 does not meter, bounds input tokens conservatively, and prices the hold. An **unpriced model is denied**, never billed at a fallback rate. It also returns the request mutations. |
| `settle` | Classifies a response: void, settle at the hold (body unreadable), or which body mode to read. |
| `usage` | Incremental usage parsers for Anthropic and OpenAI, JSON and SSE. Their result does not depend on how the body is split into units. |
| `hold-key` | The deterministic hold key from `(sandbox_id, request_id)`. |
| `journal` | The hold journal: one SQLite file per host (`node:sqlite`, WAL). It is the compare-and-set store that gives each hold **exactly one** terminal state:<ul><li>a caller wins only when exactly one row changed;</li><li>a busy lock **throws** and is never reported as a lost claim;</li><li>a reservation reads the debt, checks the headroom, places the hold and records it in **one** transaction;</li><li>each debt change applies once per ledger transfer;</li><li>the sweeper has a work list for each of its jobs.</li></ul>Every write transaction also takes an in-process lock, because one can stay open across a ledger call. |
| `reasons` | Deny reason codes, checked against OpenShell's `^[a-z][a-z0-9_]{0,63}$`. |

## Spec gaps (decisions taken here, flagged for review)

- **No model maximum output.** The design holds a model's maximum output when a request sets no output limit, but core's pricing table has no such field. **Interim:** a request with no valid output limit is DENIED with `max_output_unbounded`. That's the only safe choice without a ceiling. A per-model maximum belongs in the pricing table.
- **No strict "is priced" check in core.** `getModelRates` silently falls back to a default rate. This slice adds core `isModelPriced` (the same lookup without the fallback), and an unpriced model is DENIED with `model_unpriced`. It is never billed at the fallback rate.
- **Per-image token maximums are conservative defaults, not measurements:** Anthropic 2,000, OpenAI 4,000. Both are configurable, and both should be measured per model.
- **Two reason codes beyond the design's list:**
  - `content_unsupported`: a content part or input item v1 cannot bound, such as audio, a base64 PDF or a provider-run tool call in history. It is denied by allowlist, like tools.
  - `max_output_unbounded`: above.
- **Inline documents:** only a `text`-source document is bounded by its bytes. A `file` or `url` source is provider context. A base64 PDF is billed per page, so it is denied (`content_unsupported`).
- **Known cases where the hold can be under the bill:** OpenAI `service_tier: "priority"` and Anthropic's long-context tier both price above the table's rates. A later slice will settle these to actual usage, with the excess debited to the budget's debt account. Each one is a counted finding, not a silent under-charge.
- **Split invariance** is checked exhaustively over every single cut point, every pair of cut points on a stride, and one-byte units, rather than with a property-testing dependency.
