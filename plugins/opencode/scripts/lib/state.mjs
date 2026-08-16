import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive } from "./process.mjs";
import { DATA_DIR_ENV } from "./session-env.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
// Written into state.json and checked on every read. Two plugins sharing a
// directory is not hypothetical: the Codex sibling exports `CLAUDE_PLUGIN_DATA`
// too, and opencode job logs were found under `codex-inline/state/...`.
export const STATE_OWNER = "opencode-plugin-cc";
// How long a running record may go without a pid before it counts as dead.
// Wide enough to cover the gap between `upsertJob(running)` and `onSpawn`.
export const ORPHAN_GRACE_MS = 120_000;
const ORPHAN_SUMMARY =
  "process exited without writing a result (companion was killed or the machine restarted)";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "opencode-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    owner: STATE_OWNER,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// Returns where state lives *and how that was decided*, so every caller can say
// so. `CLAUDE_PLUGIN_DATA` is deliberately not consulted: it is a shared name
// that holds whichever plugin's SessionStart hook ran last, which is how
// opencode jobs ended up in the Codex plugin's data directory for two hours.
export function resolveStateLocation(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[DATA_DIR_ENV];
  const source = pluginDataDir ? "plugin-data" : "tmpdir-fallback";
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return { dir: path.join(stateRoot, `${slug}-${hash}`), source, workspaceRoot };
}

export function resolveStateDir(cwd) {
  return resolveStateLocation(cwd).dir;
}

export function describeStateLocation(cwd) {
  const location = resolveStateLocation(cwd);
  return location.source === "tmpdir-fallback"
    ? `${DATA_DIR_ENV} is unset; using the temporary job store at ${location.dir}. Jobs may not be visible to other Claude sessions or to Bash contexts that did not source the session env file. Reload the plugin or restart the session.`
    : null;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return defaultState();
  }

  // A state file stamped with someone else's name means the data dir resolved
  // to another plugin's store. Refusing is the only safe move: writing here
  // would corrupt their records, and reading would report their jobs as ours.
  // A file with no owner predates the stamp and is adopted on the next write.
  if (parsed.owner && parsed.owner !== STATE_OWNER) {
    const error = new Error(
      `${stateFile} belongs to ${parsed.owner}, not ${STATE_OWNER}. Point ${DATA_DIR_ENV} at this plugin's own data directory (or unset it and reload the plugin).`
    );
    error.code = "STATE_OWNER_MISMATCH";
    throw error;
  }

  return {
    ...defaultState(),
    ...parsed,
    owner: STATE_OWNER,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Write to a sibling temp file and rename it into place. A reader then sees
// either the old file or the new one but never a half-written one — and both
// `loadState` and `readJobFile` swallow a parse failure, so a torn read shows
// up as "no jobs" / "no stored output" rather than as an error.
function writeFileAtomic(filePath, contents) {
  const tmpFile = `${filePath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, contents, "utf8");
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    removeFileIfExists(tmpFile);
    throw error;
  }
}

// The rename makes a *write* atomic; it does nothing for the read-modify-write
// around it. Two companions calling `upsertJob` at the same instant both read
// the same state.json, both merge their own job into it, and the second rename
// wins — the first job's record is reverted to whatever the loser had read.
// Measured before this lock existed: 8 concurrent writers left 3/8 records with
// their final status (7/8 once the re-merge below was added). A dropped record
// is not cosmetic — `findJob` cannot see it, so `result <id>` reports "no job"
// for a run whose payload is sitting on disk.
//
// So the whole read-modify-write is serialised on an `O_EXCL` lock file. It is
// advisory and deliberately unable to wedge anything: a lock older than
// LOCK_STALE_MS belongs to a dead holder and is broken, and a writer that still
// cannot take it after LOCK_ACQUIRE_TIMEOUT_MS proceeds without it (degrading
// to exactly the previous behaviour, re-merge included) rather than failing a
// job write.
const LOCK_FILE_NAME = "state.lock";
const LOCK_STALE_MS = 5_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 4;
// Re-entrant within a process: `updateState` takes the lock and then calls
// `saveState`, which takes it again.
const lockDepth = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(lockFile) {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        // A store we cannot even create a lock file in (read-only mount, odd
        // permissions). Writing state.json may still work; do not block it.
        return false;
      }
    }
    let ageMs = null;
    try {
      ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
    } catch {
      ageMs = null; // released between the two calls — retry immediately.
    }
    if (ageMs !== null && ageMs > LOCK_STALE_MS) {
      removeFileIfExists(lockFile);
      continue;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    if (ageMs !== null) {
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function withStateLock(cwd, run) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
  const depth = lockDepth.get(lockFile) ?? 0;
  if (depth > 0) {
    lockDepth.set(lockFile, depth + 1);
    try {
      return run();
    } finally {
      lockDepth.set(lockFile, depth);
    }
  }

  const held = acquireStateLock(lockFile);
  lockDepth.set(lockFile, 1);
  try {
    return run();
  } finally {
    lockDepth.delete(lockFile);
    if (held) {
      removeFileIfExists(lockFile);
    }
  }
}

// Kept as a second line of defence for the degraded path above (lock not
// acquired) and for any writer from an older version of this plugin.
const SAVE_MERGE_RETRIES = 3;

export function saveState(cwd, state, options = {}) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state, options));
}

function saveStateLocked(cwd, state, { attempt = 0 } = {}) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  // Union the caller's (possibly stale) snapshot with what is on disk right
  // now, caller version winning per id. Without this, a concurrent writer's
  // jobs look "removed" to us and their payload and log file get unlinked
  // while their run is still streaming into it.
  const merged = new Map((state.jobs ?? []).map((job) => [job.id, job]));
  for (const job of previousJobs) {
    if (!merged.has(job.id)) {
      merged.set(job.id, job);
    }
  }
  const nextJobs = pruneJobs([...merged.values()]);
  const nextState = {
    version: STATE_VERSION,
    owner: STATE_OWNER,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);

  if (attempt < SAVE_MERGE_RETRIES) {
    const onDisk = new Set(loadState(cwd).jobs.map((job) => job.id));
    if (nextJobs.some((job) => !onDisk.has(job.id))) {
      return saveStateLocked(cwd, nextState, { attempt: attempt + 1 });
    }
  }
  return nextState;
}

// The read and the write are one critical section: the mutation is computed
// from the state that was on disk when the lock was taken, so no concurrent
// writer can slip a version in between them.
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

// Terminal states are only ever written by the process that owns the run, so a
// companion killed mid-run (Bash timeout, SIGTERM, machine restart) leaves its
// record frozen at `running` forever — `status --wait` then burns its whole
// budget re-reading it and the rendered elapsed time grows without bound.
// This relabels such records. It never signals anything: killing stays with
// `cancel` and the SessionEnd hook.
export function reconcileJobs(jobs, { now = Date.now(), graceMs = ORPHAN_GRACE_MS, alive = isAlive } = {}) {
  let changed = false;
  const reconciled = jobs.map((job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }

    const pid = Number(job.childPid);
    const hasPid = Number.isFinite(pid) && pid > 0;
    const lastSeen = Date.parse(job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
    // No pid yet means either the spawn gap (a live companion, milliseconds
    // wide) or a companion that died before it could record one.
    const dead = hasPid ? !alive(pid) : Number.isFinite(lastSeen) && now - lastSeen > graceMs;
    if (!dead) {
      return job;
    }

    changed = true;
    const startedAt = Date.parse(job.startedAt ?? job.createdAt ?? "");
    const frozenDuration =
      Number.isFinite(startedAt) && Number.isFinite(lastSeen) && lastSeen >= startedAt
        ? lastSeen - startedAt
        : job.durationMs ?? null;
    return {
      ...job,
      status: "failed",
      failureClass: "orphaned",
      endedAt: job.endedAt ?? new Date(Number.isFinite(lastSeen) ? lastSeen : now).toISOString(),
      durationMs: frozenDuration,
      summary: ORPHAN_SUMMARY
    };
  });

  return { jobs: reconciled, changed };
}

// Writes the relabelling back, but re-reads first and only touches records that
// are *still* running/queued, so a run that reached a terminal state between
// the read and the write keeps its own verdict.
function persistReconciliation(cwd, reconciled) {
  const patches = new Map(reconciled.filter((job) => job.failureClass === "orphaned").map((job) => [job.id, job]));
  if (patches.size === 0) {
    return;
  }
  updateState(cwd, (state) => {
    state.jobs = state.jobs.map((job) => {
      const patch = patches.get(job.id);
      if (!patch || (job.status !== "running" && job.status !== "queued")) {
        return job;
      }
      return { ...job, ...patch };
    });
  });
}

export function listJobs(cwd, { reconcile = true } = {}) {
  const jobs = loadState(cwd).jobs;
  if (!reconcile) {
    return jobs;
  }
  const result = reconcileJobs(jobs);
  if (result.changed) {
    persistReconciliation(cwd, result.jobs);
  }
  return result.jobs;
}

export function findJob(cwd, jobId, { reconcile = true } = {}) {
  return listJobs(cwd, { reconcile }).find((job) => job.id === jobId) ?? null;
}

// One rule for "which opencode session does --resume continue", shared by
// `task --resume-last` and `task-resume-candidate`. They used to disagree:
// `--resume-last` took the newest job of any kind and any status (a stale
// `running` review could win) while the candidate query — the one the rescue
// command shows the user before asking them to approve it — filtered to
// completed tasks. The user approved one session and the run continued another.
//
// `incomplete` is deliberately eligible: resuming an unfinished run to ask for
// the final answer is exactly the recovery P-COMPLETE recommends. `cancelled`
// (the user stopped it on purpose) and `failed (orphaned)` (nothing is known
// about how far it got) are not — name those with `--resume-session <id>`.
const RESUMABLE_STATUSES = new Set(["completed", "incomplete", "failed"]);

export function pickResumeCandidate(jobs, { sessionId = null, includeIncomplete = true } = {}) {
  const candidates = jobs
    .filter((job) => job.kind === "task" && job.opencodeSessionId)
    .filter((job) => RESUMABLE_STATUSES.has(job.status))
    .filter((job) => includeIncomplete || job.status !== "incomplete")
    .filter((job) => !(job.status === "failed" && job.failureClass === "orphaned"))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));

  return candidates.find((job) => sessionId && job.sessionId === sessionId) ?? candidates[0] ?? null;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
