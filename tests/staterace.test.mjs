import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeTempDir } from "./helpers.mjs";

const STATE_MODULE = path.join(REPO_ROOT, "plugins", "opencode", "scripts", "lib", "state.mjs");

process.env.OPENCODE_COMPANION_DATA_DIR = makeTempDir("opencode-staterace-data");
const { resolveJobsDir, resolveStateDir, resolveStateFile, listJobs, upsertJob, writeJobFile } =
  await import("../plugins/opencode/scripts/lib/state.mjs");

// P-STATERACE 2: `saveState` overwrote state.json in place, so a reader could
// see a torn file — and `loadState`'s silent `catch { return defaultState() }`
// turns a torn read into "the job list is empty". A rename swaps a complete
// file in atomically, which an already-open descriptor proves: it still sees
// the old inode instead of a truncated one.
test("state.json is replaced by rename, never truncated in place", () => {
  const cwd = makeTempDir("opencode-staterace-atomic");
  upsertJob(cwd, { id: "first", kind: "task", status: "completed" });

  const stateFile = resolveStateFile(cwd);
  const before = fs.readFileSync(stateFile, "utf8");
  const fd = fs.openSync(stateFile, "r");
  try {
    upsertJob(cwd, { id: "second", kind: "task", status: "completed" });
    const throughOldHandle = fs.readFileSync(fd, "utf8");
    assert.equal(
      throughOldHandle,
      before,
      "an in-place overwrite would have changed what the open handle sees"
    );
  } finally {
    fs.closeSync(fd);
  }

  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.length, 2);
  const leftovers = fs.readdirSync(resolveStateDir(cwd)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the temp file must not survive the write");
});

// P-STATERACE 1 (regression guard): concurrency is the normal case here — one
// `status --all` table routinely lists several in-flight jobs — and a writer
// holding a stale snapshot used to unlink its neighbours' payload and log
// files, while the write stream kept writing into the unlinked inode.
//
// What is guaranteed without the (deliberately deferred) exclusive lock: no
// writer ever deletes another writer's stored payload or log, and the store
// always parses. A record can still be dropped from state.json by a simultaneous
// read-modify-write; the lock item covers that.
test("concurrent writers never destroy each other's payloads or logs", async () => {
  const cwd = makeTempDir("opencode-staterace-concurrent");
  const writerCount = 8;

  const writer = (index) => `
    const fs = (await import("node:fs")).default;
    const { upsertJob, writeJobFile, resolveJobLogFile } = await import(${JSON.stringify(STATE_MODULE)});
    const cwd = ${JSON.stringify(cwd)};
    const id = "job-" + ${index};
    const logFile = resolveJobLogFile(cwd, id);
    fs.writeFileSync(logFile, "log for " + id + "\\n");
    upsertJob(cwd, { id, kind: "task", status: "running", cwd, logFile, promptPreview: id });
    await new Promise((resolve) => setTimeout(resolve, 50 * (${index} % 4)));
    writeJobFile(cwd, id, { kind: "task", rawOutput: "answer " + id, rendered: "answer " + id });
    upsertJob(cwd, { id, status: "completed", summary: "answer " + id });
  `;

  await Promise.all(
    Array.from({ length: writerCount }, (unused, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", writer(index)], {
          env: process.env,
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      })
    )
  );

  const jobsDir = resolveJobsDir(cwd);
  for (let index = 0; index < writerCount; index += 1) {
    assert.ok(fs.existsSync(path.join(jobsDir, `job-${index}.json`)), `payload for job-${index} survived`);
    assert.ok(fs.existsSync(path.join(jobsDir, `job-${index}.log`)), `log for job-${index} survived`);
    assert.match(
      JSON.parse(fs.readFileSync(path.join(jobsDir, `job-${index}.json`), "utf8")).rawOutput,
      new RegExp(`answer job-${index}`),
      `payload for job-${index} is intact`
    );
  }

  // The store itself must still be readable, and no record may carry a
  // neighbour's fields. (A record can still be *stale* — reverted to the
  // `running` snapshot a racing writer had merged from — until the deferred
  // exclusive lock lands; that is a lost update, not a destroyed result, and
  // the payload above is what `result <id>` prints.)
  const jobs = listJobs(cwd, { reconcile: false });
  assert.ok(jobs.length > 0, "the store must not read as empty after concurrent writes");
  for (const job of jobs) {
    assert.ok(["running", "completed"].includes(job.status), `${job.id} has a plausible status`);
    if (job.summary) {
      assert.equal(job.summary, `answer ${job.id}`, "no record may carry another job's fields");
    }
  }
});

// A payload is read back by `result`, whose parse failure is equally silent.
test("job payloads are written atomically too", () => {
  const cwd = makeTempDir("opencode-staterace-payload");
  writeJobFile(cwd, "payload-job", { kind: "task", rawOutput: "first" });
  const jobFile = path.join(resolveJobsDir(cwd), "payload-job.json");
  const before = fs.readFileSync(jobFile, "utf8");
  const fd = fs.openSync(jobFile, "r");
  try {
    writeJobFile(cwd, "payload-job", { kind: "task", rawOutput: "second" });
    assert.equal(fs.readFileSync(fd, "utf8"), before);
  } finally {
    fs.closeSync(fd);
  }
  assert.match(fs.readFileSync(jobFile, "utf8"), /second/);
});
