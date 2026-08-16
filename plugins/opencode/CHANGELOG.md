# Changelog

## Unreleased — 0.2.0

- **Contract change.** Runs are now classified three ways instead of pass/fail. A run that exits 0 without producing an answer is `incomplete`, not `completed`: empty final text, a stop reason that is not a finished turn (`tool-calls`, `length`, `aborted`, …), or a very short final message after tool calls on a large prompt. `incomplete` runs exit with code **2** (failures keep 1), get the job status `incomplete`, and render through a dedicated renderer that labels the partial output as work-in-progress, prints the tail of stderr (which is where opencode reports auto-rejected paths), and gives a `/opencode:rescue --resume` recovery command. `task`/`review` `--json` now include `outputState`, `outputStateReason`, `stopReason` and `toolEventCount`; `status`/`result` detail show the output state and stop reason. Unknown stop reasons only warn on stderr — they never downgrade a run. The narration heuristic threshold is `OPENCODE_COMPANION_MIN_ANSWER_CHARS` (default 200).
- **Contract change.** Job records are reconciled against process liveness whenever they are read (`status`, `result`, `cancel`, the Stop and SessionEnd hooks). A `running`/`queued` record whose child pid is gone — or that never recorded one and has been untouched for longer than the 120s grace window — is rewritten as `failed` with `failureClass: "orphaned"`, an end timestamp, and elapsed time frozen at the last sign of life instead of growing forever. `status`/`result` render it as `failed (orphaned)` and point at the job log plus `/opencode:rescue --resume`; `status --wait` now returns as soon as a job reaches a terminal state instead of polling a dead record for the full 15 minutes. Reconciliation only relabels — killing processes stays with `cancel` and session teardown.
- `task` output now prints the last 5 lines of stderr on successful runs too, not only on failed and incomplete ones. opencode reports an auto-rejected read of a path outside the repo (`! permission requested: external_directory (/private/tmp/*); auto-rejecting`) on stderr and still exits 0, so the cause of a thin or missing answer used to be invisible to the caller — and Claude Code stages large prompts and material in `/private/tmp/claude-501/.../scratchpad` by default.
- Terminal job writes (`task`/`review` verdicts, `cancel`, session teardown) now clear `failureClass`, and a failure label is only ever rendered next to a `failed` status. Reconciliation runs from every reader, so a job could be relabelled `failed (orphaned)` while its own companion was still parsing the run; the record then ended up `completed` *and* `orphaned`, and `status`/`result` printed "the companion process for this job died" underneath a real answer. The child pid is also dropped as soon as opencode exits, so the parse-and-render window runs on the grace clock instead of pointing at a dead process.
- `saveState` now unions the caller's snapshot with what is on disk before deciding which jobs to prune, so a concurrent writer's job record, stored payload, and open log file can no longer be deleted by a companion holding a stale snapshot.
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
