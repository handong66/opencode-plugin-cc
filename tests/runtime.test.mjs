import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

const STATE_MODULE = path.join(REPO_ROOT, "plugins", "opencode", "scripts", "lib", "state.mjs");

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

// P-COMPLETE: exit code 0 is not a verdict. Two recorded failure shapes —
// "no final output" (2026-07-17) and one line of narration after tool calls
// (2026-08-16) — must land on `incomplete`, never on `completed`.
test("empty answers are reported as incomplete, not completed", () => {
  const fake = makeFakeEnv({ mode: "empty-text" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "summarise the contracts"], { env: fake.env, cwd });
  assert.equal(result.status, 2, `incomplete runs must exit 2, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "empty-text");

  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  const { jobs } = JSON.parse(status.stdout);
  assert.equal(jobs[0].status, "incomplete");
  assert.equal(jobs[0].outputState, "incomplete");

  // The stored result must be reachable and must not read like an answer.
  const stored = runCompanion(["result", jobs[0].id], { env: fake.env, cwd });
  assert.match(stored.stdout, /stopped before producing a final answer/);
  assert.doesNotMatch(stored.stdout, /\[opencode returned no final output\]/);
  assert.match(stored.stdout, /Recover with: \/opencode:rescue --resume/);
});

test("narration after tool calls is incomplete and keeps the partial output plus stderr", () => {
  const fake = makeFakeEnv({ mode: "narration" });
  const cwd = makeTempGitRepo();
  const prompt = `<task>\n${"Review the parent contracts in detail. ".repeat(60)}\n</task>`;

  const result = runCompanion(["task", "--json", "--read-only", prompt], { env: fake.env, cwd });
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "stop-reason");
  assert.equal(payload.stopReason, "tool-calls");
  assert.equal(payload.toolEventCount, 3);
  assert.equal(payload.rawOutput, "Parent contracts read. Now the source files.");

  const rendered = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(rendered, /stopReason: tool-calls, 3 tool calls/);
  assert.match(rendered, /Parent contracts read\. Now the source files\./);
  assert.match(rendered, /external_directory/, "the auto-rejected path must be visible");
  assert.match(rendered, /incomplete/);
});

// P-LIVENESS: a companion killed mid-run (Bash timeout, SIGTERM) never writes a
// terminal state, so its record used to read `running` forever — one was still
// counting at 201 minutes three hours after its process had exited.
test("status stops reporting a job as running once its process is gone", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  // A finished run first, so the store has a live-looking neighbour record.
  runCompanion(["task", "--json", "--write", "warm up the store"], { env: fake.env, cwd });

  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const orphanScript = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: "task-orphan-e2e",
      kind: "task",
      status: "running",
      cwd: ${JSON.stringify(cwd)},
      childPid: ${dead.pid},
      promptPreview: "you are the director verification rehearsal",
      startedAt: new Date(Date.now() - 201 * 60 * 1000).toISOString()
    });
  `;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", orphanScript], {
    env: fake.env,
    encoding: "utf8"
  });
  assert.equal(seeded.status, 0, seeded.stderr);

  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  const orphan = JSON.parse(status.stdout).jobs.find((job) => job.id === "task-orphan-e2e");
  assert.equal(orphan.status, "failed");
  assert.equal(orphan.failureClass, "orphaned");

  const table = runCompanion(["status", "--all"], { env: fake.env, cwd }).stdout;
  assert.match(table, /task-orphan-e2e \| task \| failed \(orphaned\)/);
  assert.doesNotMatch(table, /task-orphan-e2e \| task \| running/);

  const detail = runCompanion(["status", "task-orphan-e2e"], { env: fake.env, cwd }).stdout;
  assert.match(detail, /Status: failed \(orphaned\)/);
  assert.match(detail, /\/opencode:rescue --resume/);

  // `--wait` must return at once instead of burning the whole 15-minute budget
  // re-reading a record that can never change again.
  const startedAt = Date.now();
  const waited = runCompanion(["status", "task-orphan-e2e", "--wait", "--json"], { env: fake.env, cwd });
  assert.equal(JSON.parse(waited.stdout).job.status, "failed");
  assert.ok(Date.now() - startedAt < 10_000, "status --wait must not poll a dead job");

  const cancelled = runCompanion(["cancel", "task-orphan-e2e"], { env: fake.env, cwd });
  assert.match(cancelled.stdout, /already failed \(orphaned\); nothing to cancel/);

  // The completed neighbour keeps its own verdict.
  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs.filter((job) => job.status === "completed").length, 1);
});

test("silent runs (no events) are treated as failures", () => {
  const fake = makeFakeEnv({ mode: "silent" });
  const result = runCompanion(["task", "--json", "--write", "quiet"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
