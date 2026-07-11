---
description: Hand off the current Claude Code session into a resumable opencode session
argument-hint: "[--source <claude-jsonl>] [--model <provider/model>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the opencode session ID and the `opencode -s <session-id>` command.

Note for the user if they ask how it works: opencode cannot import Claude transcripts natively, so the transfer distills this session's conversation into a handoff prompt and seeds a fresh opencode session with it. That costs one opencode model turn.
