import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, REPO_ROOT, runCompanion } from "./helpers.mjs";

const PROMPT = fs.readFileSync(
  path.join(REPO_ROOT, "plugins", "opencode", "prompts", "adversarial-review.md"),
  "utf8"
);

// X3: an unbounded adversarial review reports network-attacker findings against
// a single-user local tool, and those findings then stop the user's actual
// work. Their words, verbatim: "please stop interrupting my task".
test("the adversarial prompt asks for a boundary and neutral vocabulary", () => {
  assert.match(PROMPT, /\{\{THREAT_MODEL\}\}/);
  assert.match(PROMPT, /`in-model`.*`out-of-model`/s);
  assert.match(PROMPT, /Out-of-model findings alone are never enough for `needs-attention`/);
  // Security-filter bait: the sibling runtime aborted a task outright on
  // `cyber_policy` after an adversarial review prompt full of attack language.
  for (const word of ["attacker", "malicious", "attack chain", "attack_surface"]) {
    assert.ok(!PROMPT.includes(word), `the prompt should avoid "${word}"`);
  }
});

test("--threat-model reaches the reviewer, and its absence has a stated default", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const withModel = runCompanion(
    ["adversarial-review", "--threat-model", "single-user local tool, no network exposure"],
    { env: fake.env, cwd }
  );
  assert.equal(withModel.status, 0, withModel.stdout + withModel.stderr);
  assert.match(readRunArgs(fake).at(-1), /single-user local tool, no network exposure/);

  runCompanion(["adversarial-review"], { env: fake.env, cwd });
  const prompt = readRunArgs(fake).at(-1);
  assert.match(prompt, /No threat model was supplied by the caller/);
  assert.match(prompt, /single-user local application/);
});
