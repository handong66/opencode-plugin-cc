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
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed opencode run, include the most actionable stderr lines and stop there instead of guessing.

Incomplete runs (`outputState: incomplete`, job status `incomplete`, exit code 2):
- The helper prints `opencode stopped before producing a final answer (...)` when opencode exited cleanly without an answer: no text at all, a stop reason that is not a finished turn (for example `tool-calls`), or one line of narration after a batch of tool calls.
- Do NOT present the partial text as opencode's answer, and do NOT summarize it as if it were one. It is work-in-progress.
- Do NOT substitute your own answer for the missing one. Say that opencode did not produce a final answer, show the partial output as partial, and pass on the reason (`stopReason`) and the stderr lines the helper printed.
- Offer the recovery command the helper prints (`/opencode:rescue --resume ...`) so the same opencode session can be asked for the final answer only.
- Exit code 2 means incomplete, exit code 1 means the run failed; never read either as success.
- If the helper reports that setup or authentication is required, direct the user to `/opencode:setup` and do not improvise alternate auth flows.
