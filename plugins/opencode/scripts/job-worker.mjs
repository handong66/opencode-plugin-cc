#!/usr/bin/env node

import process from "node:process";

import {
  claimJobInputFile,
  findJob,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";

const jobId = process.argv[2];
if (!jobId) {
  process.stderr.write("opencode job worker: missing job id\n");
  process.exitCode = 1;
} else {
  const cwd = process.cwd();
  try {
    const spec = claimJobInputFile(cwd, jobId);
    upsertJob(cwd, { id: jobId, workerPid: process.pid, workerClaimedAt: new Date().toISOString() });
    process.env.OPENCODE_COMPANION_JOB_WORKER = "1";
    const { runPreparedJob } = await import("./opencode-companion.mjs");
    await runPreparedJob({ ...spec.prepared, jobId, workerPid: process.pid });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = findJob(cwd, jobId, { reconcile: false });
    if (current && (current.status === "queued" || current.status === "running")) {
      const payload = {
        kind: current.kind,
        outputState: "failed",
        outputStateReason: "worker-start-failed",
        resultComplete: false,
        failureClass: "worker_start_failed",
        rawOutput: "",
        stderrTail: message,
        warnings: [],
        rendered: `OpenCode ${current.kind} job failed before the provider started.\n${message}`
      };
      writeJobFile(cwd, jobId, payload);
      upsertJob(cwd, {
        id: jobId,
        status: "failed",
        failureClass: "worker_start_failed",
        resultComplete: false,
        childPid: null,
        endedAt: new Date().toISOString(),
        summary: message
      });
    }
    process.stderr.write(`opencode job worker ${jobId}: ${message}\n`);
    process.exitCode = 1;
  }
}
