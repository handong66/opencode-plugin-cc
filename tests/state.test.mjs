import assert from "node:assert/strict";
import { test } from "node:test";

import { makeTempDir } from "./helpers.mjs";

process.env.CLAUDE_PLUGIN_DATA = makeTempDir("opencode-state-test");
const { upsertJob, findJob, listJobs, setConfig, getConfig, resolveStateDir } = await import(
  "../plugins/opencode/scripts/lib/state.mjs"
);

const cwd = makeTempDir("opencode-state-workspace");

test("state dir lands under CLAUDE_PLUGIN_DATA", () => {
  assert.ok(resolveStateDir(cwd).startsWith(process.env.CLAUDE_PLUGIN_DATA));
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

test("namespaced data dir wins over a clobbered CLAUDE_PLUGIN_DATA", () => {
  const namespaced = makeTempDir("opencode-namespaced");
  process.env.OPENCODE_COMPANION_DATA_DIR = namespaced;
  try {
    assert.ok(resolveStateDir(cwd).startsWith(namespaced));
  } finally {
    delete process.env.OPENCODE_COMPANION_DATA_DIR;
  }
  assert.ok(resolveStateDir(cwd).startsWith(process.env.CLAUDE_PLUGIN_DATA));
});
