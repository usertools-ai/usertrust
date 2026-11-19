// PostToolUseFailure: a tool call that started and failed (a Bash command that exits non-zero,
// except the few that Claude Code reports as a result, which reach PostToolUse). Claude Code fires
// exactly one of PostToolUse and PostToolUseFailure per call, both with the call's `tool_use_id`
// and, in a subagent, its `agent_id`. The hold is settled the same way, so this runs
// post-tool-use.mjs; the failure's `error` text stands where a result's `tool_response` would.
import "./post-tool-use.mjs";
