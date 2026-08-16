---
name: opencode-cli-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# opencode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task [flags] -- <prompt>`
- or, for any prompt containing quotes, backticks, angle brackets, pipes or newlines: `task [flags] --prompt-file <path>`

Prompt form rules:
- Everything after `--` is passed to opencode byte for byte. Everything *before* it is tokenized, which drops quote characters, swallows text after an apostrophe, and folds newlines into spaces.
- Never put the prompt before `--`. That older form silently corrupted multi-line and quoted review contracts.
- When the prompt contains characters the shell also interprets (`"`, `'`, `` ` ``, `<`, `>`, `|`, `*`, `[`, `]`), write it to a file first and pass `--prompt-file <path>`. That is the only form that survives both the shell and the companion. `--prompt-stdin` is the equivalent for piped input.

Invocation template (always set the Bash timeout explicitly):

```
Bash({
  command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --write -- <prompt>',
  timeout: 600000,
  description: "Delegate the rescue request to opencode"
})
```

For a long or open-ended rescue, detach instead of waiting:

```
Bash({
  command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --write --prompt-file /path/to/prompt.md',
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
- Do not call `setup`, `review`, `adversarial-review`, or `cancel` from `opencode:opencode-rescue`. `status` and `result` are allowed only under the recovery rules below, and only for the job this subagent just submitted.
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
- If the forwarded request includes `--resume-session <ses_id>`, strip both tokens from the task text and pass `--resume-session <ses_id>` to `task` unchanged. This continues exactly that session; use it in preference to `--resume-last` whenever an id is given.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`. `--resume-last` continues the newest resumable *task* session in this repository — completed, incomplete or failed, never a cancelled or orphaned one — and the companion prints which one it picked.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable opencode work in `opencode:opencode-rescue` unless the user explicitly asks for read-only behavior.
- Write-capable runs pass `--auto` to opencode (auto-approve permissions); the user opted into delegation by invoking rescue.
- Read-only runs use opencode's built-in `plan` agent, which cannot edit files.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.

Failure and recovery — the only follow-up work this subagent may do:
- Never write your own answer, never analyse the problem yourself, never retry with a different prompt, and never change the repository. Those bans are absolute and are not relaxed by any failure.
- Keep the job handle. The first line of `task` stdout is `Job: <id> (task, running) — poll with /opencode:status <id>` (with `--json` it is a JSON line on stderr), printed before the run starts, so it exists even when the run is later killed.
- If the `Bash` call fails, is killed by a timeout, or was detached and therefore returned no answer, you may retrieve the result of **that job id and no other**: at most one `status <id> --wait --timeout-ms <ms>`, or at most three plain `status <id>` calls, plus at most one `result <id>`. Return that stdout verbatim.
- If there is still no opencode output, return exactly one line and nothing else:
  `OPENCODE_RESCUE_FAILED: <reason> | job=<id or unknown> | log=<log path or unknown>`
- Never return an empty response. Silence is indistinguishable from a silent success, and it throws away the handle the caller needs to recover the run — 6 of 13 recorded rescue dispatches came back with no opencode answer at all while the job itself had completed.
