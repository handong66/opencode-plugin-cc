#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { tokenize, parseFlags, splitAtSentinel } from "./lib/args.mjs";
import { extractClaudeMessages, buildHandoffTranscript } from "./lib/claude-transcript.mjs";
import { collectReviewInput } from "./lib/git.mjs";
import {
  classifyOutcome,
  getOpencodeAvailability,
  parseEventStream,
  runOpencode
} from "./lib/opencodecli.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  describeJobStatus,
  fmtDuration,
  firstLine,
  renderIncompleteOutput,
  renderJobDetail,
  renderJobList,
  renderReviewOutput,
  renderTaskFailure,
  renderTaskOutput
} from "./lib/render.mjs";
import { SESSION_ID_ENV, TRANSCRIPT_PATH_ENV } from "./lib/session-env.mjs";
import {
  findJob,
  generateJobId,
  getConfig,
  listJobs,
  readJobFile,
  resolveJobLogFile,
  resolveStateDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const REVIEW_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const REVIEW_RULES =
  "You are running a non-interactive code review job. Never modify files and never run commands with side effects.";
const SETUP_GUIDANCE =
  "Install the opencode CLI so the `opencode` binary is on PATH (e.g. `npm i -g opencode-ai` or `curl -fsSL https://opencode.ai/install | bash`), then sign in with `opencode auth login`. Run /opencode:setup to re-check.";
const STATUS_WAIT_POLL_MS = 2000;
const STATUS_WAIT_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// A backstop, not a budget: opencode runs have a measured p90 of ~5.5 minutes,
// so this only catches runs that are never coming back.
const RUN_TIMEOUT_DEFAULT_MS = 15 * 60 * 1000;
const BACKGROUND_FLAG_MESSAGE =
  "--background is a Claude Code execution flag, not a companion flag; the companion always runs in the foreground. Detach with Bash(run_in_background: true), or use /opencode:rescue --background.";
const JOB_ID_PREFIXES = {
  task: "task",
  review: "review",
  "adversarial-review": "adv",
  transfer: "xfer"
};

function print(text) {
  process.stdout.write(`${text}\n`);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function claudeSessionId() {
  return process.env[SESSION_ID_ENV] || null;
}

function requireOpencodeReady({ asJson }) {
  const availability = getOpencodeAvailability();
  if (availability.available && availability.usable) {
    return availability;
  }
  const reason = availability.available
    ? "opencode is installed but has no usable providers. Run `opencode auth login` (or `!opencode auth login` from Claude Code)."
    : `opencode CLI not found. ${SETUP_GUIDANCE}`;
  if (asJson) {
    printJson({ ok: false, reason, setupRequired: true });
  } else {
    print(`${reason}\nThen retry, or run /opencode:setup for a full readiness report.`);
  }
  process.exitCode = 1;
  return null;
}

function loadReviewSchema() {
  return JSON.parse(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf8"));
}

// `--background` used to be consumed silently so it could not leak into the
// prompt. That also meant a caller who passed it believed the run had been
// detached while it was still on Claude Code's 2-minute Bash wall.
function rejectsBackgroundFlag(flags) {
  if (!flags.has("--background")) {
    return false;
  }
  process.stderr.write(`${BACKGROUND_FLAG_MESSAGE}\n`);
  process.exitCode = 1;
  return true;
}

// The one run this process owns, if any. `opencode` is spawned detached so
// `cancel` can signal its process group, which also means it outlives us unless
// we take it down on the way out.
let inFlightRun = null;
let interruptHandled = false;
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

// Small, synchronous and idempotent by contract: some harnesses follow SIGTERM
// with SIGKILL about two seconds later, and `cancel` / the SessionEnd hook may
// already have written a terminal state for this job.
function handleTerminationSignal(signal) {
  const run = inFlightRun;
  inFlightRun = null;
  if (!interruptHandled) {
    interruptHandled = true;
    try {
      if (run) {
        if (run.childPid) {
          terminateProcessTree(run.childPid);
        }
        const current = findJob(run.cwd, run.jobId, { reconcile: false });
        if (!current || current.status === "running" || current.status === "queued") {
          const parsed = parseEventStream(run.getStdout?.() ?? "");
          const durationMs = Number.isFinite(run.startedAtMs) ? Date.now() - run.startedAtMs : null;
          const interruptedJob = {
            id: run.jobId,
            kind: run.kind,
            status: "failed",
            failureClass: "interrupted",
            durationMs,
            opencodeSessionId: parsed?.sessionId ?? null
          };
          const payload = {
            kind: run.kind,
            rawOutput: parsed?.text ?? "",
            structuredOutput: null,
            stopReason: parsed?.stopReason ?? null,
            outputState: "failed",
            outputStateReason: "interrupted",
            toolEventCount: parsed?.toolEventCount ?? 0,
            opencodeSessionId: parsed?.sessionId ?? null,
            exitCode: null,
            spawnError: null,
            stderrTail: run.getStderrTail?.() ?? "",
            interrupted: true,
            durationMs
          };
          // Rendered here, not on read: whatever opencode had streamed is the
          // only output this job will ever have, and `result <id>` must show it.
          payload.rendered = renderTaskFailure(interruptedJob, payload);
          writeJobFile(run.cwd, run.jobId, payload);
          upsertJob(run.cwd, {
            id: run.jobId,
            status: "failed",
            failureClass: "interrupted",
            childPid: null,
            durationMs,
            endedAt: new Date().toISOString(),
            summary:
              "companion was terminated (Bash timeout or session teardown); opencode child killed"
          });
        }
      }
    } catch {
      // Best effort: a bookkeeping failure must not stop the process from dying.
    }
  }
  // Re-raise with the default disposition so the exit status stays truthful
  // (143 for SIGTERM), which is what the caller's timeout detection reads.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

function installSignalHandlers() {
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, handleTerminationSignal);
  }
}

// Prompt text that never passes through `tokenize` at all. `--prompt-file` is
// the only form that is safe for prompts containing quotes, backticks, angle
// brackets or pipes, because those also have to survive the caller's shell.
function readPromptSource(flags) {
  const file = flags.get("--prompt-file");
  const fromStdin = flags.has("--prompt-stdin");
  if (file && fromStdin) {
    return { error: "Pass either --prompt-file or --prompt-stdin, not both." };
  }
  if (file) {
    try {
      return { text: fs.readFileSync(path.resolve(file), "utf8") };
    } catch (error) {
      return { error: `Could not read --prompt-file ${file}: ${error instanceof Error ? error.message : error}` };
    }
  }
  if (fromStdin) {
    try {
      return { text: fs.readFileSync(0, "utf8") };
    } catch (error) {
      return {
        error: `Could not read the prompt from stdin: ${error instanceof Error ? error.message : error}`
      };
    }
  }
  return null;
}

function resolveTimeoutMs(flags, defaultMs) {
  const raw = flags.get("--timeout-ms");
  if (raw === undefined) {
    return { timeoutMs: defaultMs };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `--timeout-ms must be a positive number of milliseconds (got ${raw}).` };
  }
  return { timeoutMs: value };
}

async function executeJob({
  kind,
  cwd,
  opencodeOptions,
  promptPreview,
  model = null,
  variant = null,
  timeoutMs = RUN_TIMEOUT_DEFAULT_MS,
  asJson = false
}) {
  const jobId = generateJobId(JOB_ID_PREFIXES[kind] ?? "job");
  const logFile = resolveJobLogFile(cwd, jobId);

  upsertJob(cwd, {
    id: jobId,
    kind,
    status: "running",
    cwd,
    sessionId: claudeSessionId(),
    model,
    variant,
    promptPreview: firstLine(promptPreview, 160),
    logFile,
    startedAt: new Date().toISOString()
  });

  // The handle goes out before the run starts, not in the footer afterwards: a
  // caller who detaches the companion with Bash(run_in_background: true) — 28
  // recorded times — otherwise has no id to poll until the run is already over.
  // In --json mode it goes to stderr so stdout stays a single JSON document.
  const handle = { jobId, logFile, pollWith: `/opencode:status ${jobId}` };
  if (asJson) {
    process.stderr.write(`${JSON.stringify(handle)}\n`);
  } else {
    print(`Job: ${jobId} (${kind}, running) — poll with /opencode:status ${jobId}`);
  }

  installSignalHandlers();
  inFlightRun = {
    jobId,
    kind,
    cwd,
    childPid: null,
    startedAtMs: Date.now(),
    getStdout: null,
    getStderrTail: null
  };

  const outcome = await runOpencode(opencodeOptions, {
    cwd,
    logFile,
    timeoutMs,
    onSpawn: (child, buffers) => {
      inFlightRun = { ...inFlightRun, childPid: child.pid, ...buffers };
      upsertJob(cwd, { id: jobId, childPid: child.pid });
    },
    // Parsing a multi-hundred-KB event stream and rendering it takes real time,
    // and for all of it the child pid is already dead while this record still
    // says `running`. Dropping the pid here moves the record onto the grace
    // window instead, so a concurrent reader cannot reconcile a live run.
    onExit: () => {
      if (inFlightRun?.jobId === jobId) {
        inFlightRun = { ...inFlightRun, childPid: null };
      }
      upsertJob(cwd, { id: jobId, childPid: null });
    }
  });

  const parsed = outcome.parsed ?? {};
  // Exit code 0 is not a verdict: opencode exits 0 after auto-rejecting a
  // permission request, after burning its tool budget, and after narrating.
  const classification = classifyOutcome({
    exitCode: outcome.exitCode,
    spawnError: outcome.spawnError,
    parsed: outcome.parsed,
    toolEventCount: parsed.toolEventCount ?? 0,
    promptChars: String(opencodeOptions.prompt ?? "").length,
    hasStructuredOutput: Boolean(parsed.structuredOutput)
  });
  const ok = classification.state === "completed";
  const incomplete = classification.state === "incomplete";
  for (const warning of classification.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  const payload = {
    kind,
    rawOutput: parsed.text ?? "",
    structuredOutput: parsed.structuredOutput ?? null,
    stopReason: parsed.stopReason ?? null,
    outputState: classification.state,
    outputStateReason: classification.reason,
    toolEventCount: classification.toolEventCount,
    opencodeSessionId: parsed.sessionId ?? null,
    exitCode: outcome.exitCode,
    spawnError: outcome.spawnError,
    stderrTail: outcome.stderrTail,
    timedOut: Boolean(outcome.timedOut),
    timeoutMs,
    durationMs: outcome.durationMs
  };

  // `cancel` (or session teardown) may have marked the job while opencode was
  // being killed; that terminal state wins over the exit-code verdict.
  // Reconciliation is skipped here: this process owns the run and is about to
  // write the real verdict, so the just-exited child must not read as orphaned.
  const wasCancelled = findJob(cwd, jobId, { reconcile: false })?.status === "cancelled";
  const job = {
    id: jobId,
    kind,
    status: wasCancelled ? "cancelled" : ok ? "completed" : incomplete ? "incomplete" : "failed",
    // A real verdict clears any label reconciliation wrote while this run was
    // in flight; `upsertJob` merges, so omitting the key would keep it.
    failureClass: !wasCancelled && !ok && !incomplete && payload.timedOut ? "timeout" : null,
    outputState: classification.state,
    outputStateReason: classification.reason,
    stopReason: payload.stopReason,
    opencodeSessionId: payload.opencodeSessionId,
    durationMs: outcome.durationMs,
    endedAt: new Date().toISOString(),
    summary: wasCancelled
      ? "cancelled by user"
      : ok
        ? payload.structuredOutput?.verdict
          ? firstLine(`${payload.structuredOutput.verdict}: ${payload.structuredOutput.summary ?? ""}`, 120)
          : firstLine(payload.rawOutput, 120)
        : incomplete
          ? `incomplete (${classification.reason}, stopReason ${payload.stopReason ?? "unknown"}): ${firstLine(payload.rawOutput, 80)}`
          : payload.timedOut
            ? `stopped by the companion after ${timeoutMs}ms (--timeout-ms)`
            : `failed (exit ${outcome.exitCode ?? "?"})`
  };

  const fullJob = { ...findJob(cwd, jobId, { reconcile: false }), ...job };
  payload.rendered = ok
    ? kind === "review" || kind === "adversarial-review"
      ? renderReviewOutput(fullJob, payload)
      : renderTaskOutput(fullJob, payload)
    : incomplete
      ? renderIncompleteOutput(fullJob, payload)
      : renderTaskFailure(fullJob, payload);

  writeJobFile(cwd, jobId, payload);
  upsertJob(cwd, job);
  // The verdict is on disk; a signal from here on is an ordinary interruption
  // of this process and must not rewrite it. Kept in flight until now so a kill
  // during the parse-and-render window still stores the buffered output.
  inFlightRun = null;

  return { ok, incomplete, outputState: classification.state, jobId, job: fullJob, payload };
}

// 0 = a real answer, 1 = the run failed, 2 = the run ended without an answer.
function exitCodeForOutputState(outputState) {
  if (outputState === "completed") {
    return 0;
  }
  return outputState === "incomplete" ? 2 : 1;
}

async function commandTask(tokens) {
  const { flags, rest, errors, unknownFlags } = parseFlags(tokens, {
    valueFlags: ["--model", "--variant", "--effort", "--timeout-ms", "--prompt-file"],
    booleanFlags: [
      "--json",
      "--write",
      "--read-only",
      "--resume-last",
      "--wait",
      "--background",
      "--prompt-stdin"
    ]
  });
  const asJson = flags.has("--json");
  if (errors.length > 0) {
    print(`Invalid arguments: ${errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }
  if (rejectsBackgroundFlag(flags)) {
    return;
  }
  // A `--flag` before any task text is a mistyped flag, not prose: running it
  // as prompt text is how `--help` cost three real model turns.
  if (unknownFlags.length > 0) {
    print(
      `Unknown flag: ${unknownFlags[0]}. Run 'task --help' for supported flags. (If this was meant as task text, quote it or put it after --.)`
    );
    process.exitCode = 1;
    return;
  }
  const timeout = resolveTimeoutMs(flags, RUN_TIMEOUT_DEFAULT_MS);
  if (timeout.error) {
    print(timeout.error);
    process.exitCode = 1;
    return;
  }

  const promptSource = readPromptSource(flags);
  if (promptSource?.error) {
    print(promptSource.error);
    process.exitCode = 1;
    return;
  }
  const freeText = rest.join(" ").trim();
  if (promptSource && freeText) {
    print(
      `The prompt came from ${flags.get("--prompt-file") ? "--prompt-file" : "--prompt-stdin"}, but there is also free text on the command line (${firstLine(freeText, 60)}). Put everything in one place.`
    );
    process.exitCode = 1;
    return;
  }

  const taskText = (promptSource?.text ?? freeText).trim();
  if (!taskText) {
    print(
      "No task text provided. Tell opencode what to investigate, fix, or continue (use `-- <text>` or --prompt-file <path> to keep quotes and newlines intact)."
    );
    process.exitCode = 1;
    return;
  }

  if (!requireOpencodeReady({ asJson })) {
    return;
  }

  const cwd = process.cwd();
  // Read-only unless the caller explicitly requested a write-capable run.
  const readOnly = flags.has("--read-only") || !flags.has("--write");
  const variant = flags.get("--variant") ?? flags.get("--effort") ?? null;

  let resumeSessionId = null;
  if (flags.has("--resume-last")) {
    const candidate = listJobs(cwd).find((job) => job.opencodeSessionId);
    if (candidate) {
      resumeSessionId = candidate.opencodeSessionId;
    } else {
      print("No previous opencode session found for this repository; starting a fresh run.");
    }
  }

  const { ok, jobId, outputState, payload } = await executeJob({
    kind: "task",
    cwd,
    model: flags.get("--model") ?? null,
    variant,
    timeoutMs: timeout.timeoutMs,
    asJson,
    promptPreview: taskText,
    opencodeOptions: {
      prompt: taskText,
      model: flags.get("--model") ?? null,
      variant,
      resumeSessionId,
      readOnly,
      autoApprove: !readOnly,
      title: `Claude Code task: ${firstLine(taskText, 60)}`
    }
  });

  if (asJson) {
    printJson({
      ok,
      jobId,
      outputState,
      outputStateReason: payload.outputStateReason,
      stopReason: payload.stopReason,
      toolEventCount: payload.toolEventCount,
      rawOutput: payload.rawOutput,
      opencodeSessionId: payload.opencodeSessionId,
      exitCode: payload.exitCode,
      timedOut: payload.timedOut,
      stderrTail: ok ? undefined : payload.stderrTail
    });
  } else {
    print(payload.rendered);
  }
  process.exitCode = exitCodeForOutputState(outputState);
}

async function commandReview(tokens, { adversarial }) {
  const { flags, rest, errors } = parseFlags(tokens, {
    valueFlags: ["--base", "--scope", "--timeout-ms"],
    booleanFlags: ["--json", "--wait", "--background"]
  });
  if (errors.length > 0) {
    print(`Invalid arguments: ${errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }
  if (rejectsBackgroundFlag(flags)) {
    return;
  }
  const timeout = resolveTimeoutMs(flags, RUN_TIMEOUT_DEFAULT_MS);
  if (timeout.error) {
    print(timeout.error);
    process.exitCode = 1;
    return;
  }
  const asJson = flags.has("--json");
  if (!requireOpencodeReady({ asJson })) {
    return;
  }

  const cwd = process.cwd();
  let reviewInput;
  try {
    reviewInput = collectReviewInput(cwd, {
      base: flags.get("--base") ?? null,
      scope: flags.get("--scope") ?? "auto"
    });
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (reviewInput.isEmpty) {
    print(`Nothing to review: no changes found for ${reviewInput.label}.`);
    return;
  }

  const focus = adversarial ? rest.join(" ").trim() : "";
  const templateName = adversarial ? "adversarial-review" : "review";
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  const prompt = interpolateTemplate(template, {
    TARGET_LABEL: reviewInput.label,
    REVIEW_INPUT: reviewInput.input,
    USER_FOCUS: focus || "(none provided)"
  });

  const kind = adversarial ? "adversarial-review" : "review";
  const { ok, outputState, payload } = await executeJob({
    kind,
    cwd,
    timeoutMs: timeout.timeoutMs,
    asJson,
    promptPreview: adversarial
      ? `adversarial review of ${reviewInput.label}${focus ? `: ${focus}` : ""}`
      : `review of ${reviewInput.label}`,
    opencodeOptions: {
      prompt,
      readOnly: true,
      rules: REVIEW_RULES,
      jsonSchema: loadReviewSchema(),
      title: `Claude Code ${kind} of ${firstLine(reviewInput.label, 50)}`
    }
  });

  if (asJson) {
    printJson({
      ok,
      outputState,
      outputStateReason: payload.outputStateReason,
      stopReason: payload.stopReason,
      toolEventCount: payload.toolEventCount,
      review: payload.structuredOutput,
      rawOutput: payload.rawOutput
    });
  } else {
    print(payload.rendered);
  }
  process.exitCode = exitCodeForOutputState(outputState);
}

function readDefaultModelFromConfig() {
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")
  ];
  for (const file of candidates) {
    try {
      const match = fs.readFileSync(file, "utf8").match(/"model"\s*:\s*"([^"]+)"/);
      if (match) {
        return match[1];
      }
    } catch {
      continue;
    }
  }
  return null;
}

function commandSetup(tokens) {
  const { flags } = parseFlags(tokens, {
    booleanFlags: ["--json", "--enable-review-gate", "--disable-review-gate"]
  });
  const cwd = process.cwd();

  if (flags.has("--enable-review-gate")) {
    setConfig(cwd, "stopReviewGate", true);
  }
  if (flags.has("--disable-review-gate")) {
    setConfig(cwd, "stopReviewGate", false);
  }

  const availability = getOpencodeAvailability();
  const gateEnabled = Boolean(getConfig(cwd).stopReviewGate);
  const defaultModel = availability.available ? readDefaultModelFromConfig() : null;
  const report = {
    ok: availability.available && availability.usable,
    opencodeAvailable: availability.available,
    authenticated: Boolean(availability.authenticated),
    credentialCount: availability.credentialCount ?? 0,
    usable: Boolean(availability.usable),
    version: availability.version ?? null,
    defaultModel,
    stopReviewGate: gateEnabled,
    nodeVersion: process.version,
    stateDir: resolveStateDir(cwd),
    guidance: availability.available
      ? availability.authenticated
        ? null
        : "Run `!opencode auth login` to store provider credentials. Without them only free opencode zen models work."
      : SETUP_GUIDANCE
  };

  if (flags.has("--json")) {
    printJson(report);
    return;
  }

  const lines = [];
  lines.push(
    availability.available
      ? `opencode CLI: ready (${availability.version})`
      : `opencode CLI: NOT FOUND. ${SETUP_GUIDANCE}`
  );
  if (availability.available) {
    lines.push(
      availability.authenticated
        ? `Authentication: ${availability.credentialCount} provider credential(s)${defaultModel ? ` (default model ${defaultModel})` : ""}`
        : "Authentication: no stored credentials. Run `!opencode auth login` (free opencode zen models may still work)."
    );
  }
  lines.push(`Node: ${process.version}`);
  lines.push(
    `Stop-time review gate: ${gateEnabled ? "enabled" : "disabled"} (toggle with /opencode:setup --enable-review-gate | --disable-review-gate)`
  );
  print(lines.join("\n"));
}

function pickJob(cwd, jobId, predicate) {
  if (jobId) {
    return findJob(cwd, jobId);
  }
  return listJobs(cwd).find(predicate) ?? null;
}

function readLogTail(logFile, maxLines = 20) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  try {
    const content = fs.readFileSync(logFile, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function commandStatus(tokens) {
  const { flags, rest } = parseFlags(tokens, {
    valueFlags: ["--timeout-ms"],
    booleanFlags: ["--json", "--all", "--wait"]
  });
  const cwd = process.cwd();
  const jobId = rest[0] ?? null;

  if (jobId) {
    let job = findJob(cwd, jobId);
    if (!job) {
      print(`No job found with id ${jobId}.`);
      process.exitCode = 1;
      return;
    }
    if (flags.has("--wait")) {
      const timeoutMs = Number(flags.get("--timeout-ms")) || STATUS_WAIT_DEFAULT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      // findJob reconciles, so a job whose process died returns a terminal
      // status and this loop stops immediately instead of waiting out the
      // whole budget on a record that can never change again.
      while ((job.status === "running" || job.status === "queued") && Date.now() < deadline) {
        await sleep(STATUS_WAIT_POLL_MS);
        job = findJob(cwd, jobId) ?? job;
      }
    }
    const payload = readJobFile(cwd, jobId);
    if (flags.has("--json")) {
      printJson({ job, hasResult: Boolean(payload) });
    } else {
      print(renderJobDetail(job, payload, readLogTail(job.logFile)));
    }
    return;
  }

  const sessionId = claudeSessionId();
  const jobs = listJobs(cwd).filter(
    (job) => flags.has("--all") || !sessionId || !job.sessionId || job.sessionId === sessionId
  );
  if (flags.has("--json")) {
    printJson({ jobs });
  } else {
    print(renderJobList(jobs, { gateEnabled: Boolean(getConfig(cwd).stopReviewGate) }));
  }
}

async function commandResult(tokens) {
  const { flags, rest } = parseFlags(tokens, {
    valueFlags: ["--timeout-ms"],
    booleanFlags: ["--json", "--wait"]
  });
  const cwd = process.cwd();
  const wantsWait = flags.has("--wait");
  const timeout = resolveTimeoutMs(flags, STATUS_WAIT_DEFAULT_TIMEOUT_MS);
  if (timeout.error) {
    print(timeout.error);
    process.exitCode = 1;
    return;
  }
  // Without --wait only a finished job answers; with it, the newest job of any
  // status does, because waiting for the running one is the whole point.
  let job = pickJob(cwd, rest[0] ?? null, (candidate) =>
    wantsWait
      ? ["completed", "failed", "incomplete", "running", "queued"].includes(candidate.status)
      : ["completed", "failed", "incomplete"].includes(candidate.status)
  );

  if (job && wantsWait) {
    // findJob reconciles, so a job whose process died reaches a terminal state
    // and drops out of this loop instead of holding the caller to the deadline.
    const deadline = Date.now() + timeout.timeoutMs;
    while ((job.status === "running" || job.status === "queued") && Date.now() < deadline) {
      await sleep(STATUS_WAIT_POLL_MS);
      job = findJob(cwd, job.id) ?? job;
    }
  }

  if (!job) {
    print(
      rest[0]
        ? `No job found with id ${rest[0]}.`
        : "No finished opencode job found for this repository. Check /opencode:status for running jobs."
    );
    process.exitCode = 1;
    return;
  }

  const payload = readJobFile(cwd, job.id);
  if (!payload) {
    if (job.status === "running" || job.status === "queued") {
      print(`Job ${job.id} is still ${job.status}. Check /opencode:status ${job.id} for progress.`);
    } else {
      print(`No stored output for job ${job.id} (status: ${job.status}).`);
    }
    process.exitCode = 1;
    return;
  }

  if (flags.has("--json")) {
    printJson({ job, payload: { ...payload, rendered: undefined } });
  } else {
    print(payload.rendered ?? String(payload.rawOutput ?? "").trim() ?? "[no output stored]");
  }
}

function commandCancel(tokens) {
  const { rest } = parseFlags(tokens, { booleanFlags: [] });
  const cwd = process.cwd();
  const job = pickJob(cwd, rest[0] ?? null, (candidate) =>
    ["running", "queued"].includes(candidate.status)
  );

  if (!job) {
    print(rest[0] ? `No job found with id ${rest[0]}.` : "No running opencode job to cancel.");
    process.exitCode = rest[0] ? 1 : 0;
    return;
  }
  if (!["running", "queued"].includes(job.status)) {
    print(`Job ${job.id} is already ${describeJobStatus(job)}; nothing to cancel.`);
    return;
  }

  const terminated = terminateProcessTree(job.childPid ?? Number.NaN);
  upsertJob(cwd, {
    id: job.id,
    status: "cancelled",
    // Terminal verdict: drop any `orphaned` label a reader wrote in between.
    failureClass: null,
    endedAt: new Date().toISOString(),
    summary: "cancelled by user"
  });
  print(
    terminated
      ? `Cancelled job ${job.id}.`
      : `Marked job ${job.id} as cancelled (its process had already exited).`
  );
}

function commandTaskResumeCandidate(tokens) {
  const { flags } = parseFlags(tokens, { booleanFlags: ["--json"] });
  const cwd = process.cwd();
  const sessionId = claudeSessionId();
  const candidates = listJobs(cwd).filter(
    (job) => job.kind === "task" && job.status === "completed" && job.opencodeSessionId
  );
  const candidate = candidates.find((job) => sessionId && job.sessionId === sessionId) ?? candidates[0] ?? null;

  const report = candidate
    ? {
        available: true,
        jobId: candidate.id,
        opencodeSessionId: candidate.opencodeSessionId,
        endedAt: candidate.endedAt ?? candidate.updatedAt ?? null,
        promptPreview: candidate.promptPreview ?? null
      }
    : { available: false };

  if (flags.has("--json")) {
    printJson(report);
  } else {
    print(
      report.available
        ? `Resumable opencode session: ${report.opencodeSessionId} (from job ${report.jobId}: ${report.promptPreview ?? ""})`
        : "No resumable opencode session for this repository."
    );
  }
}

// opencode cannot import Claude transcripts natively, so `transfer` distills
// the transcript into a handoff prompt and seeds a fresh opencode session with
// it. That costs one model turn; the reply is a short state summary.
async function commandTransfer(tokens) {
  const { flags } = parseFlags(tokens, { valueFlags: ["--source", "--model"] });
  if (!requireOpencodeReady({ asJson: false })) {
    return;
  }

  const source = flags.get("--source") ?? process.env[TRANSCRIPT_PATH_ENV] ?? null;
  if (!source) {
    print(
      "No Claude transcript path available. Pass --source <path-to-claude-session.jsonl> (the SessionStart hook normally supplies this automatically after a plugin reload)."
    );
    process.exitCode = 1;
    return;
  }

  const resolved = path.resolve(source);
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!resolved.startsWith(`${projectsRoot}${path.sep}`)) {
    print(`The transfer source must live under ${projectsRoot}. Got: ${resolved}`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(resolved) || !resolved.endsWith(".jsonl")) {
    print(`Transfer source not found or not a .jsonl transcript: ${resolved}`);
    process.exitCode = 1;
    return;
  }

  const messages = extractClaudeMessages(resolved);
  if (messages.length === 0) {
    print("The Claude transcript contains no transferable conversation text.");
    process.exitCode = 1;
    return;
  }

  const transcript = buildHandoffTranscript(messages);
  const prompt = [
    "<task>",
    "You are receiving a handoff of a Claude Code session so the user can continue the work in opencode.",
    "Read the transcript below, then reply with:",
    "1. A 3-6 bullet summary of the current state of the work.",
    "2. The most important open items or risks.",
    "Do not modify any files in this turn. Wait for the user's next instruction.",
    "</task>",
    "",
    "<claude_code_transcript>",
    transcript,
    "</claude_code_transcript>"
  ].join("\n");

  const cwd = process.cwd();
  const { ok, outputState, payload } = await executeJob({
    kind: "transfer",
    cwd,
    model: flags.get("--model") ?? null,
    promptPreview: `transfer of Claude session (${messages.length} messages)`,
    opencodeOptions: {
      prompt,
      model: flags.get("--model") ?? null,
      readOnly: true,
      title: "Transferred from Claude Code"
    }
  });

  if (!ok) {
    print(payload.rendered);
    process.exitCode = exitCodeForOutputState(outputState);
    return;
  }

  const lines = ["Transferred this Claude Code session into opencode.", "", payload.rawOutput.trim()];
  if (payload.opencodeSessionId) {
    lines.push("", `opencode session: ${payload.opencodeSessionId}`);
    lines.push(`Continue it in opencode with: opencode -s ${payload.opencodeSessionId}`);
  }
  print(lines.join("\n"));
}

// Help is the only source of truth for what the runtime actually accepts, so it
// is written per subcommand: `task --help` used to be sent to the model as the
// prompt, which answered with a help page for the *opencode CLI* — flags that
// this companion has never had.
const EXECUTION_FLAG_NOTE = [
  "  --background            rejected: it is a Claude Code execution flag. The companion",
  "                          always runs in the foreground. Detach with",
  "                          Bash(run_in_background: true), or use /opencode:rescue --background.",
  "  --wait                  accepted no-op (foreground is already the behaviour)."
];

const SUBCOMMAND_HELP = {
  task: [
    "usage: opencode-companion task [flags] -- <task text kept verbatim>",
    "       opencode-companion task [flags] --prompt-file <path>",
    "       opencode-companion task [flags] <task text>   (tokenized: quotes and newlines are lost)",
    "",
    "  --prompt-file <path>    read the prompt from a file, byte for byte",
    "  --prompt-stdin          read the prompt from stdin, byte for byte",
    "  --json                  machine-readable result on stdout",
    "  --model <provider/model>  override the model (leave unset to use opencode's default)",
    "  --variant <level>       reasoning variant; --effort is an alias",
    "  --write                 allow edits (default is read-only via the plan agent)",
    "  --read-only             force the read-only plan agent",
    "  --resume-last           continue the most recent opencode session in this repo",
    "  --timeout-ms <ms>       companion-side deadline for the run (default 900000)",
    "  --                      everything after this is task text, never flags",
    ...EXECUTION_FLAG_NOTE,
    "",
    "Exit codes: 0 answer, 1 failed, 2 ran but produced no final answer."
  ],
  review: [
    "usage: opencode-companion review [flags]",
    "",
    "  --base <ref>            review <ref>...HEAD instead of the working tree",
    "  --scope auto|working-tree|branch",
    "  --json                  machine-readable result on stdout",
    "  --timeout-ms <ms>       companion-side deadline for the run (default 900000)",
    ...EXECUTION_FLAG_NOTE
  ],
  "adversarial-review": [
    "usage: opencode-companion adversarial-review [flags] [focus text]",
    "",
    "  --base <ref>            review <ref>...HEAD instead of the working tree",
    "  --scope auto|working-tree|branch",
    "  --json                  machine-readable result on stdout",
    "  --timeout-ms <ms>       companion-side deadline for the run (default 900000)",
    ...EXECUTION_FLAG_NOTE,
    "",
    "Any remaining text is passed to the reviewer as extra focus."
  ],
  status: [
    "usage: opencode-companion status [job-id] [flags]",
    "",
    "  --all                   include jobs from other Claude sessions",
    "  --wait                  block until the job reaches a terminal state",
    "  --timeout-ms <ms>       bound for --wait (default 900000)",
    "  --json                  machine-readable result on stdout"
  ],
  result: [
    "usage: opencode-companion result [job-id] [flags]",
    "",
    "  --wait                  block until the job reaches a terminal state, then print it",
    "  --timeout-ms <ms>       bound for --wait (default 900000)",
    "  --json                  the stored payload as JSON — use this to feed scripts,",
    "                          never head -c/tail -c on the rendered text"
  ],
  cancel: ["usage: opencode-companion cancel [job-id]", "", "With no id, cancels the newest running job in this repository."],
  "task-resume-candidate": [
    "usage: opencode-companion task-resume-candidate [--json]",
    "",
    "Reports the opencode session /opencode:rescue --resume would continue."
  ],
  transfer: [
    "usage: opencode-companion transfer [flags]",
    "",
    "  --source <claude-jsonl> transcript to hand off (defaults to the current session)",
    "  --model <provider/model>  override the model for the handoff turn"
  ],
  setup: [
    "usage: opencode-companion setup [flags]",
    "",
    "  --json                  machine-readable readiness report",
    "  --enable-review-gate    run a review at every Stop",
    "  --disable-review-gate   turn that gate back off"
  ]
};

function commandHelp(subcommand = null) {
  const perCommand = SUBCOMMAND_HELP[subcommand];
  if (perCommand) {
    print([`opencode-companion ${subcommand}`, "", ...perCommand].join("\n"));
    return;
  }
  print(
    [
      "opencode-companion — helper runtime for the opencode Claude Code plugin",
      "",
      "Subcommands (run `<subcommand> --help` for its flags):",
      "  setup [--json] [--enable-review-gate|--disable-review-gate]",
      "  task [--json] [--model <provider/model>] [--variant <v>] [--write|--read-only] [--resume-last] [--timeout-ms <ms>] <task text>",
      "  review [--base <ref>] [--scope auto|working-tree|branch] [--timeout-ms <ms>] [--json]",
      "  adversarial-review [--base <ref>] [--scope ...] [--timeout-ms <ms>] [focus text]",
      "  status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  result [job-id] [--wait] [--timeout-ms <ms>] [--json]",
      "  cancel [job-id]",
      "  task-resume-candidate [--json]",
      "  transfer [--source <claude-jsonl>] [--model <provider/model>]",
      "",
      "--timeout-ms bounds one opencode run (task/review, default 900000) or one",
      "wait loop (status/result, default 900000). `opencode run` has no timeout of",
      "its own, so this is the only deadline a stuck run has.",
      "--background and --wait are Claude Code execution flags, not companion flags:",
      "the companion always runs in the foreground. Detach with",
      "Bash(run_in_background: true), or use /opencode:rescue --background."
    ].join("\n")
  );
}

// `--help` only counts while no free text has started, so `task --help` is a
// help request and `task explain the --help output` stays a task. `--` turns it
// off entirely.
function wantsHelp(tokens) {
  for (const token of tokens) {
    if (token === "--") {
      return false;
    }
    if (token === "--help" || token === "-h") {
      return true;
    }
    if (!token.startsWith("-")) {
      return false;
    }
  }
  return false;
}

async function main() {
  const [, , subcommand, ...restArgv] = process.argv;
  // Slash commands forward `$ARGUMENTS` as one string that needs tokenizing;
  // programmatic callers (like the stop gate) pass pre-split argv whose
  // elements — especially multi-line prompts — must stay verbatim.
  // In the single-string form, only the part before a standalone `--` is
  // tokenized: everything after it is prompt text and must survive intact.
  let tokens;
  if (restArgv.length > 1) {
    tokens = restArgv;
  } else {
    const { head, literal } = splitAtSentinel(restArgv[0] ?? "");
    tokens = literal === null ? tokenize(head) : [...tokenize(head), "--", literal];
  }

  // Before dispatch: the switch below only sees argv[2], so `task --help` used
  // to reach `commandTask` and be forwarded to the model as the prompt.
  if (SUBCOMMAND_HELP[subcommand] && wantsHelp(tokens)) {
    return commandHelp(subcommand);
  }

  switch (subcommand) {
    case "setup":
      return commandSetup(tokens);
    case "task":
      return commandTask(tokens);
    case "review":
      return commandReview(tokens, { adversarial: false });
    case "adversarial-review":
      return commandReview(tokens, { adversarial: true });
    case "status":
      return commandStatus(tokens);
    case "result":
      return commandResult(tokens);
    case "cancel":
      return commandCancel(tokens);
    case "task-resume-candidate":
      return commandTaskResumeCandidate(tokens);
    case "transfer":
      return commandTransfer(tokens);
    default:
      return commandHelp();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
