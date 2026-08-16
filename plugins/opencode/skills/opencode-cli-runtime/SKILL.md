---
name: opencode-cli-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# opencode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"`

Invocation template (always set the Bash timeout explicitly):

```
Bash({
  command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"',
  timeout: 600000,
  description: "Delegate the rescue request to opencode"
})
```

For a long or open-ended rescue, detach instead of waiting:

```
Bash({
  command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"',
  run_in_background: true,
  description: "Delegate the rescue request to opencode in the background"
})
```

Timeout rules:
- opencode runs regularly take longer than two minutes (typical 2-6 minutes for read-only reviews on the plan agent), so the Claude Code default of 120000 ms cuts a large share of them off mid-run with `Exit code 143`.
- Always pass `timeout: 600000` on a foreground `task` call. Never rely on the default.
- `timeout` and `run_in_background` are Claude Code `Bash` parameters. They are never companion flags and must not appear in the companion command line.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct opencode CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `opencode:opencode-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `opencode-prompting` skill to rewrite the user's request into a tighter opencode prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--variant` unset unless the user explicitly requests a specific reasoning effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, as `provider/model` exactly as `opencode models` lists it.
- Default to a write-capable opencode run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the `provider/model` value through to `task`.
- If the forwarded request includes `--variant` (or the legacy `--effort`), pass it through to `task` (it maps to `opencode run --variant`).
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable opencode work in `opencode:opencode-rescue` unless the user explicitly asks for read-only behavior.
- Write-capable runs pass `--auto` to opencode (auto-approve permissions); the user opted into delegation by invoking rescue.
- Read-only runs use opencode's built-in `plan` agent, which cannot edit files.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or opencode cannot be invoked, return nothing.
