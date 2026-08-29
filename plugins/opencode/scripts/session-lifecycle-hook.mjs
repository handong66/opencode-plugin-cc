#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPANION_BIN_ENV,
  DATA_DIR_ENV,
  PLUGIN_DATA_ENV,
  SESSION_ID_ENV,
  TRANSCRIPT_PATH_ENV
} from "./lib/session-env.mjs";
import { listJobs, resolveStateFile } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  // Export our data dir under a namespaced name only. Re-exporting
  // CLAUDE_PLUGIN_DATA into the shared env file would clobber other plugins
  // (and they clobber us) since the last SessionStart hook to run wins.
  appendEnvVar(DATA_DIR_ENV, process.env[PLUGIN_DATA_ENV]);
  // The entry point of the *running* copy, resolved from this file rather than
  // assembled from a version number. Without it callers hard-coded versioned
  // cache paths, and one session spent 3.5 hours pinned to a stale 0.1.0 copy
  // it had found with `find | head -1`.
  appendEnvVar(COMPANION_BIN_ENV, path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-companion.mjs"));
}

// Persistent jobs deliberately outlive the Claude session that submitted them.
// Reading the store still reconciles workers that actually died; SessionEnd must
// never turn a healthy detached worker into a cancellation.
function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }

  listJobs(workspaceRoot);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
