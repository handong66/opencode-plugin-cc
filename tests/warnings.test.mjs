import assert from "node:assert/strict";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";
import { detectPermissionWarnings } from "../plugins/opencode/scripts/lib/opencodecli.mjs";

const REJECTION_LINE = "! permission requested: external_directory (/private/tmp/claude-501/x/scratchpad/dossier.json); auto-rejecting";

// PC3 (2): the stderr tail explains what opencode printed; the typed warning
// says what it means. Claude Code stages prompts and material under
// /private/tmp/claude-501/..., opencode refuses to read outside the repo, and
// the run still exits 0 — so the caller saw a thin answer with no cause.
test("an auto-rejected external path becomes a typed, actionable warning", () => {
  const fake = makeFakeEnv({
    extra: {
      OPENCODE_FAKE_TEXT: "answer produced without the dossier",
      OPENCODE_FAKE_STDERR: REJECTION_LINE
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--write", "read the scratchpad dossier"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Warnings:/);
  assert.match(result.stdout, /external_path_blocked: opencode refused to read \/private\/tmp\/claude-501/);
  assert.match(result.stdout, /Copy the file into the repo, or inline its contents in the prompt/);
  assert.match(result.stderr, /warning: external_path_blocked/, "it must also be visible on stderr");

  // And it survives into the stored render and the machine-readable channel.
  const stored = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(stored, /external_path_blocked/);

  const fresh = makeFakeEnv({
    extra: { OPENCODE_FAKE_TEXT: "answer", OPENCODE_FAKE_STDERR: REJECTION_LINE }
  });
  const json = runCompanion(["task", "--json", "--write", "read it"], {
    env: fresh.env,
    cwd: makeTempGitRepo()
  });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.warnings[0].class, "external_path_blocked");
  assert.equal(payload.warnings[0].path, "/private/tmp/claude-501/x/scratchpad/dossier.json");
});

test("detectPermissionWarnings dedupes and names the working directory", () => {
  const warnings = detectPermissionWarnings(`${REJECTION_LINE}\n${REJECTION_LINE}\n`, { cwd: "/repo" });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].permission, "external_directory");
  assert.match(warnings[0].message, /outside \/repo/);

  assert.deepEqual(detectPermissionWarnings("nothing interesting here"), []);

  const other = detectPermissionWarnings("! permission requested: bash (rm -rf); auto-rejecting");
  assert.equal(other[0].class, "permission_blocked");
});
