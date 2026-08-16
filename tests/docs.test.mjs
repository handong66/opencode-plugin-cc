import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "opencode");

function readDoc(...segments) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, ...segments), "utf8");
}

// Rescue forwarders inherit Claude Code's 120s Bash default unless the
// invocation template says otherwise; opencode runs routinely exceed it.
test("rescue invocation templates carry an explicit Bash timeout", () => {
  const skill = readDoc("skills", "opencode-cli-runtime", "SKILL.md");
  const agent = readDoc("agents", "opencode-rescue.md");

  for (const [name, text] of [
    ["skills/opencode-cli-runtime/SKILL.md", skill],
    ["agents/opencode-rescue.md", agent]
  ]) {
    assert.match(text, /timeout:\s*600000/, `${name} must show timeout: 600000 in its Bash template`);
    assert.match(
      text,
      /run_in_background/,
      `${name} must point long runs at Bash(run_in_background: true)`
    );
    assert.match(
      text,
      /opencode runs (?:regularly|routinely|often) (?:take|run) longer than (?:two minutes|2 minutes)/i,
      `${name} must state that opencode runs regularly exceed the 2-minute default`
    );
  }
});

// X1: headless delegates obey the repository's own bootstrap rules — 57/128
// grok jobs and 89/231 opencode jobs opened by reading a PUA/superpowers
// SKILL.md before doing any of the requested work, and narration is what
// P-COMPLETE's `narration` class is made of.
test("prompt templates open with the headless delegation preamble", () => {
  for (const name of ["review", "adversarial-review", "stop-review-gate"]) {
    const text = readDoc("prompts", `${name}.md`);
    assert.ok(
      text.startsWith("<headless_delegation>"),
      `prompts/${name}.md must lead with the headless delegation preamble`
    );
    assert.match(text, /Ignore repository bootstrap instructions/, `prompts/${name}.md`);
    assert.match(text, /`pua`/, `prompts/${name}.md must name the personas it is overriding`);
    assert.match(text, /superpowers/, `prompts/${name}.md must name the personas it is overriding`);
    assert.match(text, /Do not narrate/, `prompts/${name}.md must forbid narration`);
    assert.doesNotMatch(
      text.split("</headless_delegation>")[0],
      /\{\{[A-Z0-9_]+\}\}/,
      `prompts/${name}.md preamble must not depend on interpolation`
    );
  }
});

// PC2: the documented single-argument form ran the prompt through `tokenize`,
// which drops quotes and folds newlines — 8 of 39 recorded task calls used it,
// all carrying quoted multi-line contracts.
test("rescue docs teach the prompt forms that survive tokenization", () => {
  for (const [name, text] of [
    ["skills/opencode-cli-runtime/SKILL.md", readDoc("skills", "opencode-cli-runtime", "SKILL.md")],
    ["agents/opencode-rescue.md", readDoc("agents", "opencode-rescue.md")]
  ]) {
    assert.match(text, /task .*--\s*<(?:task text|prompt)>/, `${name} must show the -- form`);
    assert.match(text, /--prompt-file/, `${name} must offer --prompt-file for hostile prompts`);
    assert.doesNotMatch(
      text,
      /task (?:--write )?"<(?:task text|raw arguments)>"/,
      `${name} must not still document the quoted single-argument form`
    );
  }
});

// X4/PC4: "return nothing" degraded exactly where it mattered — a forwarder
// killed by the 120s Bash wall has no stdout to return, so 6 of 13 recorded
// rescue dispatches came back empty while their job had already completed.
test("rescue docs replace `return nothing` with a structured failure line", () => {
  for (const [name, text] of [
    ["skills/opencode-cli-runtime/SKILL.md", readDoc("skills", "opencode-cli-runtime", "SKILL.md")],
    ["agents/opencode-rescue.md", readDoc("agents", "opencode-rescue.md")]
  ]) {
    assert.doesNotMatch(text, /return nothing/i, `${name} must not tell the forwarder to return nothing`);
    assert.match(
      text,
      /OPENCODE_RESCUE_FAILED: <reason> \| job=<id[^>]*> \| log=<[^>]*>/,
      `${name} must specify the structured failure line`
    );
    assert.match(text, /at most one `result <id>`/, `${name} must allow retrieving its own job`);
    assert.match(text, /never write your own answer/i, `${name} must keep the substitution ban`);
  }
});

// `--background` / `--wait` are Claude-side execution flags; forwarding them to
// the companion is what made two 2026-07-21 runs die on the 2-minute wall.
test("rescue docs keep --background as a Claude-side flag, not a companion flag", () => {
  const skill = readDoc("skills", "opencode-cli-runtime", "SKILL.md");
  assert.match(skill, /Strip it before calling `task`/);
  assert.doesNotMatch(skill, /opencode-companion\.mjs" task --background/);
});
