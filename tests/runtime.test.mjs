import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

test("setup --json reports a ready fake opencode", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["setup", "--json"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.opencodeAvailable, true);
  assert.equal(report.authenticated, true);
  assert.equal(report.version, "9.9.9-fake");
});

test("task --write runs opencode with --auto and stores a resumable job", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "answer from fake" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "do", "the", "thing"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.rawOutput, "answer from fake");
  assert.equal(payload.opencodeSessionId, "ses_fake0123456789");

  const runArgs = readRunArgs(fake);
  assert.ok(runArgs.includes("--auto"), `expected --auto in ${runArgs}`);
  assert.ok(!runArgs.includes("--agent"));
  assert.equal(runArgs[runArgs.indexOf("--") + 1], "do the thing");

  // status/result read the stored job back
  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  const { jobs } = JSON.parse(status.stdout);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");

  const stored = runCompanion(["result", jobs[0].id, "--json"], { env: fake.env, cwd });
  assert.equal(JSON.parse(stored.stdout).payload.rawOutput, "answer from fake");

  // State must land in the namespaced data dir, never in the decoy that
  // simulates another plugin having clobbered CLAUDE_PLUGIN_DATA.
  assert.ok(fs.readdirSync(fake.stateDir).length > 0, "namespaced data dir must hold state");
  assert.equal(fs.readdirSync(fake.decoyDir).length, 0, "clobbered CLAUDE_PLUGIN_DATA must stay untouched");

  // resume-last reuses the recorded session id
  const resumed = runCompanion(["task", "--json", "--write", "--resume-last", "continue"], { env: fake.env, cwd });
  assert.equal(JSON.parse(resumed.stdout).ok, true);
  const resumedArgs = readRunArgs(fake);
  assert.equal(resumedArgs[resumedArgs.indexOf("--session") + 1], "ses_fake0123456789");
});

test("task defaults to read-only via the plan agent", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["task", "--json", "diagnose", "only"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  const runArgs = readRunArgs(fake);
  assert.equal(runArgs[runArgs.indexOf("--agent") + 1], "plan");
  assert.ok(!runArgs.includes("--auto"));
});

test("review parses structured findings and stays read-only", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const result = runCompanion(["review", "--json"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.review.verdict, "needs-attention");
  assert.equal(payload.review.findings.length, 1);

  const runArgs = readRunArgs(fake);
  assert.equal(runArgs[runArgs.indexOf("--agent") + 1], "plan");
  const prompt = runArgs.at(-1);
  assert.match(prompt, /<output_schema>/);
  assert.match(prompt, /<system_rules>/);
  assert.match(prompt, /app\.mjs/, "review prompt should inline the untracked file");
});

test("failed runs surface stderr and a non-zero exit", () => {
  const fake = makeFakeEnv({ mode: "fail" });
  const result = runCompanion(["task", "--json", "--write", "explode"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.stderrTail, /fake provider exploded/);
});

test("silent runs (no events) are treated as failures", () => {
  const fake = makeFakeEnv({ mode: "silent" });
  const result = runCompanion(["task", "--json", "--write", "quiet"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
