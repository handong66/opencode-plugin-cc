import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

// 补充发现 4: `--scope` went straight through to lib/git.mjs, so the two values
// the command docs explicitly call unsupported (`staged`, `unstaged`) silently
// fell into the working-tree branch and the caller got a review of something
// else — then relayed it verbatim as authoritative.
test("a mistyped --scope fails fast instead of reviewing something else", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  for (const scope of ["staged", "unstaged", "workingtree"]) {
    const result = runCompanion(["review", "--scope", scope], { env: fake.env, cwd });
    assert.equal(result.status, 1, `--scope ${scope} must be rejected`);
    assert.match(result.stdout, /--scope/);
    assert.match(result.stdout, /auto.*working-tree.*branch/s, result.stdout);
    // Nothing was run: no opencode invocation happened at all.
    assert.equal(fs.existsSync(fake.argsFile), false, `--scope ${scope} still spawned opencode`);
  }

  const ok = runCompanion(["review", "--scope", "working-tree"], { env: fake.env, cwd });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

// 补充发现 3: `--model` / `--variant` landed in `rest` and were dropped without
// a word, while README taught `/opencode:review --model anthropic/...`.
test("review forwards --model and --variant instead of dropping them", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review", "--model", "fake/model-two", "--variant", "max"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readRunArgs(fake);
  assert.ok(args.includes("--model"), JSON.stringify(args));
  assert.equal(args[args.indexOf("--model") + 1], "fake/model-two");
  assert.equal(args[args.indexOf("--variant") + 1], "max");
});

test("an unknown review flag is refused, and stray review text is not swallowed", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const unknown = runCompanion(["review", "--scpoe", "branch"], { env: fake.env, cwd });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /Unknown flag: --scpoe/);
  assert.match(unknown.stdout, /--scope/, "the error must list what review does accept");
  assert.equal(fs.existsSync(fake.argsFile), false);

  // Non-adversarial review has nowhere to put focus text; dropping it silently
  // is how a caller believes their instructions reached the reviewer.
  const stray = runCompanion(["review", "focus", "on", "the", "lock"], { env: fake.env, cwd });
  assert.equal(stray.status, 0, stray.stdout + stray.stderr);
  assert.match(stray.stderr, /focus on the lock/);
  assert.match(stray.stderr, /adversarial-review/);
});

test("adversarial review still passes its focus text through", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["adversarial-review", "check", "the", "lock", "path"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readRunArgs(fake);
  assert.match(args.at(-1), /check the lock path/);
});
