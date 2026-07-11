import assert from "node:assert/strict";
import { test } from "node:test";

import { renderReviewOutput, renderTaskOutput, firstLine, fmtDuration } from "../plugins/opencode/scripts/lib/render.mjs";

const job = {
  id: "review-x",
  kind: "review",
  status: "completed",
  durationMs: 65_000,
  opencodeSessionId: "ses_render"
};

test("renderReviewOutput orders findings by severity and keeps the session hint", () => {
  const rendered = renderReviewOutput(job, {
    structuredOutput: {
      verdict: "needs-attention",
      summary: "Two problems.",
      findings: [
        { severity: "low", title: "Nit", body: "b", file: "a.js", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "r" },
        { severity: "critical", title: "Boom", body: "b", file: "b.js", line_start: 2, line_end: 3, confidence: 0.9, recommendation: "r" }
      ],
      next_steps: ["fix Boom"]
    }
  });
  assert.match(rendered, /Verdict: NEEDS ATTENTION/);
  assert.ok(rendered.indexOf("Boom") < rendered.indexOf("Nit"), "critical must render before low");
  assert.match(rendered, /b\.js:2-3/);
  assert.match(rendered, /opencode -s ses_render/);
});

test("renderReviewOutput falls back to raw output when schema parsing failed", () => {
  const rendered = renderReviewOutput(job, { structuredOutput: null, rawOutput: "free-form review text" });
  assert.match(rendered, /did not match the expected schema/);
  assert.match(rendered, /free-form review text/);
});

test("renderTaskOutput appends the job footer", () => {
  const rendered = renderTaskOutput(job, { rawOutput: "did the thing" });
  assert.match(rendered, /did the thing/);
  assert.match(rendered, /Job: review-x \(review, completed, 1m05s\)/);
});

test("format helpers behave", () => {
  assert.equal(fmtDuration(2_000), "2s");
  assert.equal(fmtDuration(Number.NaN), "-");
  assert.equal(firstLine("one\ntwo"), "one");
});
