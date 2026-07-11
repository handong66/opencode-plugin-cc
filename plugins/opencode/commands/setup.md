---
description: Check whether the local opencode CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- If the result says the opencode CLI is unavailable, tell the user to install opencode so the `opencode` binary is on PATH (`npm i -g opencode-ai`, `brew install anomalyco/tap/opencode`, or `curl -fsSL https://opencode.ai/install | bash` — see https://opencode.ai/docs for details), then rerun `/opencode:setup`. Do not attempt to install it yourself.
- If opencode is installed but has no stored provider credentials, preserve the guidance to run `!opencode auth login`, and mention that free opencode zen models may work without credentials.
- If the user toggled the review gate, confirm its new state explicitly.
- When enabling the review gate, warn the user: the gate runs an opencode review on every stop and can create a long-running Claude/opencode loop that drains usage limits quickly. It should only stay enabled while they actively monitor the session.
