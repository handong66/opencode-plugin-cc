# opencode plugin for Claude Code

Use [opencode](https://opencode.ai) from inside Claude Code for code reviews or to delegate tasks — a port of the official [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) to the opencode CLI.

Because opencode fronts many providers (Anthropic, OpenAI, Google, open-weight and free opencode zen models), this effectively lets Claude Code hand work to whichever second model you have configured in opencode.

## What You Get

- `/opencode:review` — a read-only opencode code review of your local git changes, with structured findings
- `/opencode:adversarial-review` — a steerable challenge review that attacks the design and assumptions
- `/opencode:rescue` — delegate investigation, debugging, or a full implementation task to opencode (write-capable by default, resumable)
- `/opencode:transfer` — hand this Claude Code session off into a resumable opencode session
- `/opencode:status`, `/opencode:result`, `/opencode:cancel` — manage background jobs
- `/opencode:setup` — readiness check, plus an optional stop-time review gate where opencode reviews every Claude turn that edited code

## Requirements

- **opencode CLI** ≥ 1.x on your PATH (`opencode --version` to check). Tested against 1.17.x.
- **A provider configured in opencode** (`opencode auth login`). Free opencode zen models work without credentials; runs use whatever provider/model your opencode is set up for and count against that provider's usage.
- **Node.js 20 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add handong66/opencode-plugin-cc
```

or from a local checkout:

```bash
/plugin marketplace add /path/to/opencode-plugin-cc
```

Install the plugin:

```bash
/plugin install opencode@opencode-plugin-cc
```

Reload plugins (`/reload-plugins`), then run:

```bash
/opencode:setup
```

`/opencode:setup` tells you whether the opencode CLI is ready. If opencode is missing, install it yourself with one of:

```bash
npm i -g opencode-ai
curl -fsSL https://opencode.ai/install | bash
```

If opencode has no stored credentials yet, run:

```bash
!opencode auth login
```

## Usage

```bash
# Read-only review of uncommitted changes (structured verdict + findings)
/opencode:review

# Review the branch against a base ref
/opencode:review --base main

# Challenge the design; extra text steers the focus
/opencode:adversarial-review is the retry logic safe under concurrent writers?

# Delegate a task (write-capable by default; picks your opencode default model)
/opencode:rescue figure out why the login test is flaky and fix it

# Choose a model or reasoning variant explicitly
/opencode:rescue --model anthropic/claude-sonnet-4-5 --variant high refactor the cache layer

# Continue the previous opencode session
/opencode:rescue --resume apply the top fix

# Background jobs
/opencode:rescue --background port the parser to TypeScript
/opencode:status
/opencode:result
/opencode:cancel

# Hand this session off to opencode (costs one opencode model turn)
/opencode:transfer
```

Every finished run prints the opencode session id; continue it directly in opencode with `opencode -s <session-id>`.

### Stop-time review gate

`/opencode:setup --enable-review-gate` makes opencode review every Claude turn that edited code before Claude is allowed to stop, blocking with concrete findings when something still needs fixing. It runs a full opencode turn on every stop — enable it only while actively monitoring a session, and disable it with `/opencode:setup --disable-review-gate`.

## How it works

All commands go through one helper runtime, `plugins/opencode/scripts/opencode-companion.mjs`, which wraps headless `opencode run --format json`:

- **Jobs**: every run is tracked in per-workspace state (under Claude's plugin-data dir), so status/result/cancel work across foreground, background, and even across Claude sessions. Session-end hooks terminate any still-running jobs.
- **Read-only vs write**: read-only runs (reviews, plain rescue diagnosis) use opencode's built-in `plan` agent, which cannot edit files. Write-capable runs (`task --write`, the rescue default) pass `--auto` so opencode can act without interactive permission prompts.
- **Structured reviews**: the review prompts embed a JSON schema contract; the companion parses the model's final answer into verdict/findings/next-steps, falling back to raw output when a model refuses to cooperate.
- **Transfer**: opencode cannot import Claude transcripts natively, so `transfer` distills the Claude session transcript into a handoff prompt and seeds a fresh opencode session with it.

## Development

```bash
npm test
```

Tests use `node:test` and a fake `opencode` fixture on PATH — no real model calls, no credentials needed.

## License

Apache-2.0. This project is a derivative work modeled on the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) (Copyright OpenAI, Apache-2.0); see [NOTICE](NOTICE). Not affiliated with Anomaly Innovations (opencode) or OpenAI.
