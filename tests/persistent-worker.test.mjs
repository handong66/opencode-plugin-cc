import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

const SESSION_HOOK = path.join(REPO_ROOT, "plugins", "opencode", "scripts", "session-lifecycle-hook.mjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(fake, cwd, jobId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runCompanion(["status", jobId, "--json"], { env: fake.env, cwd });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    if (payload.job?.terminal) return payload;
    await sleep(100);
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

test("task --background returns a v2 handle and the detached worker completes later", async () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "persistent answer" } });
  const cwd = makeTempGitRepo();

  const startedAt = Date.now();
  const submitted = runCompanion(
    ["task", "--background", "--json", "--write", "--", "finish after the submitter exits"],
    { env: fake.env, cwd }
  );

  assert.equal(submitted.status, 0, submitted.stderr);
  assert.ok(Date.now() - startedAt < 5_000, "background submission must not wait for provider completion");
  const handle = JSON.parse(submitted.stdout);
  assert.equal(handle.schemaVersion, 2);
  assert.match(handle.jobId, /^task-/);
  assert.equal(handle.job.status === "queued" || handle.job.status === "running", true);
  assert.equal(handle.job.terminal, false);
  assert.equal(handle.job.killAfterMs, 900_000);
  assert.equal(handle.wait.requested, false);
  assert.equal(handle.wait.expired, false);
  assert.match(handle.nextAction.result, new RegExp(handle.jobId));

  const terminal = await waitForTerminal(fake, cwd, handle.jobId);
  assert.equal(terminal.job.status, "completed");
  assert.equal(terminal.job.terminal, true);
  assert.equal(terminal.resultComplete, true);

  const result = runCompanion(["result", handle.jobId, "--json"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).payload.rawOutput, "persistent answer");
});

test("observer wait expiry is reported without terminating the worker", async () => {
  const fake = makeFakeEnv({ mode: "hang" });
  const cwd = makeTempGitRepo();
  const submitted = runCompanion(
    ["task", "--background", "--json", "--kill-after-ms", "20000", "--write", "--", "keep working"],
    { env: fake.env, cwd }
  );
  assert.equal(submitted.status, 0, submitted.stderr);
  const jobId = JSON.parse(submitted.stdout).jobId;

  const status = runCompanion(
    ["status", jobId, "--wait", "--wait-timeout-ms", "500", "--json"],
    { env: fake.env, cwd }
  );
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.wait.expired, true);
  assert.equal(statusPayload.job.terminal, false);

  const result = runCompanion(
    ["result", jobId, "--wait", "--wait-timeout-ms", "500", "--json"],
    { env: fake.env, cwd }
  );
  assert.equal(result.status, 1);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.wait.expired, true);
  assert.equal(resultPayload.job.terminal, false);

  const cancelled = runCompanion(["cancel", jobId, "--json"], { env: fake.env, cwd });
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test("the timeout compatibility alias warns and conflicts are rejected", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const legacy = runCompanion(
    ["task", "--background", "--json", "--timeout-ms", "20000", "--write", "--", "legacy budget"],
    { env: fake.env, cwd }
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stderr, /--timeout-ms is deprecated/);
  assert.ok(JSON.parse(legacy.stdout).warnings.some((warning) => /deprecated/.test(String(warning))));

  const conflict = runCompanion(
    ["task", "--timeout-ms", "1000", "--kill-after-ms", "2000", "--", "bad"],
    { env: fake.env, cwd }
  );
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /either deprecated --timeout-ms or --kill-after-ms/);

  const backgroundWait = runCompanion(
    ["task", "--background", "--wait-timeout-ms", "1000", "--", "bad"],
    { env: fake.env, cwd }
  );
  assert.equal(backgroundWait.status, 1);
  assert.match(backgroundWait.stdout, /cannot be used with --background/);
});

test("SessionEnd leaves a persistent job running", async () => {
  const fake = makeFakeEnv({ mode: "hang", extra: { OPENCODE_COMPANION_SESSION_ID: "session-persist" } });
  const cwd = makeTempGitRepo();
  const submitted = runCompanion(
    ["task", "--background", "--json", "--kill-after-ms", "20000", "--write", "--", "survive session end"],
    { env: fake.env, cwd }
  );
  assert.equal(submitted.status, 0, submitted.stderr);
  const jobId = JSON.parse(submitted.stdout).jobId;

  const hook = spawnSync(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env: fake.env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "session-persist", cwd }),
    encoding: "utf8"
  });
  assert.equal(hook.status, 0, hook.stderr);
  await sleep(250);

  const status = JSON.parse(runCompanion(["status", jobId, "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(status.job.status, "running");
  assert.equal(status.job.terminal, false);

  runCompanion(["cancel", jobId], { env: fake.env, cwd });
});

test("cancel is idempotent and preserves the cancelled terminal state", () => {
  const fake = makeFakeEnv({ mode: "hang" });
  const cwd = makeTempGitRepo();
  const submitted = runCompanion(
    ["task", "--background", "--json", "--kill-after-ms", "20000", "--write", "--", "cancel twice"],
    { env: fake.env, cwd }
  );
  assert.equal(submitted.status, 0, submitted.stderr);
  const jobId = JSON.parse(submitted.stdout).jobId;
  const first = runCompanion(["cancel", jobId, "--json"], { env: fake.env, cwd });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).changed, true);
  const second = runCompanion(["cancel", jobId, "--json"], { env: fake.env, cwd });
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.changed, false);
  assert.equal(secondPayload.job.status, "cancelled");
});
