---
description: Show active and recent opencode jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--wait-timeout-ms <ms>] [--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

Automation rules:
- Scripts and agents must pass `--json`; human-readable output is not a machine interface.
- `--wait-timeout-ms` limits observation only. When it expires, `status --wait --json` exits 0 with `wait.expired:true` and the job keeps running.
- `--timeout-ms` is a deprecated alias for `--wait-timeout-ms` here and cannot be combined with it.
