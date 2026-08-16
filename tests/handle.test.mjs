import assert from "node:assert/strict";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// PC1: the job id only ever appeared in the footer *after* the run, so a caller
// who detached the companion with Bash(run_in_background: true) — 28 recorded
// times — had no handle to poll while the run was in flight, and hand-rolled
// shadow job control (`seq 1 240` loops, grep on log files) instead.
test("task prints its job handle before the run starts", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "the answer" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);

  const [firstLine] = result.stdout.split("\n");
  const match = firstLine.match(/^Job: (\S+) \(task, running\) — poll with \/opencode:status \1$/);
  assert.ok(match, `expected a handle line first, got: ${firstLine}`);
  assert.match(result.stdout, new RegExp(`Job: ${match[1]} \\(task, completed`), "same id in the footer");
});

test("--json keeps stdout a single document and puts the handle on stderr", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "the answer" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  const handleLine = result.stderr.split("\n").find((line) => line.startsWith("{"));
  const handle = JSON.parse(handleLine);
  assert.equal(handle.jobId, payload.jobId);
  assert.equal(handle.pollWith, `/opencode:status ${payload.jobId}`);
  assert.match(handle.logFile, /\.log$/);
});

// The same contract on the path that does no work: `--resume-last` in a
// repository that has never run a job. The success branch was routed to stderr
// when the handle went there; this one kept printing a sentence to stdout ahead
// of the payload, so JSON.parse failed on the most ordinary state there is.
test("--json stays a single parseable document when there is nothing to resume", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "the answer" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--resume-last", "--", "hello world"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resumedFrom, null, "there was no session to resume");
  assert.equal(payload.outputState, "completed", "and the run itself still happened");
  assert.doesNotMatch(result.stdout, /No previous opencode session/, "the notice must not precede the JSON");
  assert.match(result.stderr, /No previous opencode session found for this repository/, "but it is still reported");
});

test("review announces its handle too", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const result = runCompanion(["review"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split("\n")[0], /^Job: \S+ \(review, running\)/);
});
