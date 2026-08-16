import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { makeFakeEnv, makeTempDir, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// M2/PC7: 0.1.1 added the namespaced env var but kept `CLAUDE_PLUGIN_DATA` as a
// fallback, and that name holds whichever plugin's SessionStart hook ran last —
// which is how opencode job logs ended up under codex-inline/state/... Any Bash
// context that never sourced the session env file re-entered the collision.
test("CLAUDE_PLUGIN_DATA no longer decides where state lands", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "answer" } });
  const decoyOnly = { ...fake.env };
  delete decoyOnly.OPENCODE_COMPANION_DATA_DIR;
  const cwd = makeTempGitRepo();

  const result = runCompanion(["status", "--json", "--all"], { env: decoyOnly, cwd });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stateSource, "tmpdir-fallback");
  assert.ok(!report.stateDir.startsWith(fake.decoyDir), `state must not land in ${fake.decoyDir}`);
  assert.equal(fs.readdirSync(fake.decoyDir).length, 0);

  // And the fallback announces itself on stderr, never on stdout: the slash
  // commands require Claude to relay stdout verbatim.
  assert.match(result.stderr, /OPENCODE_COMPANION_DATA_DIR is unset/);
  assert.match(result.stderr, /may not be visible to other Claude sessions/);
  assert.doesNotMatch(result.stdout, /is unset/);
});

test("the namespaced dir is reported as the source when it is set", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd: makeTempGitRepo() });
  const report = JSON.parse(result.stdout);
  assert.equal(report.stateSource, "plugin-data");
  assert.ok(report.stateDir.startsWith(fake.stateDir));
  assert.ok(report.workspaceRoot);
  assert.equal(result.stderr.trim(), "", "a resolved store must not warn");
});

// A store stamped by another plugin must never be read or written: reading it
// reports their jobs as ours, writing it corrupts their records.
test("a state file owned by another plugin is refused with a fixable message", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });

  const stateDir = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, owner: "codex-plugin-cc", config: {}, jobs: [{ id: "not-ours" }] }, null, 2)
  );

  const result = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /belongs to codex-plugin-cc, not opencode-plugin-cc/);
  assert.match(result.stderr, /OPENCODE_COMPANION_DATA_DIR/);
  assert.doesNotMatch(result.stderr, /at Object\./, "a configuration problem must not print a stack trace");
  assert.equal(
    JSON.parse(fs.readFileSync(stateFile, "utf8")).owner,
    "codex-plugin-cc",
    "the other plugin's file must be left untouched"
  );
});

test("a state file written before the owner stamp is adopted, not refused", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "answer" } });
  const cwd = makeTempGitRepo();
  const stateDir = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [{ id: "legacy", kind: "task", status: "completed" }] }, null, 2)
  );

  const listed = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).jobs[0].id, "legacy");

  runCompanion(["task", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).owner, "opencode-plugin-cc");
});

// One bare "No job found with id X" cost about two hours in 2026-07 because it
// could not distinguish a typo from the wrong workspace or the wrong store.
test("a missing job id reports where it looked and what is there", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "answer" } });
  const cwd = makeTempGitRepo();
  runCompanion(["task", "--write", "do the thing"], { env: fake.env, cwd });

  for (const command of [["status", "task-nope"], ["result", "task-nope"], ["cancel", "task-nope"]]) {
    const result = runCompanion(command, { env: fake.env, cwd });
    assert.equal(result.status, 1, `${command[0]}: ${result.stderr}`);
    assert.match(result.stdout, /No job found with id task-nope\./, command[0]);
    assert.match(result.stdout, /Workspace root: /, command[0]);
    assert.match(result.stdout, new RegExp(`Job store: ${fake.stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), command[0]);
    assert.match(result.stdout, /\(plugin-data\)/, command[0]);
    assert.match(result.stdout, /Most recent jobs in this store:/, command[0]);
    assert.match(result.stdout, /\| task \| completed/, command[0]);
    assert.doesNotMatch(result.stdout, /do the thing/, "prompt previews must not leak into error paths");
  }
});

test("an empty store says so instead of listing nothing", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["status", "task-nope"], { env: fake.env, cwd: makeTempDir("opencode-empty-ws") });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /This store holds no jobs at all/);
});
