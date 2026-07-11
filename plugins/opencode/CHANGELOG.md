# Changelog

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
