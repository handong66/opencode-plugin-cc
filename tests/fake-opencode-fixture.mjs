#!/usr/bin/env node
// Emulates the opencode CLI surface the companion runtime touches, so the
// test suite runs without a real opencode install, credentials, or model calls.
// Behavior is steered by env vars:
//   OPENCODE_FAKE_MODE       success (default) | review-json | fail | silent
//   OPENCODE_FAKE_TEXT       final answer text for success mode
//   OPENCODE_FAKE_ARGS_FILE  when set, argv is dumped there as JSON

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const mode = process.env.OPENCODE_FAKE_MODE ?? "success";

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

  if (mode === "fail") {
    process.stderr.write("fake provider exploded: no such model\n");
    process.exit(1);
  }
  if (mode === "silent") {
    process.exit(0);
  }

  const sessionID = "ses_fake0123456789";
  const messageID = "msg_fake0123456789";
  const base = { sessionID };

  emit({ type: "step_start", timestamp: Date.now(), ...base, part: { id: "prt_step1", messageID, sessionID, type: "step-start" } });

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
  process.exit(0);
}

process.stderr.write(`fake opencode: unhandled args ${JSON.stringify(args)}\n`);
process.exit(2);
