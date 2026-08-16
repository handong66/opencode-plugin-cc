---
description: Show the stored final output for a finished opencode job in this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- The opencode session ID and the `opencode -s <session-id>` command when present
- Follow-up commands such as `/opencode:status <id>` and `/opencode:review`

Notes:
- `--wait` blocks until the job reaches a terminal state and then prints the same output, so a caller never has to hand-roll a polling loop. `--timeout-ms <ms>` bounds that wait (default 900000). A job whose process is gone reconciles to a terminal state and returns immediately.
- Feed scripts with `--json`, never with `tail -c`/`head -c` on the rendered text: slicing bytes breaks multi-byte characters and any JSON in the payload.
