---
name: opencode-result-handling
description: Internal guidance for presenting opencode helper output back to the user
user-invocable: false
---

# opencode Result Handling

When the helper returns opencode output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If opencode marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If opencode made edits, say so explicitly and list the touched files when the helper provides them.
- Preserve the opencode session ID and the `opencode -s <session-id>` command so the user can continue the session inside opencode.
- For `opencode:opencode-rescue`, do not turn a failed or incomplete opencode run into a Claude-side implementation attempt. Report the failure and stop.
- For `opencode:opencode-rescue`, if opencode was never successfully invoked, do not generate a substitute answer at all.
- A single line of the form `OPENCODE_RESCUE_FAILED: <reason> | job=<id> | log=<path>` means the rescue subagent got no opencode answer. Report the reason and the job id to the user as-is; do not answer in opencode's place. If the id is real, `/opencode:status <id>` and `/opencode:result <id>` may still hold the run's output.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed opencode run, relay its `Next step (<failureClass>)` line and the stderr tail it printed, then stop instead of guessing.

Failure classes (`failureClass` on the job record and in `--json`; also rendered as `failed (<class>)`):
- `model_unauthorized` — the account may not use that model. Not retryable as-is: pick a granted model or drop `--model`.
- `model_not_found` — unknown model id, usually provider-prefix casing. opencode's own `Did you mean:` hint is in the stderr tail.
- `quota_exhausted` — provider balance or quota is gone. **Not** a plugin or prompt problem and **not** retryable; say so and let the user re-route to another provider rather than re-running.
- `auth_required` — no usable credentials. Send the user to `/opencode:setup` and `!opencode auth login`; never improvise an alternate auth flow.
- `provider_error` — server-side error. The only class worth one retry.
- `opencode_failed` — nothing recognisable. Report the stderr tail as-is.
- `timeout` / `interrupted` / `orphaned` are the companion's own labels (deadline hit, companion killed, process gone), not provider verdicts.
- A class is a reading aid derived from stderr text. It never changes whether the run passed or failed, so never present it as more certain than the stderr it came from.

Evidence behind a review verdict:
- `review` / `adversarial-review` report `evidenceLevel` (`none` | `thin` | `substantive`) next to the verdict and in `--json`. It is derived from how many tool calls the run made.
- `evidenceLevel: none` means the reviewer looked at nothing beyond the diff that was inlined into its prompt. Present such a verdict as what it is: an opinion on the diff text. An `approve` with no evidence is **no signal** — do not count it as a passing vote, and never report it to the user as "opencode approved the change" without that qualification.
- The helper prints a `no_evidence_review` warning in that case. Pass it on rather than dropping it.
- The same judgement is machine-readable as `resultComplete` in `--json` and in the stored payload: it is `false` for a zero-evidence review and for any run that did not finish, `true` only when the run completed *and* the verdict has evidence behind it. Key off that field rather than re-deriving it; `outputState` still describes the run itself, so a zero-evidence review is `outputState: "completed"` with `resultComplete: false`.

Feeding output to a script:
- Use `/opencode:result <id> --json` (whole payload) or `--structured-only` (just the review JSON object; exits 1 with the reason when the run produced none). Both are exact.
- Never slice the rendered text with `head -c` / `tail -c`. It breaks multi-byte characters and any JSON inside the payload — two recorded corruptions came from doing that while `--json` was available.
- There is no output cap and no truncation flag, deliberately. This helper's contract is that its output is relayed verbatim; adding a lossy limit would contradict it. If the output is too large for a caller, narrow the channel (`--json`, `--structured-only`, a specific field), not the content.

Job handles:
- The first line of `task`/`review` stdout is the handle, printed before opencode starts: `Job: <id> (<kind>, running) — poll with /opencode:status <id>`. With `--json` the same handle is a JSON line on stderr (`{"jobId":…,"logFile":…,"pollWith":…}`) so stdout stays one JSON document.
- Keep that id. It is the only handle for a run that was detached with `Bash(run_in_background: true)`, and it works while the run is still in flight: `status <id> --wait --timeout-ms <ms>` blocks until the job reaches a terminal state and `result <id> --wait` does the same and then prints the output. Never hand-roll a polling loop over the log file.

Incomplete runs (`outputState: incomplete`, job status `incomplete`, exit code 2):
- The helper prints `opencode stopped before producing a final answer (...)` when opencode exited cleanly without an answer: no text at all, a stop reason that is not a finished turn (for example `tool-calls`), or one line of narration after a batch of tool calls.
- Do NOT present the partial text as opencode's answer, and do NOT summarize it as if it were one. It is work-in-progress.
- Do NOT substitute your own answer for the missing one. Say that opencode did not produce a final answer, show the partial output as partial, and pass on the reason (`stopReason`) and the stderr lines the helper printed.
- Offer the recovery command the helper prints (`/opencode:rescue --resume ...`) so the same opencode session can be asked for the final answer only.
- Exit code 2 means incomplete, exit code 1 means the run failed; never read either as success.
- If the helper reports that setup or authentication is required, direct the user to `/opencode:setup` and do not improvise alternate auth flows.
