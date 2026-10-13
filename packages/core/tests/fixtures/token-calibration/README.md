# Token calibration corpus

A fixed, synthetic corpus (no customer data) that `tests/govern/hold-estimate.test.ts`
uses to check the hold estimate against real token counts:
- `prose.txt`: English prose;
- `tool-schema.json.txt`: a JSON-dense tool schema;
- `cjk.txt`: CJK text;
- `code.ts.txt`: source code;
- `base64.txt`: a base64 payload.

No counts are recorded yet, so calibration is **unmeasured** for every provider. To add
one, record it from the provider's own counter, never from this estimator, as
`<corpus file>.<provider>.count.json`:

```json
{
  "provider": "anthropic",
  "model": "<model id>",
  "input": "prose.txt",
  "inputSha256": "<sha256 of the corpus file>",
  "countedTokens": 0,
  "counter": "<the provider API or tokenizer used, with its SDK version>",
  "recordedBy": "<who>",
  "recordedAt": "<ISO time>"
}
```

The test checks `inputSha256` against the corpus file and asserts that the estimate is
at least `countedTokens`. With no count files, it skips and says so.
