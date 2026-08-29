---
description: Show the stored final output for a finished opencode job in this repository
argument-hint: '[job-id] [--wait] [--wait-timeout-ms <ms>] [--json|--structured-only]'
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
- `--wait` observes until terminal state; `--wait-timeout-ms <ms>` bounds only observation (default 900000). On expiry the job keeps running, JSON reports `wait.expired:true`, and the command exits 1 because no result is available yet.
- Scripts and agents must pass `--json`. The schema-v2 document carries `jobId`, `job.terminal`, `job.resultComplete`, `wait`, `warnings[]`, and `nextAction`; stdout remains one JSON document.
- `--timeout-ms` is a deprecated alias for `--wait-timeout-ms` here and cannot be combined with it.
- Feed scripts with `--json`, never with `tail -c`/`head -c` on the rendered text: slicing bytes breaks multi-byte characters and any JSON in the payload. Two recorded payload corruptions (`SyntaxError: invalid character '\U0001F7E0'`, a failed `json.loads`) came from byte-slicing rendered prose while `--json` was available.
- `--structured-only` prints just the review JSON object for `review` / `adversarial-review` jobs, and exits 1 with the reason when the run never produced one — or when it did not finish, because an `incomplete` run has no verdict however well-formed its JSON is. The object is still in `--json` under `payload.structuredOutput` if you want it anyway. Use it when a script wants the verdict rather than the whole payload.
- There is no output cap and no truncation flag on purpose: this command exists to be relayed verbatim. If output is too large for the caller, take `--json` or `--structured-only`, or read specific fields — do not ask the plugin to lossily compress the thing you told it not to summarize.
