import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, REPO_ROOT, runCompanion } from "./helpers.mjs";

const HOOK = path.join(REPO_ROOT, "plugins", "opencode", "scripts", "stop-review-gate-hook.mjs");

function runHook(input, { env, cwd }) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30_000
  });
}

function enableGate(fake, cwd) {
  const result = runCompanion(["setup", "--enable-review-gate", "--json"], { env: fake.env, cwd });
  assert.equal(JSON.parse(result.stdout).stopReviewGate, true);
}

function commitEverything(cwd) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "seed"]);
}

// P-GATE 1: Claude Code sets stop_hook_active on the Stop that follows a
// blocked one. There was no check for it anywhere in the repo, so the gate had
// no circuit breaker at all.
test("stop_hook_active short-circuits the gate before it decides anything", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "BLOCK: still broken" } });
  const cwd = makeTempGitRepo();
  enableGate(fake, cwd);

  const result = runHook({ cwd, session_id: "s1", stop_hook_active: true }, { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.equal(fs.existsSync(fake.argsFile), false, "no opencode run may be started");
});

// P-GATE 2: four of the five non-ok paths are infrastructure failures, and this
// runtime produces them often (an empty answer is one). Blocking on them means
// the user cannot end the session because the reviewer never ran.
test("an infrastructure failure allows the stop instead of blocking it", () => {
  const fake = makeFakeEnv({ mode: "silent" });
  const cwd = makeTempGitRepo();
  enableGate(fake, cwd);

  const result = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"decision"\s*:\s*"block"/);
  assert.match(result.stderr, /could not complete/);
  assert.match(result.stderr, /allowing the stop/);
  assert.match(result.stderr, /\/opencode:review --wait/);
});

test("an explicit BLOCK still blocks, and two in a row stand the gate down", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "BLOCK: the lock is never released" } });
  const cwd = makeTempGitRepo();
  enableGate(fake, cwd);

  for (const attempt of [1, 2]) {
    const blocked = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
    const decision = JSON.parse(blocked.stdout);
    assert.equal(decision.decision, "block", `attempt ${attempt}: ${blocked.stdout}`);
    assert.match(decision.reason, /the lock is never released/);
  }

  const third = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  const decision = JSON.parse(third.stdout);
  assert.notEqual(decision.decision, "block");
  assert.match(decision.systemMessage, /standing down/);
  assert.match(decision.systemMessage, /--disable-review-gate/);

  // A different session starts with a clean counter.
  const otherSession = runHook({ cwd, session_id: "s2" }, { env: fake.env, cwd });
  assert.equal(JSON.parse(otherSession.stdout).decision, "block");
});

// P-GATE 3: `prompts/stop-review-gate.md` already tells the model to allow when
// nothing changed. Paying for a whole opencode session to be told so is the
// expensive way to reach the same answer.
test("a stop with nothing to review never starts a run", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "BLOCK: should never be asked" } });
  const cwd = makeTempGitRepo();
  commitEverything(cwd);
  enableGate(fake, cwd);

  // First stop: no recorded HEAD yet, so the review does run and records it.
  const first = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  assert.equal(JSON.parse(first.stdout).decision, "block", first.stdout);
  assert.ok(fs.existsSync(fake.argsFile));
  fs.rmSync(fake.argsFile);

  // Second stop: clean tree and HEAD has not moved — nothing happened since.
  const second = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.existsSync(fake.argsFile), false, "an unchanged repo must not cost a run");
  assert.match(second.stderr, /no working-tree changes/);

  // A commit made during the turn moves HEAD, so the gate must not skip.
  fs.writeFileSync(path.join(cwd, "committed.mjs"), "export const x = 1;\n");
  commitEverything(cwd);
  const third = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  assert.ok(fs.existsSync(fake.argsFile), "a moved HEAD must still be reviewed");
  assert.equal(third.status, 0, third.stderr);
});

// P-GATE 4: the inner deadline was identical to the hooks.json budget, so the
// friendly timeout message could never be delivered.
test("the inner review deadline is strictly below the Stop hook budget", () => {
  const source = fs.readFileSync(HOOK, "utf8");
  const hooks = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "plugins", "opencode", "hooks", "hooks.json"), "utf8")
  );
  const stopTimeoutSeconds = hooks.hooks.Stop[0].hooks[0].timeout;
  const budgetMatch = source.match(/STOP_HOOK_BUDGET_MS\s*=\s*(\d+)\s*\*\s*1000/);
  assert.ok(budgetMatch, "the hook must state the budget it is bound to");
  assert.equal(
    Number(budgetMatch[1]),
    stopTimeoutSeconds,
    "the constant must track hooks.json, not drift from it"
  );
  assert.match(source, /STOP_REVIEW_TIMEOUT_MS\s*=\s*Math\.round\(STOP_HOOK_BUDGET_MS \* 0\.8\)/);
});

// X6 (1): three of these hooks fire on every Stop of every session, and the
// gate was enabled in none of 25 recorded workspaces. A workspace that never
// used the plugin should cost node startup and one existsSync, nothing else.
test("a workspace that never used the plugin costs one file check", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const result = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.equal(
    fs.existsSync(path.join(fake.stateDir, "state")),
    false,
    "the disabled path must not create a job store"
  );
});

// X6 (2): the "job still running" reminder used to go to stderr, which reaches
// neither the model nor the transcript — 348 recorded Stop records carry an
// empty hook content field. It is the one signal that could have caught the
// orphaned jobs, so it now travels as a non-blocking hook decision payload.
test("an unreclaimed job is reported to the session, not to stderr", () => {
  const fake = makeFakeEnv({ mode: "hang" });
  const cwd = makeTempGitRepo();

  const child = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "plugins", "opencode", "scripts", "opencode-companion.mjs"), "task", "--timeout-ms", "1500", "--", "a run that stalls"],
    { cwd, env: { ...fake.env, OPENCODE_COMPANION_SESSION_ID: "s1" }, encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(child.status, 1, child.stdout);

  // Re-mark it as running with this process as the owner, standing in for a
  // job that is genuinely still in flight when the session ends.
  const stateRoot = path.join(fake.stateDir, "state");
  const storeDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const stateFile = path.join(storeDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs = state.jobs.map((job) => ({ ...job, status: "running", childPid: process.pid, sessionId: "s1" }));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const result = runHook({ cwd, session_id: "s1" }, { env: fake.env, cwd });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, undefined, "the reminder must not block the stop");
  assert.match(payload.systemMessage, /is still running/);
  assert.match(payload.systemMessage, /\/opencode:cancel/);
});
