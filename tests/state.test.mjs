import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { makeTempDir } from "./helpers.mjs";

// The suite owns both env vars so it never touches a real data directory, and
// so an installed plugin's SessionStart export cannot leak in.
process.env.OPENCODE_COMPANION_DATA_DIR = makeTempDir("opencode-state-test");
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("opencode-state-decoy");
const { upsertJob, findJob, listJobs, setConfig, getConfig, resolveStateDir, resolveStateLocation, resolveJobInputFile, writeJobInputFile, claimJobInputFile } =
  await import("../plugins/opencode/scripts/lib/state.mjs");

const cwd = makeTempDir("opencode-state-workspace");

test("state dir lands under the namespaced data dir", () => {
  const location = resolveStateLocation(cwd);
  assert.ok(location.dir.startsWith(process.env.OPENCODE_COMPANION_DATA_DIR));
  assert.equal(location.source, "plugin-data");
});

test("private job input is mode 0600 and can only be claimed once", () => {
  const id = "task-private-input";
  writeJobInputFile(cwd, id, { prepared: { prompt: "secret" } });
  assert.equal(fs.statSync(resolveJobInputFile(cwd, id)).mode & 0o777, 0o600);
  assert.equal(claimJobInputFile(cwd, id).prepared.prompt, "secret");
  assert.equal(fs.existsSync(resolveJobInputFile(cwd, id)), false);
  assert.throws(() => claimJobInputFile(cwd, id), /ENOENT/);
});

test("upsertJob inserts then patches without losing fields", () => {
  upsertJob(cwd, { id: "task-1", kind: "task", status: "running", promptPreview: "hello" });
  upsertJob(cwd, { id: "task-1", status: "completed", opencodeSessionId: "ses_1" });
  const job = findJob(cwd, "task-1");
  assert.equal(job.status, "completed");
  assert.equal(job.promptPreview, "hello");
  assert.equal(job.opencodeSessionId, "ses_1");
  assert.ok(job.createdAt);
  assert.ok(job.updatedAt);
});

test("listJobs returns newest-first and prunes past the cap", () => {
  for (let index = 0; index < 60; index += 1) {
    upsertJob(cwd, { id: `bulk-${index}`, kind: "task", status: "completed" });
  }
  const jobs = listJobs(cwd);
  assert.ok(jobs.length <= 50);
  assert.equal(jobs[0].id, "bulk-59");
});

test("config round-trips", () => {
  assert.equal(Boolean(getConfig(cwd).stopReviewGate), false);
  setConfig(cwd, "stopReviewGate", true);
  assert.equal(getConfig(cwd).stopReviewGate, true);
  setConfig(cwd, "stopReviewGate", false);
});

// CLAUDE_PLUGIN_DATA is shared: it holds whichever plugin's SessionStart hook
// ran last in this shell, so it is not consulted at all any more.
test("a clobbered CLAUDE_PLUGIN_DATA is ignored, not used as a fallback", () => {
  const namespaced = process.env.OPENCODE_COMPANION_DATA_DIR;
  delete process.env.OPENCODE_COMPANION_DATA_DIR;
  try {
    const location = resolveStateLocation(cwd);
    assert.equal(location.source, "tmpdir-fallback");
    assert.ok(!location.dir.startsWith(process.env.CLAUDE_PLUGIN_DATA));
  } finally {
    process.env.OPENCODE_COMPANION_DATA_DIR = namespaced;
  }
  assert.ok(resolveStateDir(cwd).startsWith(namespaced));
});
