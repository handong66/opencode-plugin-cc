#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectReviewInput } from "./lib/git.mjs";
import { getOpencodeAvailability } from "./lib/opencodecli.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { READY_ENV, SESSION_ID_ENV } from "./lib/session-env.mjs";
import { getConfig, listJobs, setConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// Must stay strictly below the Stop hook budget in hooks/hooks.json
// (`"timeout": 900` seconds). They used to be identical, so Claude Code killed
// the hook at the same instant the friendly "the review timed out" message
// became available and the caller got nothing at all.
const STOP_HOOK_BUDGET_MS = 900 * 1000;
const STOP_REVIEW_TIMEOUT_MS = Math.round(STOP_HOOK_BUDGET_MS * 0.8);
// Two blocks in a row means the session cannot get past this gate on its own.
// A third would be a loop with the user inside it.
const MAX_CONSECUTIVE_BLOCKS = 2;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

// Three verdicts, not two. A gate whose failure mode is "the user cannot end
// the session" must distinguish "the reviewer found a problem" from "the
// review never happened": only the first is worth blocking on, and the four
// infrastructure paths below are the ones this runtime produces most often.
function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { verdict: "error", reason: "the review task returned no final output" };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { verdict: "allow", reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      verdict: "block",
      reason: `opencode stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return { verdict: "error", reason: "the review task answered in an unrecognised format" };
}

function runStopReview(cwd, input = {}, { availabilityChecked = false } = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "opencode-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {}),
    // The hook has already paid for `opencode --version` + `opencode auth list`
    // (~1.1s measured); the child would otherwise run the same two probes.
    ...(availabilityChecked ? { [READY_ENV]: "1" } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      verdict: "error",
      reason: `the review task did not finish within ${Math.round(STOP_REVIEW_TIMEOUT_MS / 60000)} minutes`
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    return {
      verdict: "error",
      reason: detail ? `the review task exited ${result.status}: ${detail}` : `the review task exited ${result.status}`
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return { verdict: "error", reason: "the review task returned invalid JSON" };
  }
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function currentHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

// The cheapest possible answer to "is there anything to review": ask git, not a
// model. `prompts/stop-review-gate.md` already tells the model to allow when
// nothing changed — this turns that intent into a mechanism instead of paying
// for a whole opencode session to be told so. HEAD is checked as well, because
// a turn whose only change has already been committed leaves a clean tree.
function hasNothingToReview(cwd, config) {
  let isEmpty;
  try {
    isEmpty = collectReviewInput(cwd, { scope: "auto" }).isEmpty;
  } catch {
    return false; // Not a git checkout, or git failed: do not skip the review.
  }
  if (!isEmpty) {
    return false;
  }
  const head = currentHead(cwd);
  const seenHead = config.stopGateLastHead ?? null;
  return Boolean(head) && Boolean(seenHead) && head === seenHead;
}

function recordHead(workspaceRoot, cwd) {
  const head = currentHead(cwd);
  if (head) {
    setConfig(workspaceRoot, "stopGateLastHead", head);
  }
}

function consecutiveBlocks(config, sessionId) {
  return config.stopGateBlockSession === sessionId ? Number(config.stopGateBlockCount ?? 0) : 0;
}

function recordBlockOutcome(workspaceRoot, sessionId, count) {
  setConfig(workspaceRoot, "stopGateBlockSession", count > 0 ? sessionId : null);
  setConfig(workspaceRoot, "stopGateBlockCount", count);
}

function main() {
  const input = readHookInput();
  // Claude Code's standard loop breaker: this Stop is the continuation of a
  // Stop this hook already blocked. Deciding again is how a gate turns into a
  // session the user cannot leave.
  if (input.stop_hook_active) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;

  const jobs = filterJobsForCurrentSession(listJobs(workspaceRoot), input);
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `opencode job ${runningJob.id} is still running. Check /opencode:status and use /opencode:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    // Non-blocking, but in the transcript rather than on a stderr channel
    // nobody reads: an unreclaimed job is exactly what the user needs to know
    // about before the session ends.
    if (runningTaskNote) {
      emitDecision({ systemMessage: runningTaskNote });
    }
    return;
  }

  if (hasNothingToReview(cwd, config)) {
    logNote("opencode stop-gate: no working-tree changes since the last stop; skipping the review.");
    if (runningTaskNote) {
      emitDecision({ systemMessage: runningTaskNote });
    }
    return;
  }

  const availability = getOpencodeAvailability();
  if (!availability.available || !availability.usable) {
    logNote(`opencode is not set up for the review gate. ${availability.detail ?? ""} Run /opencode:setup.`);
    if (runningTaskNote) {
      emitDecision({ systemMessage: runningTaskNote });
    }
    return;
  }

  const review = runStopReview(cwd, input, { availabilityChecked: true });
  recordHead(workspaceRoot, cwd);

  // Fail open. A blocked stop caused by the gate's own failure is worse than a
  // missed review: the user is stuck, and this runtime's most common outcome
  // (no final output) hits exactly this path.
  if (review.verdict === "error") {
    recordBlockOutcome(workspaceRoot, sessionId, 0);
    const note = `opencode stop-gate could not complete (${review.reason}); allowing the stop. Run /opencode:review --wait manually.`;
    logNote(note);
    emitDecision({ systemMessage: runningTaskNote ? `${note} ${runningTaskNote}` : note });
    return;
  }

  if (review.verdict === "block") {
    const priorBlocks = consecutiveBlocks(config, sessionId);
    if (priorBlocks >= MAX_CONSECUTIVE_BLOCKS) {
      recordBlockOutcome(workspaceRoot, sessionId, 0);
      const note = `opencode stop-gate has blocked this session ${priorBlocks} times in a row and is standing down so you are not stuck in a loop. Fix the reported findings, or turn the gate off with /opencode:setup --disable-review-gate. Last reason: ${review.reason}`;
      logNote(note);
      emitDecision({ systemMessage: runningTaskNote ? `${note} ${runningTaskNote}` : note });
      return;
    }
    recordBlockOutcome(workspaceRoot, sessionId, priorBlocks + 1);
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  recordBlockOutcome(workspaceRoot, sessionId, 0);
  if (runningTaskNote) {
    emitDecision({ systemMessage: runningTaskNote });
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
