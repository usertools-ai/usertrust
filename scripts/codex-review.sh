#!/usr/bin/env bash
set -euo pipefail

# codex-review.sh — Run Codex code review locally via OpenAI Responses API.
# Replaces the codex-review.yml GitHub Action (~3min) with a direct API call (~30s).
#
# Usage: scripts/codex-review.sh <PR-number>

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: codex-review.sh <PR-number>" >&2
  exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Error: OPENAI_API_KEY is not set." >&2
  exit 1
fi

# Resolve repo root (works from any subdirectory or worktree)
REPO_ROOT="$(git rev-parse --show-toplevel)"
PROMPT_FILE="$REPO_ROOT/.github/codex/prompts/review.md"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Error: Review prompt not found at $PROMPT_FILE" >&2
  exit 1
fi

# Create temp files and clean up on exit
TMPFILE="$(mktemp)"
BODY_FILE="$(mktemp)"
HEADERS_FILE="$(mktemp)"
COMMENT_FILE="$(mktemp)"
trap 'rm -f "$TMPFILE" "$BODY_FILE" "$HEADERS_FILE" "$COMMENT_FILE"' EXIT

# Write auth header to file — keeps API key out of process list
printf 'Authorization: Bearer %s' "$OPENAI_API_KEY" > "$HEADERS_FILE"

# Fetch PR diff
echo "Fetching diff for PR #${PR_NUMBER}..."
if ! DIFF="$(gh pr diff "$PR_NUMBER" 2>&1)"; then
  echo "Error: gh pr diff failed: $DIFF" >&2
  exit 1
fi

if [[ -z "$DIFF" ]]; then
  echo "Error: Empty diff for PR #${PR_NUMBER}. Does the PR exist?" >&2
  exit 1
fi

# Guard against oversized diffs (~400KB max)
DIFF_BYTES=$(printf '%s' "$DIFF" | wc -c | tr -d ' ')
MAX_DIFF=400000
if [[ "$DIFF_BYTES" -gt "$MAX_DIFF" ]]; then
  echo "Warning: Diff is ${DIFF_BYTES} bytes. Truncating to ${MAX_DIFF}." >&2
  DIFF="$(printf '%s' "$DIFF" | head -c "$MAX_DIFF")"
fi

# Read the review prompt
PROMPT="$(cat "$PROMPT_FILE")"

# Build JSON request body using python3 for safe encoding
python3 -c "
import json, sys

prompt = open(sys.argv[1]).read()
diff = sys.stdin.read()

body = {
    'model': 'gpt-5.3-codex',
    'input': [
        {'role': 'developer', 'content': prompt},
        {'role': 'user', 'content': 'Review this PR diff:\n\n' + diff}
    ]
}
json.dump(body, open(sys.argv[2], 'w'))
" "$PROMPT_FILE" "$TMPFILE" <<< "$DIFF"

# Call OpenAI Responses API
echo "Sending to Codex (gpt-5.3-codex)..."
START_TIME="$(date +%s)"

HTTP_CODE="$(curl -s \
  -o "$BODY_FILE" \
  -w "%{http_code}" \
  --connect-timeout 10 \
  --max-time 120 \
  https://api.openai.com/v1/responses \
  -H @"$HEADERS_FILE" \
  -H "Content-Type: application/json" \
  -d @"$TMPFILE")"

BODY="$(cat "$BODY_FILE")"

END_TIME="$(date +%s)"
ELAPSED=$(( END_TIME - START_TIME ))

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
  echo "Error: OpenAI API returned HTTP $HTTP_CODE" >&2
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY" >&2
  exit 1
fi

# Extract review text from Responses API output
REVIEW="$(echo "$BODY" | jq -r '
  [.output[] | select(.type == "message") | .content[] | select(.type == "text" or .type == "output_text") | .text]
  | first // empty
')"

if [[ -z "$REVIEW" ]]; then
  echo "Error: Could not extract review text from API response." >&2
  echo "$BODY" | jq . 2>/dev/null || echo "$BODY" >&2
  exit 1
fi

# Post review as PR comment (use --body-file to avoid shell expansion issues)
printf '## Codex Review (gpt-5.3-codex)\n\n%s' "$REVIEW" > "$COMMENT_FILE"
gh pr comment "$PR_NUMBER" --body-file "$COMMENT_FILE"

echo "Codex review completed in ${ELAPSED}s — posted to PR #${PR_NUMBER}."
