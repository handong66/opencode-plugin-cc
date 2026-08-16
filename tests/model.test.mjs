import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  parseJsonc,
  readOpencodeModelConfig,
  resolveRunSelection
} from "../plugins/opencode/scripts/lib/opencodecli.mjs";
import { makeFakeEnv, makeTempDir, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// PC5: the config that matters here is JSONC with per-agent models, and the old
// reader took the *first* `"model": "..."` in the file — which in such a config
// is whichever one happens to be written first.
function makeOpencodeHome(configText, { extension = "jsonc" } = {}) {
  const home = makeTempDir("opencode-fake-home");
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `opencode.${extension}`), configText);
  return home;
}

const CONFIG = `{
  // The plan agent is what this plugin's read-only runs use.
  "agent": {
    "plan": { "model": "deepseek/deepseek-v4-flash", "variant": "max" },
    "build": { "model": "anthropic/claude-sonnet-4-5" }
  },
  /* the account default, written after the agents */
  "model": "anthropic/claude-opus-4-1",
}`;

test("the opencode config is read as JSONC, per key rather than by first match", () => {
  assert.deepEqual(parseJsonc('{ "a": 1, /* c */ "b": "//not a comment", }'), {
    a: 1,
    b: "//not a comment"
  });

  const home = makeOpencodeHome(CONFIG);
  const config = readOpencodeModelConfig({ homeDir: home });
  assert.equal(config.model, "anthropic/claude-opus-4-1");
  assert.equal(config.agentModels.plan, "deepseek/deepseek-v4-flash");
  assert.equal(config.agentModels.build, "anthropic/claude-sonnet-4-5");
  assert.equal(config.agentVariants.plan, "max");
});

test("a read-only run reports the agent's model, and warns that it is not the default", () => {
  const config = readOpencodeModelConfig({ homeDir: makeOpencodeHome(CONFIG) });

  const readOnly = resolveRunSelection({ readOnly: true, config });
  assert.equal(readOnly.model, "deepseek/deepseek-v4-flash");
  assert.equal(readOnly.agent, "plan");
  assert.equal(readOnly.variant, "max");
  assert.equal(readOnly.warnings[0].class, "read_only_model_override");
  assert.match(readOnly.warnings[0].message, /deepseek\/deepseek-v4-flash/);
  assert.match(readOnly.warnings[0].message, /anthropic\/claude-opus-4-1/);

  // An explicit --model is the caller's decision, so there is nothing to warn about.
  const explicit = resolveRunSelection({ model: "anthropic/claude-opus-4-1", readOnly: true, config });
  assert.equal(explicit.model, "anthropic/claude-opus-4-1");
  assert.equal(explicit.source, "flag");
  assert.deepEqual(explicit.warnings, []);

  // A write run uses the build agent.
  assert.equal(resolveRunSelection({ readOnly: false, config }).model, "anthropic/claude-sonnet-4-5");
});

test("the job record and the rendered footer name the model that ran", () => {
  const home = makeOpencodeHome(CONFIG);
  const fake = makeFakeEnv({ extra: { HOME: home } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "look at the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Model: deepseek\/deepseek-v4-flash \(agent plan, variant max\)/);
  assert.match(result.stderr, /read_only_model_override/);

  const jobId = result.stdout.match(/Job: (task-[\w-]+)/)[1];
  const detail = runCompanion(["status", jobId], { env: fake.env, cwd });
  assert.match(detail.stdout, /Model: deepseek\/deepseek-v4-flash \(agent plan, variant max\)/);

  const stored = JSON.parse(runCompanion(["status", jobId, "--json"], { env: fake.env, cwd }).stdout).job;
  assert.equal(stored.model, "deepseek/deepseek-v4-flash");
  assert.equal(stored.agent, "plan");
  assert.equal(stored.requestedModel, null);
  assert.equal(stored.modelSource, "config:agent.plan.model");

  const setup = JSON.parse(runCompanion(["setup", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(setup.defaultModel, "anthropic/claude-opus-4-1");
  assert.equal(setup.readOnlyModel, "deepseek/deepseek-v4-flash");
});
