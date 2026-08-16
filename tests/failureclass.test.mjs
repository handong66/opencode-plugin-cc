import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { classifyFailure, FAILURE_CLASS_GUIDANCE } from "../plugins/opencode/scripts/lib/opencodecli.mjs";
import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// P-MODEL: opencode reports *why* it could not run on stderr, and the caller
// used to get 15 undifferentiated lines of it. Misclassification must never
// change the pass/fail verdict — only the next step printed above the tail.
test("classifyFailure names the recoverable classes and falls back safely", () => {
  const cases = [
    ["AI_APICallError: 403 not authorized to access the requested model", "model_unauthorized"],
    ["Error: Model not found: AIHubMix/gpt-5. Did you mean: aihubmix/gpt-5?", "model_not_found"],
    ["402 payment required: your credit balance is insufficient", "quota_exhausted"],
    ["401 unauthorized: no credentials found for provider anthropic", "auth_required"],
    ["Unexpected server error (500) from provider", "provider_error"],
    ["something nobody has ever seen before", "opencode_failed"],
    ["", "opencode_failed"]
  ];
  for (const [stderrTail, expected] of cases) {
    assert.equal(classifyFailure({ exitCode: 1, stderrTail }), expected, stderrTail);
    assert.ok(FAILURE_CLASS_GUIDANCE[expected], `${expected} needs a next step`);
  }

  // A run that did not fail has no failure class at all.
  assert.equal(classifyFailure({ exitCode: 0, stderrTail: "403 not authorized" }), null);
  // A spawn failure is about the binary, not the provider.
  assert.equal(classifyFailure({ exitCode: null, spawnError: "ENOENT", stderrTail: "" }), "opencode_failed");
});

test("a quota failure is reported as unretryable instead of as raw stderr", () => {
  const fake = makeFakeEnv({
    mode: "fail",
    extra: {
      OPENCODE_FAKE_STDERR:
        "AI_APICallError: 402 Payment Required — your credit balance is insufficient for this request"
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "summarise the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /provider balance or quota is exhausted/i);
  assert.match(result.stdout, /not a plugin or prompt problem/i);
  // The raw tail stays exactly where it was — the class only adds a line above it.
  assert.match(result.stdout, /Most recent stderr:/);
  assert.match(result.stdout, /402 Payment Required/);
  assert.ok(
    result.stdout.indexOf("quota") < result.stdout.indexOf("Most recent stderr:"),
    "the next step must come before the stderr block"
  );

  const jsonResult = runCompanion(["task", "--json", "--", "summarise the diff"], { env: fake.env, cwd });
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.failureClass, "quota_exhausted");

  // And it is on the job record, so `status`/`result` say the same thing later.
  const stateFile = fs
    .readdirSync(path.join(fake.stateDir, "state"))
    .map((entry) => path.join(fake.stateDir, "state", entry, "state.json"))
    .find((candidate) => fs.existsSync(candidate));
  const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.ok(
    jobs.every((job) => job.failureClass === "quota_exhausted"),
    JSON.stringify(jobs.map((job) => [job.id, job.status, job.failureClass]))
  );
  assert.ok(jobs.every((job) => job.status === "failed"));
});

test("an unauthorized model failure keeps the verdict and adds the next step", () => {
  const fake = makeFakeEnv({
    mode: "fail",
    extra: { OPENCODE_FAKE_STDERR: "403 not authorized to access the requested model" }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--", "summarise the diff"], { env: fake.env, cwd });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, "model_unauthorized");
  assert.equal(payload.ok, false);
  assert.equal(payload.outputState, "failed");
  assert.equal(result.status, 1);
});
