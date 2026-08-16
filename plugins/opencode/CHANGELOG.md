# Changelog

## Unreleased — 0.2.0

- **Contract change.** Runs are now classified three ways instead of pass/fail. A run that exits 0 without producing an answer is `incomplete`, not `completed`: empty final text, a stop reason that is not a finished turn (`tool-calls`, `length`, `aborted`, …), or a very short final message after tool calls on a large prompt. `incomplete` runs exit with code **2** (failures keep 1), get the job status `incomplete`, and render through a dedicated renderer that labels the partial output as work-in-progress, prints the tail of stderr (which is where opencode reports auto-rejected paths), and gives a `/opencode:rescue --resume` recovery command. `task`/`review` `--json` now include `outputState`, `outputStateReason`, `stopReason` and `toolEventCount`; `status`/`result` detail show the output state and stop reason. Unknown stop reasons only warn on stderr — they never downgrade a run. The narration heuristic threshold is `OPENCODE_COMPANION_MIN_ANSWER_CHARS` (default 200).
- Rescue docs (`skills/opencode-cli-runtime/SKILL.md`, `agents/opencode-rescue.md`) now ship explicit `Bash` invocation templates with `timeout: 600000` and a `run_in_background: true` variant for long runs. Forwarders previously inherited Claude Code's 120s default, which killed 16% of `task` calls with `Exit code 143` mid-run.

## 0.1.1

- State resolution now uses the namespaced `OPENCODE_COMPANION_DATA_DIR` env var instead of trusting `CLAUDE_PLUGIN_DATA` from the shared session env, where the last plugin's SessionStart hook to run wins (e.g. the Codex plugin exports it too). Fixes job state landing in another plugin's data directory.

## 0.1.0

Initial release, ported from the Codex plugin for Claude Code (and its Grok port) to the opencode CLI.

- `/opencode:rescue` task delegation with resume, model/variant selection, and background jobs
- `/opencode:review` and `/opencode:adversarial-review` with structured JSON findings
- `/opencode:status`, `/opencode:result`, `/opencode:cancel` job management
- `/opencode:transfer` Claude-session handoff into a seeded opencode session
- `/opencode:setup` readiness report and optional stop-time review gate (Stop hook)
- Session lifecycle hooks that expose the Claude session to the runtime and tear down orphaned jobs
