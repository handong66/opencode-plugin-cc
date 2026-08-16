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
  classifyFailure,
  classifyOutcome,
  detectPermissionWarnings,
  getOpencodeAvailability,
  parseEventStream,
  readOpencodeModelConfig,
  resolveRunSelection,
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
import { COMPANION_BIN_ENV, READY_ENV, SESSION_ID_ENV, TRANSCRIPT_PATH_ENV } from "./lib/session-env.mjs";
import {
  describeStateLocation,
  findJob,
  generateJobId,
  getConfig,
  listJobs,
  pickResumeCandidate,
  readJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateLocation,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_PATH = fileURLToPath(import.meta.url);
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

// Where the job store resolved, and why — on stderr, never stdout, because
// `commands/result.md` and `commands/status.md` require Claude to relay stdout
// verbatim. Printed once per process, before anything touches the store.
let stateLocationWarned = false;
function warnAboutStateLocation(cwd) {
  if (stateLocationWarned) {
    return;
  }
  stateLocationWarned = true;
  const warning = describeStateLocation(cwd);
  if (warning) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

// A bare "No job found with id X" cannot distinguish a typo from the wrong
// workspace, a store that resolved elsewhere, or a pruned job — one such
// message cost two hours in 2026-07. Only id/kind/status of recent jobs are
// listed: prompt previews must not leak into an error path.
function describeMissingJob(cwd, jobId) {
  const location = resolveStateLocation(cwd);
  const lines = [`No job found with id ${jobId}.`, `Workspace root: ${location.workspaceRoot}`, `Job store: ${location.dir} (${location.source})`];
  let recent = [];
  try {
    recent = listJobs(cwd).slice(0, 5);
  } catch {
    recent = [];
  }
  if (recent.length === 0) {
    lines.push("This store holds no jobs at all — check that you are in the right repository, or run /opencode:setup to see where state resolves.");
  } else {
    lines.push("Most recent jobs in this store:");
    for (const job of recent) {
      lines.push(`  ${job.id} | ${job.kind} | ${describeJobStatus(job)}`);
    }
  }
  return lines.join("\n");
}

function claudeSessionId() {
  return process.env[SESSION_ID_ENV] || null;
}

function requireOpencodeReady({ asJson }) {
  // The Stop hook probes availability before it spawns this process; running
  // `opencode --version` + `opencode auth list` again costs ~1.1s per stop for
  // an answer the parent already has.
  if (process.env[READY_ENV] === "1") {
    return { available: true, usable: true, authenticated: true, checkedByParent: true };
  }
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

// X5: which copy of the plugin is running. Callers hard-coded versioned cache
// paths (`.../opencode/0.1.0/scripts/...`) and guessed at layouts; one session
// spent 3.5 hours pinned to a stale copy without knowing it. Reported wherever
// somebody debugging that would look.
let cachedVersion;
function pluginVersion() {
  if (cachedVersion === undefined) {
    try {
      cachedVersion = JSON.parse(
        fs.readFileSync(path.join(ROOT_DIR, ".claude-plugin", "plugin.json"), "utf8")
      ).version ?? null;
    } catch {
      cachedVersion = null;
    }
  }
  return cachedVersion;
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split(/[.+-]/).map((part) => Number(part) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) - (b[index] ?? 0);
    }
  }
  return 0;
}

// A newer copy sitting next to this one in the plugin cache means the caller
// reached this file by a versioned path or a `find`, not by the entry point the
// SessionStart hook exports.
function describeNewerInstall() {
  const version = pluginVersion();
  if (!version) {
    return null;
  }
  // .../<cache>/<plugin>/<version>/plugins/opencode → the version dir is 3 up.
  const versionDir = path.resolve(ROOT_DIR, "..", "..");
  const siblingRoot = path.dirname(versionDir);
  if (path.basename(versionDir) !== version) {
    return null;
  }
  let siblings = [];
  try {
    siblings = fs.readdirSync(siblingRoot);
  } catch {
    return null;
  }
  const newer = siblings
    .filter((entry) => /^\d+\.\d+/.test(entry) && compareVersions(entry, version) > 0)
    .sort(compareVersions)
    .at(-1);
  if (!newer) {
    return null;
  }
  return `a newer install of this plugin exists (${newer}) but you are running ${version} from ${ROOT_DIR}. Use $${COMPANION_BIN_ENV} (exported at SessionStart) or "\${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" instead of a versioned path.`;
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
            resultComplete: false,
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
            resultComplete: false,
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
  asJson = false,
  extraWarnings = []
}) {
  warnAboutStateLocation(cwd);
  const jobId = generateJobId(JOB_ID_PREFIXES[kind] ?? "job");
  const logFile = resolveJobLogFile(cwd, jobId);

  // Recorded before the run, from the same inputs `buildOpencodeArgs` uses, so
  // "which model actually reviewed this" is answerable from the job record
  // rather than from the caller's memory of what they did not pass.
  const selection = resolveRunSelection({
    model,
    variant,
    readOnly: opencodeOptions.readOnly === true,
    cwd
  });

  upsertJob(cwd, {
    id: jobId,
    kind,
    status: "running",
    cwd,
    sessionId: claudeSessionId(),
    model: selection.model,
    requestedModel: model,
    modelSource: selection.source,
    // Before the run this is a prediction from opencode's config files, not an
    // observation; the event stream upgrades it when it names the model.
    modelCertainty: selection.certainty,
    agent: selection.agent,
    variant: selection.variant,
    promptPreview: firstLine(promptPreview, 160),
    logFile,
    startedAt: new Date().toISOString()
  });

  // The handle goes out before the run starts, not in the footer afterwards: a
  // caller who detaches the companion with Bash(run_in_background: true) — 28
  // recorded times — otherwise has no id to poll until the run is already over.
  // In --json mode it goes to stderr so stdout stays a single JSON document.
  const handle = { jobId, logFile, pollWith: `/opencode:status ${jobId}`, companionVersion: pluginVersion() };
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
    hasStructuredOutput: Boolean(parsed.structuredOutput),
    structuredOutputInvalid: Boolean(parsed.expectedStructuredOutput) && !parsed.structuredOutput
  });
  const ok = classification.state === "completed";
  const incomplete = classification.state === "incomplete";
  for (const warning of classification.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  // Typed, actionable warnings derived from what opencode said on stderr while
  // still exiting 0 — chiefly an auto-rejected read of a path outside the repo.
  const warnings = [
    ...extraWarnings,
    ...selection.warnings,
    ...detectPermissionWarnings(outcome.stderrTail, { cwd })
  ];
  // X1: a headless delegate that opens by loading an interactive skill spends
  // turns and wall time on it before any of the requested work happens. The
  // prompt preamble forbids it; this makes a preamble that did not take visible.
  // X2: how much work stood behind the verdict. In this plugin the diff is
  // inlined into the review prompt, so 0 tool calls is not automatically an
  // ungrounded review — but it does mean nothing outside the diff was looked at.
  const evidenceLevel =
    classification.toolEventCount === 0 ? "none" : classification.toolEventCount <= 2 ? "thin" : "substantive";
  const isReviewKind = kind === "review" || kind === "adversarial-review";
  const noEvidenceReview = isReviewKind && evidenceLevel === "none";
  if (noEvidenceReview) {
    warnings.push({
      class: "no_evidence_review",
      message:
        "no_evidence_review: this verdict was produced with 0 tool calls. The diff was inlined in the prompt, so the verdict can only be defended for what the diff itself shows — no caller, test, or adjacent file was inspected. Treat an `approve` here as an opinion, not a completed review."
    });
  }
  // The zero-evidence downgrade the SPEC asks for, as a field rather than as a
  // status: a caller must be able to discard the verdict without parsing a
  // warning string. It is deliberately separate from `outputState` — the run
  // itself did complete, and folding this into the three-state classifier would
  // make "the model produced no answer" and "the model answered without looking
  // at anything" the same value, which is exactly what X2 is about telling apart.
  const resultComplete = ok && !noEvidenceReview;

  const skillsLoaded = parsed.skillsLoaded ?? [];
  if (skillsLoaded.length > 0) {
    warnings.push({
      class: "skills_loaded",
      skills: skillsLoaded,
      message: `skills_loaded: opencode spent turns loading interactive skills before the work (${skillsLoaded.join(", ")}). The plugin's prompts tell it not to, so a repository bootstrap file (AGENTS.md / CLAUDE.md) is probably overriding them.`
    });
  }
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning.message}\n`);
  }
  // The run itself is the authority on which model answered. `resolveRunSelection`
  // can only predict it from config files, and opencode's own precedence takes
  // a project-level config and its environment into account as well — so a
  // prediction is labelled as one until the stream confirms it.
  const observedModel = parsed.observedModel ?? null;
  const payload = {
    kind,
    model: observedModel ?? selection.model,
    agent: selection.agent,
    variant: selection.variant,
    modelSource: observedModel ? "event-stream" : selection.source,
    modelCertainty: observedModel ? "actual" : selection.certainty,
    rawOutput: parsed.text ?? "",
    structuredOutput: parsed.structuredOutput ?? null,
    structuredOutputErrors: parsed.structuredOutputErrors ?? [],
    stopReason: parsed.stopReason ?? null,
    outputState: classification.state,
    outputStateReason: classification.reason,
    resultComplete,
    toolEventCount: classification.toolEventCount,
    opencodeSessionId: parsed.sessionId ?? null,
    exitCode: outcome.exitCode,
    spawnError: outcome.spawnError,
    stderrTail: outcome.stderrTail,
    warnings,
    skillsLoaded,
    evidenceLevel,
    timedOut: Boolean(outcome.timedOut),
    timeoutMs,
    durationMs: outcome.durationMs
  };

  // `cancel` (or session teardown) may have marked the job while opencode was
  // being killed; that terminal state wins over the exit-code verdict.
  // Reconciliation is skipped here: this process owns the run and is about to
  // write the real verdict, so the just-exited child must not read as orphaned.
  const wasCancelled = findJob(cwd, jobId, { reconcile: false })?.status === "cancelled";
  // A real verdict clears any label reconciliation wrote while this run was in
  // flight; `upsertJob` merges, so omitting the key would keep it. The
  // companion's own reason (it stopped the run) wins over the provider's.
  const failureClass =
    wasCancelled || ok || incomplete
      ? null
      : payload.timedOut
        ? "timeout"
        : // stderr only: the model's own answer is not evidence about the
          // provider, and scanning it labelled runs from their own prose.
          classifyFailure({
            exitCode: outcome.exitCode,
            spawnError: outcome.spawnError,
            stderrTail: outcome.stderrTail
          });
  payload.failureClass = failureClass;
  const job = {
    id: jobId,
    kind,
    status: wasCancelled ? "cancelled" : ok ? "completed" : incomplete ? "incomplete" : "failed",
    failureClass,
    model: payload.model,
    modelSource: payload.modelSource,
    modelCertainty: payload.modelCertainty,
    outputState: classification.state,
    outputStateReason: classification.reason,
    // On the record as well as in the payload: a fan-in poller reading
    // `status --all --json` must be able to tell a usable answer from a
    // finished-but-empty one without a second call per job.
    resultComplete,
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
    valueFlags: ["--model", "--variant", "--effort", "--timeout-ms", "--prompt-file", "--resume-session"],
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
  if (flags.has("--resume-last") && flags.get("--resume-session")) {
    print(
      "Pass either --resume-last (pick the newest resumable task) or --resume-session <ses_id> (continue a named session), not both."
    );
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

  let resumeSessionId = flags.get("--resume-session") ?? null;
  let resumedFrom = resumeSessionId ? { jobId: null, opencodeSessionId: resumeSessionId } : null;
  if (flags.has("--resume-last")) {
    const candidate = pickResumeCandidate(listJobs(cwd), { sessionId: claudeSessionId() });
    if (candidate) {
      resumeSessionId = candidate.opencodeSessionId;
      resumedFrom = { jobId: candidate.id, opencodeSessionId: candidate.opencodeSessionId };
    }
    // Which session was picked was previously invisible, so a heuristic that
    // chose a different job from the one the user approved never showed up.
    // Both outcomes are narration, and under `--json` stdout is a single JSON
    // document (PC1), so both go to stderr there. Only the success branch used
    // to: a repository with nothing to resume — the ordinary state of a fresh
    // one — printed a sentence in front of the payload and broke JSON.parse.
    const line = candidate
      ? `Resuming opencode session ${candidate.opencodeSessionId} (from job ${candidate.id}: ${candidate.promptPreview ?? candidate.summary ?? "no prompt recorded"})`
      : "No previous opencode session found for this repository; starting a fresh run.";
    if (asJson) {
      process.stderr.write(`${line}\n`);
    } else {
      print(line);
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
      resultComplete: payload.resultComplete,
      failureClass: payload.failureClass,
      stopReason: payload.stopReason,
      toolEventCount: payload.toolEventCount,
      evidenceLevel: payload.evidenceLevel,
      // The run's own report of which model answered, on the document the
      // caller is actually reading. It was computed, stored and exposed through
      // `status`/`result`, but not here — so a caller following the release note
      // and branching on `modelCertainty === "actual"` read undefined.
      model: payload.model,
      modelSource: payload.modelSource,
      modelCertainty: payload.modelCertainty,
      agent: payload.agent,
      variant: payload.variant,
      rawOutput: payload.rawOutput,
      opencodeSessionId: payload.opencodeSessionId,
      resumedFrom,
      exitCode: payload.exitCode,
      timedOut: payload.timedOut,
      warnings: payload.warnings,
      stderrTail: ok ? undefined : payload.stderrTail
    });
  } else {
    print(payload.rendered);
  }
  process.exitCode = exitCodeForOutputState(outputState);
}

const REVIEW_SCOPES = ["auto", "working-tree", "branch"];
// X3: an adversarial review with no stated boundary reports network-attacker
// findings against a single-user local tool, and those findings then interrupt
// the user's actual task. The user's own words: "please stop interrupting my
// task" — so the boundary is an input, and out-of-model findings are advisory.
const DEFAULT_THREAT_MODEL =
  "No threat model was supplied by the caller. Unless the repository itself says otherwise, assume a single-user local application with no network exposure and no untrusted input.";
const REVIEW_VALUE_FLAGS = [
  "--base",
  "--head",
  "--scope",
  "--paths",
  "--files",
  "--rubric-file",
  "--model",
  "--variant",
  "--timeout-ms"
];
// `--threat-model` is only meaningful where a prompt has a slot for it. It used
// to sit in the shared flag list, so plain `review` accepted it, escaped the
// unknown-flag rejection, and then dropped it during interpolation because
// `prompts/review.md` has no `{{THREAT_MODEL}}` — documented nowhere, rejected
// nowhere, honoured nowhere. Accept-and-forward or reject-with-the-list; this
// is the reject side of that choice.
function reviewFlagSummary(adversarial) {
  const flags = [...REVIEW_VALUE_FLAGS, ...(adversarial ? ["--threat-model <text>"] : [])]
    .map((flag) => (flag === "--base" ? "--base <ref|A..B|A...B>" : flag))
    .join(", ");
  return `Supported: ${flags}, --json.${
    adversarial ? "" : " (--threat-model is an adversarial-review flag: only that prompt judges findings against a boundary.)"
  }`;
}

async function commandReview(tokens, { adversarial }) {
  const { flags, rest, errors, unknownFlags } = parseFlags(tokens, {
    valueFlags: adversarial ? [...REVIEW_VALUE_FLAGS, "--threat-model"] : REVIEW_VALUE_FLAGS,
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
  // A flag this command does not know used to land in `rest`, which only the
  // adversarial path reads — so `--scpoe branch` ran a default review and said
  // nothing. Same family as P-HELP's leading unknown flag on `task`.
  if (unknownFlags.length > 0) {
    print(`Unknown flag: ${unknownFlags[0]}. ${reviewFlagSummary(adversarial)}`);
    process.exitCode = 1;
    return;
  }
  // An unvalidated scope silently reviewed something else: `--scope staged` and
  // `--scope unstaged` are documented as unsupported, and both fell through to
  // the working-tree branch, whose output was then relayed as authoritative.
  const scope = flags.get("--scope") ?? "auto";
  if (!REVIEW_SCOPES.includes(scope)) {
    print(
      `Unsupported --scope "${scope}". Use one of: ${REVIEW_SCOPES.join(", ")}. (Staged-only and unstaged-only reviews are not supported; review the working tree, or commit and use --base <ref>.)`
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
  const asJson = flags.has("--json");
  if (!requireOpencodeReady({ asJson })) {
    return;
  }

  const cwd = process.cwd();
  // `--paths a,b` and `--paths 'src/**'` are both common; so is repeating the
  // idea as `--files`. They mean the same thing to git.
  const paths = [flags.get("--paths"), flags.get("--files")]
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  let rubric = null;
  if (flags.get("--rubric-file")) {
    try {
      rubric = fs.readFileSync(path.resolve(flags.get("--rubric-file")), "utf8").trim();
    } catch (error) {
      print(
        `Could not read --rubric-file ${flags.get("--rubric-file")}: ${error instanceof Error ? error.message : error}`
      );
      process.exitCode = 1;
      return;
    }
  }

  let reviewInput;
  try {
    reviewInput = collectReviewInput(cwd, {
      base: flags.get("--base") ?? null,
      head: flags.get("--head") ?? null,
      scope,
      paths
    });
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (reviewInput.isEmpty) {
    // Nothing to review is not a failure, so the exit code stays 0 — which is
    // exactly why the sentence alone was not enough for a caller under
    // `--json`: no JSON document to parse and no field to branch on, on the
    // most benign path a fan-in scheduler hits (a clean tree, a path filter
    // that matched nothing). The document carries the same keys as a real
    // review so a consumer can read `review` / `warnings` without a shape
    // check, with `outputState: "empty"` and `isEmpty` as the branch.
    if (asJson) {
      printJson({
        ok: true,
        // No run happened, so every field a run would fill is null — the keys
        // are still here so a consumer never has to shape-check the document.
        jobId: null,
        outputState: "empty",
        outputStateReason: "nothing-to-review",
        isEmpty: true,
        label: reviewInput.label,
        resultComplete: false,
        failureClass: null,
        stopReason: null,
        toolEventCount: 0,
        evidenceLevel: null,
        model: null,
        modelSource: null,
        modelCertainty: null,
        agent: null,
        variant: null,
        warnings: [],
        review: null,
        rawOutput: ""
      });
    } else {
      print(`Nothing to review: no changes found for ${reviewInput.label}.`);
    }
    return;
  }

  // Focus text now reaches both reviewers. `review` used to drop it silently,
  // which is one of the reasons callers rebuilt reviews in their own prompts
  // instead of using this command.
  const focus = rest.join(" ").trim();
  const templateName = adversarial ? "adversarial-review" : "review";
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  const threatModel = flags.get("--threat-model");
  const prompt = interpolateTemplate(template, {
    TARGET_LABEL: reviewInput.label,
    REVIEW_INPUT: reviewInput.input,
    USER_FOCUS: focus || "(none provided)",
    SEVERITY_RUBRIC: rubric
      ? `The caller supplied this severity vocabulary. Map their terms onto the schema's \`critical|high|medium|low\` enum — the JSON shape does not change — and use their definitions when deciding how severe a finding is:\n${rubric}`
      : "No custom severity vocabulary was supplied; use the schema's own critical/high/medium/low definitions.",
    // Only the adversarial template has a `{{THREAT_MODEL}}` slot, and only the
    // adversarial parser accepts the flag, so the value is never built for a
    // template that would silently discard it.
    ...(adversarial
      ? {
          THREAT_MODEL: threatModel
            ? `The caller states the boundary of this system as: ${threatModel}`
            : DEFAULT_THREAT_MODEL
        }
      : {})
  });

  const kind = adversarial ? "adversarial-review" : "review";
  const model = flags.get("--model") ?? null;
  const variant = flags.get("--variant") ?? null;
  // Truncation existed only as a sentence buried in the prompt, where the
  // caller could not see it and the reviewer decided whether to mention it.
  const extraWarnings = reviewInput.truncated
    ? [
        {
          class: "review_input_truncated",
          message: `review_input_truncated: the diff for ${reviewInput.label} is ${reviewInput.totalChars} characters and was cut to ${reviewInput.truncatedAtChars} before being sent. The reviewer did not see the rest — narrow the target with --paths/--files or a smaller range before trusting a verdict of "no findings".`
        }
      ]
    : [];
  const { ok, jobId, outputState, payload } = await executeJob({
    kind,
    cwd,
    model,
    variant,
    extraWarnings,
    timeoutMs: timeout.timeoutMs,
    asJson,
    promptPreview: adversarial
      ? `adversarial review of ${reviewInput.label}${focus ? `: ${focus}` : ""}`
      : `review of ${reviewInput.label}`,
    opencodeOptions: {
      prompt,
      model,
      variant,
      readOnly: true,
      rules: REVIEW_RULES,
      jsonSchema: loadReviewSchema(),
      title: `Claude Code ${kind} of ${firstLine(reviewInput.label, 50)}`
    }
  });

  if (asJson) {
    printJson({
      ok,
      // `task --json` has always carried the handle; a review's was only on the
      // stderr handle line, so a caller that wanted to fetch the full payload
      // later had to scrape it back out of narration.
      jobId,
      outputState,
      outputStateReason: payload.outputStateReason,
      resultComplete: payload.resultComplete,
      failureClass: payload.failureClass,
      stopReason: payload.stopReason,
      toolEventCount: payload.toolEventCount,
      evidenceLevel: payload.evidenceLevel,
      // Which model reviewed the work is the first thing a caller weighing a
      // verdict needs, and read-only reviews run on the `plan` agent's model.
      model: payload.model,
      modelSource: payload.modelSource,
      modelCertainty: payload.modelCertainty,
      agent: payload.agent,
      variant: payload.variant,
      warnings: payload.warnings,
      review: payload.structuredOutput,
      rawOutput: payload.rawOutput
    });
  } else {
    print(payload.rendered);
  }
  process.exitCode = exitCodeForOutputState(outputState);
}

// X10: 0.1-era plugins wrote job state into the user's repository. The user
// asked for those directories to be gitignored at the time; one was still
// present a month later, and a sibling project's lint run failed on it. Only
// reported, never deleted: this is the user's working tree.
const LEGACY_STATE_DIRS = [".opencode-plugin-codex", ".grok-plugin-codex", ".opencode-plugin-cc"];

function findLegacyStateDirs(cwd) {
  return LEGACY_STATE_DIRS.map((name) => path.join(cwd, name)).filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
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
  const modelConfig = availability.available
    ? readOpencodeModelConfig({ cwd })
    : { model: null, agentModels: { plan: null, build: null }, files: [] };
  const defaultModel = modelConfig.model;
  // The plugin's own read-only runs go through the `plan` agent, so this is the
  // model that will actually review the user's work — and it is a different one
  // whenever the config sets `agent.plan.model`.
  const readOnlyModel = modelConfig.agentModels.plan ?? defaultModel;
  const report = {
    ok: availability.available && availability.usable,
    opencodeAvailable: availability.available,
    authenticated: Boolean(availability.authenticated),
    credentialCount: availability.credentialCount ?? 0,
    usable: Boolean(availability.usable),
    version: availability.version ?? null,
    pluginVersion: pluginVersion(),
    companionPath: COMPANION_PATH,
    defaultModel,
    readOnlyModel,
    readOnlyAgent: "plan",
    // Which files those two were read from, in increasing precedence. opencode
    // applies a project-level config over the global one, so naming the sources
    // is the difference between a checkable claim and a guess.
    modelConfigFiles: modelConfig.files ?? [],
    stopReviewGate: gateEnabled,
    nodeVersion: process.version,
    stateDir: resolveStateDir(cwd),
    stateSource: resolveStateLocation(cwd).source,
    legacyStateDirs: findLegacyStateDirs(cwd),
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
  if (availability.available && readOnlyModel && readOnlyModel !== defaultModel) {
    lines.push(
      `Read-only runs (review, adversarial-review, and task without --write) use the plan agent, so they are expected to run on ${readOnlyModel}, not ${defaultModel ?? "the default"} (read from ${(modelConfig.files ?? []).join(", ") || "no config file"}; opencode has the final say).`
    );
  }
  lines.push(`Node: ${process.version}`);
  lines.push(`Plugin: opencode ${pluginVersion() ?? "unknown"} (${COMPANION_PATH})`);
  for (const leftover of findLegacyStateDirs(cwd)) {
    lines.push(
      `Leftover 0.1-era directory: ${leftover}. Job state has lived in a central store since then, so this one is stale and safe to delete — it is not removed automatically. (One such directory made a sibling project's lint run fail.)`
    );
  }
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

// One `status --all --json` call should be enough to run a fan-in barrier over
// several jobs, so it carries how long each has been going and whether its
// answer is usable — the two things a scheduler otherwise re-derives per job.
// A running job counts up from its creation; a finished one is frozen at its
// recorded duration (a reconciled orphan freezes at its last sign of life).
function withElapsed(job) {
  const running = job.status === "running" || job.status === "queued";
  const createdAt = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const elapsedMs = running
    ? Number.isFinite(createdAt)
      ? Date.now() - createdAt
      : null
    : (job.durationMs ?? null);
  return { ...job, elapsedMs, resultComplete: job.resultComplete ?? null };
}

// `parseFlags` records `--timeout-ms requires a value` and then carries on, so
// the flag simply reads as unset — and `status --wait --timeout-ms` fell back to
// the 15-minute default and blocked for it without ever printing the error it
// had already produced. Only `task` and `review` read `errors`; these two are
// the rest of that family.
function rejectsFlagProblems({ errors, unknownFlags }, { command, supported }) {
  if (errors.length > 0) {
    print(`Invalid arguments: ${errors.join("; ")}`);
    process.exitCode = 1;
    return true;
  }
  if (unknownFlags.length > 0) {
    print(`Unknown flag: ${unknownFlags[0]}. Supported: ${supported}. Run '${command} --help' for the full list.`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

async function commandStatus(tokens) {
  const { flags, rest, errors, unknownFlags } = parseFlags(tokens, {
    valueFlags: ["--timeout-ms"],
    booleanFlags: ["--json", "--all", "--wait"]
  });
  if (
    rejectsFlagProblems(
      { errors, unknownFlags },
      { command: "status", supported: "--json, --all, --wait, --timeout-ms <ms>" }
    )
  ) {
    return;
  }
  const cwd = process.cwd();
  warnAboutStateLocation(cwd);
  const jobId = rest[0] ?? null;

  if (jobId) {
    let job = findJob(cwd, jobId);
    if (!job) {
      print(describeMissingJob(cwd, jobId));
      process.exitCode = 1;
      return;
    }
    if (flags.has("--wait")) {
      const timeout = resolveTimeoutMs(flags, STATUS_WAIT_DEFAULT_TIMEOUT_MS);
      if (timeout.error) {
        print(timeout.error);
        process.exitCode = 1;
        return;
      }
      const deadline = Date.now() + timeout.timeoutMs;
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
      // `jobId` at the top level, the way `task --json` and `review --json`
      // carry it: a caller that reads `doc.jobId` across the four documents
      // should not have to know that two of them hide the id one level down.
      printJson({
        jobId: job.id,
        job: withElapsed(job),
        hasResult: Boolean(payload),
        resultComplete: payload?.resultComplete ?? job.resultComplete ?? null
      });
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
    const location = resolveStateLocation(cwd);
    printJson({
      jobs: jobs.map(withElapsed),
      stateDir: location.dir,
      stateSource: location.source,
      workspaceRoot: location.workspaceRoot
    });
  } else {
    print(renderJobList(jobs, { gateEnabled: Boolean(getConfig(cwd).stopReviewGate) }));
  }
}

async function commandResult(tokens) {
  const { flags, rest, errors, unknownFlags } = parseFlags(tokens, {
    valueFlags: ["--timeout-ms"],
    booleanFlags: ["--json", "--wait", "--structured-only"]
  });
  if (
    rejectsFlagProblems(
      { errors, unknownFlags },
      { command: "result", supported: "--json, --structured-only, --wait, --timeout-ms <ms>" }
    )
  ) {
    return;
  }
  const cwd = process.cwd();
  warnAboutStateLocation(cwd);
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
        ? describeMissingJob(cwd, rest[0])
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
    // Same reason as `status --json`, and more load-bearing here: called
    // without an id this command picks the newest finished job, so the id it
    // settled on is information the caller has no other way to obtain.
    printJson({ jobId: job.id, job, payload: { ...payload, rendered: undefined } });
    return;
  }

  // The machine-readable review object on its own, for callers that would
  // otherwise slice the rendered prose with `head -c` / `tail -c` — which
  // breaks multi-byte characters and any JSON inside it (two recorded payload
  // corruptions came from exactly that).
  if (flags.has("--structured-only")) {
    if (!payload.structuredOutput) {
      const detail = Array.isArray(payload.structuredOutputErrors) && payload.structuredOutputErrors.length > 0
        ? ` It did not match the review schema: ${payload.structuredOutputErrors.slice(0, 5).join("; ")}.`
        : "";
      print(
        `Job ${job.id} (${job.kind}) has no structured output.${detail} Use /opencode:result ${job.id} for the rendered text, or --json for the whole payload.`
      );
      process.exitCode = 1;
      return;
    }
    printJson(payload.structuredOutput);
    return;
  }

  // `String(x).trim()` never returns null, so the `?? "[no output stored]"`
  // that used to be here could not fire and an empty payload printed a blank
  // line instead of saying it was empty.
  const rendered = String(payload.rendered ?? "").trim();
  const raw = String(payload.rawOutput ?? "").trim();
  print(rendered || raw || `[no output stored for job ${job.id} (status: ${describeJobStatus(job)})]`);
}

function commandCancel(tokens) {
  const { rest } = parseFlags(tokens, { booleanFlags: [] });
  const cwd = process.cwd();
  warnAboutStateLocation(cwd);
  const job = pickJob(cwd, rest[0] ?? null, (candidate) =>
    ["running", "queued"].includes(candidate.status)
  );

  if (!job) {
    print(rest[0] ? describeMissingJob(cwd, rest[0]) : "No running opencode job to cancel.");
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
  // Same rule as `task --resume-last`, on purpose: this is the candidate the
  // rescue command shows the user before asking them to approve a resume.
  const candidate = pickResumeCandidate(listJobs(cwd), { sessionId: claudeSessionId() });

  const report = candidate
    ? {
        available: true,
        jobId: candidate.id,
        opencodeSessionId: candidate.opencodeSessionId,
        status: candidate.status,
        endedAt: candidate.endedAt ?? candidate.updatedAt ?? null,
        promptPreview: candidate.promptPreview ?? null
      }
    : { available: false };

  if (flags.has("--json")) {
    printJson(report);
  } else {
    print(
      report.available
        ? `Resumable opencode session: ${report.opencodeSessionId} (from job ${report.jobId}, ${report.status}: ${report.promptPreview ?? ""})`
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
    "  --resume-last           continue the newest resumable task session in this repo",
    "                          (completed, incomplete or failed tasks; never a cancelled",
    "                          or orphaned one — name those with --resume-session)",
    "  --resume-session <id>   continue exactly this opencode session, no heuristic",
    "  --timeout-ms <ms>       companion-side deadline for the run (default 900000)",
    "  --                      everything after this is task text, never flags",
    ...EXECUTION_FLAG_NOTE,
    "",
    "Exit codes: 0 answer, 1 failed, 2 ran but produced no final answer."
  ],
  review: [
    "usage: opencode-companion review [flags] [focus text]",
    "",
    "  --base <ref|A..B|A...B>  review a commit range instead of the working tree",
    "  --head <ref>            the other end of the range (default HEAD); needs --base,",
    "                          and is rejected on its own rather than reviewing the",
    "                          working tree instead",
    "  --threat-model <text>   rejected here: only adversarial-review judges findings",
    "                          against a boundary",
    "  --paths <glob,...>      limit the review to these pathspecs (--files is an alias)",
    "  --rubric-file <path>    severity vocabulary to judge by (the JSON schema is unchanged)",
    "  --scope auto|working-tree|branch   (staged-only / unstaged-only are rejected)",
    "  --model <provider/model>  override the model (leave unset to use opencode's default)",
    "  --variant <level>       reasoning variant",
    "  --json                  machine-readable result on stdout; a target with no changes",
    "                          in it is a JSON document too (outputState \"empty\", exit 0)",
    "  --timeout-ms <ms>       companion-side deadline for the run (default 900000)",
    ...EXECUTION_FLAG_NOTE,
    "",
    "Any remaining text is passed to the reviewer as extra focus."
  ],
  "adversarial-review": [
    "usage: opencode-companion adversarial-review [flags] [focus text]",
    "",
    "  --base <ref|A..B|A...B>  review a commit range instead of the working tree",
    "  --head <ref>            the other end of the range (default HEAD); needs --base",
    "  --paths <glob,...>      limit the review to these pathspecs (--files is an alias)",
    "  --rubric-file <path>    severity vocabulary to judge by (the JSON schema is unchanged)",
    "  --scope auto|working-tree|branch   (staged-only / unstaged-only are rejected)",
    "  --model <provider/model>  override the model (leave unset to use opencode's default)",
    "  --variant <level>       reasoning variant",
    "  --threat-model <text>   the boundary to judge findings against; findings outside",
    "                          it are labelled out-of-model and cannot block",
    "  --json                  machine-readable result on stdout; a target with no changes",
    "                          in it is a JSON document too (outputState \"empty\", exit 0)",
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
    "  --json                  machine-readable result on stdout",
    "",
    "How long to wait: measured on the recorded corpus, an opencode run finishes",
    "in a median of ~3 minutes, with a p90 near 5.5 minutes for read-only reviews",
    "on the plan agent — roughly 4x the sibling Grok runtime. A 2-minute deadline",
    "is below this runtime's median, so budget above it: 16 of 19 recorded",
    "three-way aggregations recorded an empty opencode slot whose answer arrived",
    "shortly after the decision had been made. `--wait` returns as soon as the job",
    "is terminal, so a generous --timeout-ms costs nothing when the run is quick.",
    "`--all --json` gives every job's elapsedMs and resultComplete in one call."
  ],
  result: [
    "usage: opencode-companion result [job-id] [flags]",
    "",
    "  --wait                  block until the job reaches a terminal state, then print it",
    "  --timeout-ms <ms>       bound for --wait (default 900000)",
    "  --json                  the stored payload as JSON — use this to feed scripts,",
    "                          never head -c/tail -c on the rendered text",
    "  --structured-only       print only the review JSON object (exit 1 if there is none)",
    "",
    "There is no output size limit and no truncation flag: the rendered text is",
    "meant to be relayed verbatim. Slicing it by bytes breaks multi-byte",
    "characters and any embedded JSON — take --json or --structured-only instead."
  ],
  cancel: ["usage: opencode-companion cancel [job-id]", "", "With no id, cancels the newest running job in this repository."],
  "task-resume-candidate": [
    "usage: opencode-companion task-resume-candidate [--json]",
    "",
    "Reports the opencode session /opencode:rescue --resume would continue.",
    "Same selection rule as `task --resume-last`, so what is shown is what runs."
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
  const outdated = describeNewerInstall();
  if (outdated) {
    process.stderr.write(`warning: ${outdated}\n`);
  }
  const perCommand = SUBCOMMAND_HELP[subcommand];
  if (perCommand) {
    print(
      [`opencode-companion ${subcommand} (plugin ${pluginVersion() ?? "unknown"})`, "", ...perCommand].join("\n")
    );
    return;
  }
  print(
    [
      `opencode-companion ${pluginVersion() ?? "unknown"} — helper runtime for the opencode Claude Code plugin`,
      `Running from: ${COMPANION_PATH}`,
      `Job store:    ${resolveStateDir(process.cwd())}`,
      "",
      "Subcommands (run `<subcommand> --help` for its flags):",
      "  setup [--json] [--enable-review-gate|--disable-review-gate]",
      "  task [--json] [--model <provider/model>] [--variant <v>] [--write|--read-only] [--resume-last|--resume-session <id>] [--timeout-ms <ms>] <task text>",
      "  review [--base <ref|A..B> [--head <ref>]] [--paths <globs>] [--scope ...] [--model <m>] [--json] [focus text]",
      "  adversarial-review [--base <ref|A..B> [--head <ref>]] [--paths <globs>] [--threat-model <text>] [focus text]",
      "  status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  result [job-id] [--wait] [--timeout-ms <ms>] [--json|--structured-only]",
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
  // A store owned by another plugin is a configuration problem, not a crash:
  // the message says exactly what to fix, and a stack trace only buries it.
  const message =
    error?.code === "STATE_OWNER_MISMATCH"
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
