# opencode plugin for Claude Code

Use [opencode](https://opencode.ai) from inside Claude Code for code reviews or to delegate tasks — a port of the official [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) to the opencode CLI.

Because opencode fronts many providers (Anthropic, OpenAI, Google, open-weight and free opencode zen models), this effectively lets Claude Code hand work to whichever second model you have configured in opencode.

Project write-up: [han-dong.link/en/work/opencode-plugin-cc](https://han-dong.link/en/work/opencode-plugin-cc)

## What You Get

- `/opencode:review` — a read-only opencode code review of local git changes, a commit range, or a file set, with structured findings
- `/opencode:adversarial-review` — a steerable challenge review that questions the design and its assumptions, bounded by a threat model you state
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

# Review a commit range, or just part of one; trailing text steers the focus
/opencode:review --base main
/opencode:review --base 71dcdc5..HEAD --paths docs,src check the migration order

# Challenge the design, with the system's actual exposure stated up front
/opencode:adversarial-review --threat-model "single-user local tool, no network exposure" is the retry logic safe under concurrent writers?

# Delegate a task (write-capable by default; picks your opencode default model)
/opencode:rescue figure out why the login test is flaky and fix it

# Choose a model or reasoning variant explicitly
/opencode:rescue --model anthropic/claude-sonnet-4-5 --variant high refactor the cache layer

# Continue the previous opencode session
/opencode:rescue --resume apply the top fix

# Long jobs: Claude Code detaches them, the companion always runs in the foreground
/opencode:rescue --background port the parser to TypeScript
/opencode:status                 # every job, with elapsed time
/opencode:status <id> --wait     # block until this one finishes
/opencode:result <id>            # the stored output, verbatim
/opencode:result <id> --json     # the same thing for a script
/opencode:cancel <id>

# Hand this session off to opencode (costs one opencode model turn)
/opencode:transfer
```

Every run prints its job id *before* opencode starts, so a detached run can be polled while it is still going, and every finished run prints the opencode session id, the model behind the answer, and `opencode -s <session-id>` to continue it inside opencode.

The model line distinguishes what was observed from what was predicted: `Model: <id>` when you passed `--model` or the run itself reported the model it used, and `Model (expected): <id>` when it was only read out of your opencode config (`~/.config/opencode/opencode.json[c]` plus any `opencode.json` in the repository, which overrides it). opencode resolves its own model, so an inferred id is a prediction and is labelled as one; `--json` carries `model`, `modelSource` and `modelCertainty` for callers that need to branch on it.

Exit codes: `0` a real answer, `1` the run failed, `2` the run finished without producing one.

### How long a run takes, and how to wait for one

`/opencode:status <id> --wait --timeout-ms <ms>` blocks until a job reaches a terminal state and returns the moment it does, so a generous deadline costs nothing when the run is quick; `/opencode:status --all --json` reports every job's `elapsedMs` and `resultComplete` in a single call, which is enough to fence on several jobs at once.

Budget the deadline against measured wall time rather than intuition: in the recorded corpus an opencode run finishes in a median of ~3 minutes, with a p90 near 5.5 minutes for read-only reviews on the `plan` agent — about 4x slower than the sibling Grok runtime. A 2-minute wait is below this runtime's median, and 16 of 19 recorded three-way aggregations ended up with an empty opencode slot whose answer arrived shortly after the decision had already been made. The same numbers are in `status --help`.

### Stop-time review gate

`/opencode:setup --enable-review-gate` makes opencode review every Claude turn that edited code before Claude is allowed to stop, blocking with concrete findings when something still needs fixing. It runs a full opencode turn on every stop — enable it only while actively monitoring a session, and disable it with `/opencode:setup --disable-review-gate`.

Three deliberate limits keep it from trapping you in a session you cannot leave:

- **It fails open.** Only an explicit `BLOCK:` verdict blocks, read from the review's own payload rather than from its exit status (a reviewer that reads the repo before deciding reports itself as incomplete, and that must not swallow a real block). If the review itself cannot complete — it could not be started, the deadline passed, no document to parse, no output, an answer in an unrecognised format — the stop is allowed and the reason is printed on stderr. Run `/opencode:review --wait` by hand when you see that.
- **It stands down after two consecutive blocks** in one session and tells you to fix the findings or disable it.
- **It skips the review entirely** when the working tree is clean and HEAD has not moved since the last stop, instead of paying for a model turn to be told there is nothing to review.

## How it works

All commands go through one helper runtime, `plugins/opencode/scripts/opencode-companion.mjs`, which wraps headless `opencode run --format json`:

- **Jobs**: every run is tracked in per-workspace state under this plugin's own data directory (`OPENCODE_COMPANION_DATA_DIR`, never the shared `CLAUDE_PLUGIN_DATA`), so status/result/cancel work across foreground, background and Claude sessions. Writes are serialised and atomic; a record whose process is gone is relabelled instead of counting up forever; session-end hooks terminate still-running jobs.
- **Read-only vs write**: read-only runs (reviews, plain rescue diagnosis) use opencode's built-in `plan` agent, which cannot edit files. Write-capable runs (`task --write`, the rescue default) pass `--auto` so opencode can act without interactive permission prompts. Because the `plan` agent may carry its own model in your opencode config, every run reports the model behind its answer — observed when the run or your `--model` says what it was, marked `(expected)` when it was inferred from config.
- **Three outcomes, not two**: exiting 0 is not a verdict. A run that produces no final text, stops for a reason that is not a finished turn, or answers a review with something that is not a review, is reported as `incomplete` with its partial output labelled as partial — never as a completed answer.
- **Structured reviews**: the review prompts embed a JSON schema contract, and the companion validates the model's final answer against it before rendering a verdict, falling back to the raw output rather than synthesising one from a malformed object.
- **Transfer**: opencode cannot import Claude transcripts natively, so `transfer` distills the Claude session transcript into a handoff prompt and seeds a fresh opencode session with it.

## Development

```bash
npm test
```

Tests use `node:test` and a fake `opencode` fixture on PATH — no real model calls, no credentials needed. Changes to the runtime contract are recorded in [plugins/opencode/CHANGELOG.md](plugins/opencode/CHANGELOG.md).

## License

Apache-2.0. This project is a derivative work modeled on the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) (Copyright OpenAI, Apache-2.0); see [NOTICE](NOTICE). Not affiliated with Anomaly Innovations (opencode) or OpenAI.
