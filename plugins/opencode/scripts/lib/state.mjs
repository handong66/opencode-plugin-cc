import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive } from "./process.mjs";
import { DATA_DIR_ENV, PLUGIN_DATA_ENV } from "./session-env.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
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
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
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
  // Prefer the namespaced dir exported by our SessionStart hook; the shared
  // CLAUDE_PLUGIN_DATA name may hold another plugin's dir in Bash contexts.
  const pluginDataDir = process.env[DATA_DIR_ENV] || process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
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

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
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

export function saveState(cwd, state) {
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

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
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
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
