#!/usr/bin/env node
// Emulates the opencode CLI surface the companion runtime touches, so the
// test suite runs without a real opencode install, credentials, or model calls.
// Behavior is steered by env vars:
//   OPENCODE_FAKE_MODE       success (default) | review-json | fail | silent
//                            | empty-text | narration | hang
//   OPENCODE_FAKE_TEXT       final answer text for success mode
//   OPENCODE_FAKE_STDERR     written to stderr before the run still exits 0
//   OPENCODE_FAKE_ARGS_FILE  when set, argv is dumped there as JSON
//   OPENCODE_FAKE_ORPHAN_RACE when set, relabels this run's own job record as
//                            failed/orphaned just before exiting, standing in
//                            for a concurrent reader reconciling it in the
//                            window between the child exiting and the
//                            companion writing its verdict

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const mode = process.env.OPENCODE_FAKE_MODE ?? "success";

// Any reader — `status --all`, the Stop hook, the caller's own `status --wait`
// poll — reconciles a `running` record whose pid is gone. This reproduces that
// write from inside the run, deterministically.
async function simulateConcurrentReconcile() {
  if (!process.env.OPENCODE_FAKE_ORPHAN_RACE) {
    return;
  }
  const stateModule = new URL("../plugins/opencode/scripts/lib/state.mjs", import.meta.url);
  const { listJobs, upsertJob } = await import(stateModule.href);
  const cwd = process.cwd();
  for (const job of listJobs(cwd, { reconcile: false })) {
    if (job.status !== "running" && job.status !== "queued") {
      continue;
    }
    upsertJob(cwd, {
      id: job.id,
      status: "failed",
      failureClass: "orphaned",
      endedAt: new Date().toISOString(),
      summary: "process exited without writing a result (companion was killed or the machine restarted)"
    });
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (args[0] === "--version") {
  process.stdout.write("9.9.9-fake\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "list") {
  const esc = String.fromCharCode(27);
  process.stdout.write(`${esc}[0m|  Credentials\n|  Fake ${esc}[90mapi\n\n└  1 credentials\n`);
  process.exit(0);
}

if (args[0] === "models") {
  process.stdout.write("fake/model-one\nfake/model-two\n");
  process.exit(0);
}

if (args[0] === "run") {
  if (process.env.OPENCODE_FAKE_ARGS_FILE) {
    fs.writeFileSync(process.env.OPENCODE_FAKE_ARGS_FILE, JSON.stringify(args, null, 2));
  }

  // opencode auto-rejects reads outside the repo on stderr and carries on to a
  // normal exit 0 — the shape PC3 is about.
  if (process.env.OPENCODE_FAKE_STDERR) {
    process.stderr.write(`${process.env.OPENCODE_FAKE_STDERR}\n`);
  }

  if (mode === "fail") {
    process.stderr.write("fake provider exploded: no such model\n");
    process.exit(1);
  }
  if (mode === "silent") {
    process.exit(0);
  }
  // `opencode run` has no timeout flag of its own, so a run that never returns
  // can only be bounded by the companion. Emit one event first so the stream is
  // parseable, then block until something kills the process group.
  if (mode === "hang") {
    const sessionID = "ses_fake0123456789";
    const messageID = "msg_fake0123456789";
    process.stdout.write(
      `${JSON.stringify({ type: "step_start", sessionID, part: { id: "prt_step1", messageID, sessionID } })}\n`
    );
    // With OPENCODE_FAKE_TEXT the run has already produced partial output when
    // it stalls — the shape P-ORPHAN's payload rescue is about.
    if (process.env.OPENCODE_FAKE_TEXT) {
      process.stdout.write(
        `${JSON.stringify({
          type: "text",
          sessionID,
          part: { id: "prt_text1", messageID, sessionID, type: "text", text: process.env.OPENCODE_FAKE_TEXT }
        })}\n`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 120_000));
    process.exit(0);
  }

  const sessionID = "ses_fake0123456789";
  const messageID = "msg_fake0123456789";
  const base = { sessionID };

  emit({ type: "step_start", timestamp: Date.now(), ...base, part: { id: "prt_step1", messageID, sessionID, type: "step-start" } });

  // Replays 2026-07-17T18:09:13 task-mrp9430w-jdg8lo: a clean stop with no text.
  if (mode === "empty-text") {
    emit({ type: "text", timestamp: Date.now(), ...base, part: { id: "prt_text1", messageID, sessionID, type: "text", text: "" } });
    emit({
      type: "step_finish",
      timestamp: Date.now(),
      ...base,
      part: { id: "prt_finish1", reason: "stop", messageID, sessionID, type: "step-finish" }
    });
    process.exit(0);
  }

  // Replays 2026-07-17T18:09:13 task-msvec27y-0h1jif: two minutes of tool calls,
  // one line of narration, stopReason tool-calls, and an auto-rejected read of a
  // path outside the repo on stderr.
  if (mode === "narration") {
    process.stderr.write("! permission requested: external_directory (/private/tmp/*); auto-rejecting\n");
    for (const [index, tool] of ["read", "read", "grep"].entries()) {
      const partId = `prt_tool${index}`;
      emit({ type: "tool", timestamp: Date.now(), ...base, part: { id: partId, messageID, sessionID, tool, state: { status: "running" } } });
      emit({ type: "tool", timestamp: Date.now(), ...base, part: { id: partId, messageID, sessionID, tool, state: { status: "completed" } } });
    }
    emit({
      type: "text",
      timestamp: Date.now(),
      ...base,
      part: { id: "prt_text1", messageID, sessionID, type: "text", text: "Parent contracts read. Now the source files." }
    });
    emit({
      type: "step_finish",
      timestamp: Date.now(),
      ...base,
      part: { id: "prt_finish1", reason: "tool-calls", messageID, sessionID, type: "step-finish" }
    });
    process.exit(0);
  }

  if (mode === "review-json") {
    const review = {
      verdict: "needs-attention",
      summary: "Fake review summary.",
      findings: [
        {
          severity: "high",
          title: "Fake finding",
          body: "Something looks wrong.",
          file: "src/app.mjs",
          line_start: 3,
          line_end: 4,
          confidence: 0.9,
          recommendation: "Fix it."
        }
      ],
      next_steps: ["Fix the fake finding."]
    };
    const text = "```json\n" + JSON.stringify(review, null, 2) + "\n```";
    emit({ type: "text", timestamp: Date.now(), ...base, part: { id: "prt_text1", messageID, sessionID, type: "text", text } });
  } else {
    const finalText = process.env.OPENCODE_FAKE_TEXT ?? "fake final answer";
    // Stream the same part twice to exercise last-payload-wins handling.
    emit({ type: "text", timestamp: Date.now(), ...base, part: { id: "prt_text1", messageID, sessionID, type: "text", text: finalText.slice(0, 4) } });
    emit({ type: "text", timestamp: Date.now(), ...base, part: { id: "prt_text1", messageID, sessionID, type: "text", text: finalText } });
  }

  emit({
    type: "step_finish",
    timestamp: Date.now(),
    ...base,
    part: {
      id: "prt_finish1",
      reason: "stop",
      messageID,
      sessionID,
      type: "step-finish",
      tokens: { total: 10, input: 8, output: 2, reasoning: 0, cache: { write: 0, read: 0 } },
      cost: 0
    }
  });
  await simulateConcurrentReconcile();
  process.exit(0);
}

process.stderr.write(`fake opencode: unhandled args ${JSON.stringify(args)}\n`);
process.exit(2);
