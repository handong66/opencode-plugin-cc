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

// `--background` / `--wait` are Claude-side execution flags; forwarding them to
// the companion is what made two 2026-07-21 runs die on the 2-minute wall.
test("rescue docs keep --background as a Claude-side flag, not a companion flag", () => {
  const skill = readDoc("skills", "opencode-cli-runtime", "SKILL.md");
  assert.match(skill, /Strip it before calling `task`/);
  assert.doesNotMatch(skill, /opencode-companion\.mjs" task --background/);
});
