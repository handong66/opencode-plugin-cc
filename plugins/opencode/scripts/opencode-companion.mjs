#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { tokenize, parseFlags } from "./lib/args.mjs";
import { extractClaudeMessages, buildHandoffTranscript } from "./lib/claude-transcript.mjs";
import { collectReviewInput } from "./lib/git.mjs";
import { classifyOutcome, getOpencodeAvailability, runOpencode } from "./lib/opencodecli.mjs";
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

async function executeJob({ kind, cwd, opencodeOptions, promptPreview, model = null, variant = null }) {
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

  const outcome = await runOpencode(opencodeOptions, {
    cwd,
    logFile,
    onSpawn: (child) => upsertJob(cwd, { id: jobId, childPid: child.pid }),
    // Parsing a multi-hundred-KB event stream and rendering it takes real time,
    // and for all of it the child pid is already dead while this record still
    // says `running`. Dropping the pid here moves the record onto the grace
    // window instead, so a concurrent reader cannot reconcile a live run.
    onExit: () => upsertJob(cwd, { id: jobId, childPid: null })
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
    failureClass: null,
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
  const { flags, rest, errors } = parseFlags(tokens, {
    valueFlags: ["--model", "--variant", "--effort"],
    booleanFlags: ["--json", "--write", "--read-only", "--resume-last", "--wait", "--background"]
  });
  const asJson = flags.has("--json");
  if (errors.length > 0) {
    print(`Invalid arguments: ${errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  const taskText = rest.join(" ").trim();
  if (!taskText) {
    print("No task text provided. Tell opencode what to investigate, fix, or continue.");
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
      stderrTail: ok ? undefined : payload.stderrTail
    });
  } else {
    print(payload.rendered);
  }
  process.exitCode = exitCodeForOutputState(outputState);
}

async function commandReview(tokens, { adversarial }) {
  const { flags, rest, errors } = parseFlags(tokens, {
    valueFlags: ["--base", "--scope"],
    booleanFlags: ["--json", "--wait", "--background"]
  });
  if (errors.length > 0) {
    print(`Invalid arguments: ${errors.join("; ")}`);
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

function commandResult(tokens) {
  const { flags, rest } = parseFlags(tokens, { booleanFlags: ["--json"] });
  const cwd = process.cwd();
  const job = pickJob(cwd, rest[0] ?? null, (candidate) =>
    ["completed", "failed", "incomplete"].includes(candidate.status)
  );

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

function commandHelp() {
  print(
    [
      "opencode-companion — helper runtime for the opencode Claude Code plugin",
      "",
      "Subcommands:",
      "  setup [--json] [--enable-review-gate|--disable-review-gate]",
      "  task [--json] [--model <provider/model>] [--variant <v>] [--write|--read-only] [--resume-last] <task text>",
      "  review [--base <ref>] [--scope auto|working-tree|branch]",
      "  adversarial-review [--base <ref>] [--scope ...] [focus text]",
      "  status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  result [job-id] [--json]",
      "  cancel [job-id]",
      "  task-resume-candidate [--json]",
      "  transfer [--source <claude-jsonl>] [--model <provider/model>]"
    ].join("\n")
  );
}

async function main() {
  const [, , subcommand, ...restArgv] = process.argv;
  // Slash commands forward `$ARGUMENTS` as one string that needs tokenizing;
  // programmatic callers (like the stop gate) pass pre-split argv whose
  // elements — especially multi-line prompts — must stay verbatim.
  const tokens = restArgv.length > 1 ? restArgv : tokenize(restArgv[0] ?? "");

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
