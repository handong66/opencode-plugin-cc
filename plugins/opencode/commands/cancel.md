---
description: Idempotently cancel an active persistent opencode job in this repository
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cancel "$ARGUMENTS"`

Scripts and agents must pass `--json`. The first successful cancellation and repeated cancellation both exit 0; a repeated call reports `changed:false` and never rewrites an existing terminal result. An unknown job id exits 1.
