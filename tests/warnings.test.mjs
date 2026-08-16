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

// X1 (2): the prompt preamble tells headless delegates not to load interactive
// skills, but a repository AGENTS.md/CLAUDE.md can still win. 89 of 231 recorded
// opencode job logs opened by loading a skill instead of doing the work, which
// is invisible in the answer and shows up only as turns and wall time.
test("loading an interactive skill is counted and warned about", () => {
  const fake = makeFakeEnv({
    extra: {
      OPENCODE_FAKE_TEXT: "the answer, eventually",
      OPENCODE_FAKE_SKILL: "pua"
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "do the work"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.warnings.map((warning) => warning.class), ["skills_loaded"]);
  assert.deepEqual(payload.warnings[0].skills, ["pua", "/Users/x/.config/opencode/skills/pua/SKILL.md"]);
  assert.match(payload.warnings[0].message, /spent turns loading interactive skills/);
  assert.match(result.stderr, /warning: skills_loaded/);

  const clean = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "the answer" } });
  const quiet = runCompanion(["task", "--json", "--write", "do the work"], {
    env: clean.env,
    cwd: makeTempGitRepo()
  });
  assert.deepEqual(JSON.parse(quiet.stdout).warnings, [], "a clean run must not warn");
});

// X2: 30 of 64 recorded "succeeded" review jobs opened no file at all, and the
// orchestrator counted those verdicts as votes. Here the diff is inlined in the
// prompt, so 0 tool calls is not automatically ungrounded — but it does mean
// nothing outside the diff was inspected, and the verdict must say so.
test("a review verdict carries the evidence behind it", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: NEEDS ATTENTION \(evidence: none\)/);
  assert.match(result.stdout, /no_evidence_review: this verdict was produced with 0 tool calls/);
  assert.match(result.stdout, /opinion, not a completed review/);

  const withEvidence = makeFakeEnv({ mode: "review-json", extra: { OPENCODE_FAKE_TOOLS: "4" } });
  const json = runCompanion(["review", "--json"], { env: withEvidence.env, cwd: makeTempGitRepo() });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.evidenceLevel, "substantive");
  assert.equal(payload.toolEventCount, 4);
  assert.deepEqual(payload.warnings, [], "a review that did work must not be flagged");
});

// X2 (1): a caller must be able to drop a zero-evidence verdict without parsing
// the warning text. The downgrade is its own field, so the run's own verdict
// (`outputState`, exit code) keeps meaning "did opencode answer at all".
test("a zero-evidence review is machine-readably incomplete", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();
  const result = runCompanion(["review", "--json"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resultComplete, false, "0 tool calls behind a verdict is not a completed review");
  assert.equal(payload.evidenceLevel, "none");
  assert.equal(payload.outputState, "completed", "the run itself finished; only the verdict is downgraded");
  assert.deepEqual(
    payload.warnings.map((warning) => warning.class),
    ["no_evidence_review"]
  );

  // It is stored with the job, so a caller that comes back later via
  // `result --json` sees the same downgrade.
  const stored = JSON.parse(runCompanion(["result", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(stored.payload.resultComplete, false);

  const withEvidence = makeFakeEnv({ mode: "review-json", extra: { OPENCODE_FAKE_TOOLS: "4" } });
  const grounded = JSON.parse(
    runCompanion(["review", "--json"], { env: withEvidence.env, cwd: makeTempGitRepo() }).stdout
  );
  assert.equal(grounded.resultComplete, true);
});

test("a task run is never flagged for a missing review evidence trail", () => {
  const fake = makeFakeEnv({ extra: { OPENCODE_FAKE_TEXT: "answer" } });
  const result = runCompanion(["task", "--json", "--write", "answer this"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.evidenceLevel, "none");
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.resultComplete, true, "only review kinds are downgraded for missing evidence");
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
