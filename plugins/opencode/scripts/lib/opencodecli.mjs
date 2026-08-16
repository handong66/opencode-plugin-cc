import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import { terminateProcessTree } from "./process.mjs";

const STDERR_TAIL_CHARS = 4000;
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

// Stop reasons that mean "the model finished its turn on purpose".
export const CLEAN_STOP_REASONS = new Set(["stop", "end_turn", "end-turn", "endturn", "complete"]);
// Known reasons for a run ending before a final answer existed. Deliberately a
// blacklist: opencode may add vocabulary, and an unknown value must never flip
// a real answer into `incomplete` (it only raises a warning).
export const INCOMPLETE_STOP_REASONS = new Set([
  "tool-calls",
  "tool_calls",
  "toolcalls",
  "length",
  "max-tokens",
  "max_tokens",
  "max-turns",
  "max_turns",
  "aborted",
  "abort",
  "cancelled",
  "canceled",
  "error",
  "content-filter",
  "content_filter",
  "permission-denied",
  "permission_denied"
]);
// Below this many characters a final answer looks like narration rather than an
// answer — but only when the run did work (tool calls) for a prompt big enough
// that a one-liner cannot plausibly be the deliverable.
export const DEFAULT_MIN_ANSWER_CHARS = 200;
export const NARRATION_PROMPT_CHARS = 1000;
export const MIN_ANSWER_CHARS_ENV = "OPENCODE_COMPANION_MIN_ANSWER_CHARS";

function resolveMinAnswerChars(minAnswerChars, env) {
  if (minAnswerChars !== null && minAnswerChars !== undefined && minAnswerChars !== "") {
    const explicit = Number(minAnswerChars);
    if (Number.isFinite(explicit) && explicit >= 0) {
      return explicit;
    }
  }
  const fromEnv = Number(env?.[MIN_ANSWER_CHARS_ENV]);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_MIN_ANSWER_CHARS;
}

// Three-state verdict for one opencode run. `exitCode === 0` on its own proves
// nothing: opencode exits 0 after auto-rejecting a permission request, after
// running out of tool budget, and after emitting a single line of narration.
export function classifyOutcome({
  exitCode,
  spawnError = null,
  parsed,
  toolEventCount = 0,
  promptChars = 0,
  hasStructuredOutput = false,
  minAnswerChars = null,
  env = process.env
} = {}) {
  const stopReason = parsed?.stopReason ?? null;
  const text = String(parsed?.text ?? "").trim();
  const base = {
    stopReason,
    textChars: text.length,
    toolEventCount: Number(toolEventCount) || 0,
    warnings: []
  };

  if (spawnError || exitCode !== 0 || !parsed) {
    return {
      ...base,
      state: "failed",
      reason: spawnError ? "spawn-error" : !parsed ? "no-events" : "exit-code"
    };
  }

  if (text.length === 0) {
    return { ...base, state: "incomplete", reason: "empty-text" };
  }

  if (stopReason) {
    const normalized = String(stopReason).trim().toLowerCase();
    if (INCOMPLETE_STOP_REASONS.has(normalized)) {
      return { ...base, state: "incomplete", reason: "stop-reason" };
    }
    if (!CLEAN_STOP_REASONS.has(normalized)) {
      base.warnings.push(
        `opencode reported an unrecognised stopReason "${stopReason}"; treating the run as complete. Report it if the answer looks truncated.`
      );
    }
  }

  const threshold = resolveMinAnswerChars(minAnswerChars, env);
  if (
    !hasStructuredOutput &&
    base.toolEventCount > 0 &&
    promptChars >= NARRATION_PROMPT_CHARS &&
    text.length < threshold
  ) {
    return { ...base, state: "incomplete", reason: "narration" };
  }

  return { ...base, state: "completed", reason: null };
}

export function getOpencodeAvailability() {
  const version = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    return {
      available: false,
      authenticated: false,
      usable: false,
      detail: "The `opencode` binary was not found on PATH"
    };
  }

  const auth = spawnSync("opencode", ["auth", "list"], { encoding: "utf8", timeout: 30_000 });
  const authOutput = stripAnsi(`${auth.stdout ?? ""}${auth.stderr ?? ""}`);
  const credentialCount = Number(authOutput.match(/(\d+)\s+credentials?/)?.[1] ?? 0);
  const authenticated = auth.status === 0 && credentialCount > 0;

  // Zero stored credentials can still be workable: opencode zen exposes free
  // models. Only in that case is the extra `models` probe worth its latency.
  let usable = authenticated;
  if (!authenticated) {
    const models = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: 30_000 });
    usable = models.status === 0 && stripAnsi(String(models.stdout ?? "")).trim().length > 0;
  }

  return {
    available: true,
    version: stripAnsi(String(version.stdout ?? "")).trim(),
    authenticated,
    credentialCount,
    usable,
    detail: authenticated
      ? null
      : usable
        ? "opencode has no stored provider credentials; only free models will work until you run `opencode auth login`"
        : "opencode is installed but has no usable providers. Run `opencode auth login`."
  };
}

// Folds companion-level concerns that the opencode CLI has no flags for into
// the prompt itself: system-style rules and the JSON schema the final answer
// must match.
export function composePrompt({ prompt, rules = null, jsonSchema = null }) {
  const blocks = [];
  if (rules) {
    blocks.push(`<system_rules>\n${rules}\n</system_rules>`);
  }
  blocks.push(prompt);
  if (jsonSchema) {
    blocks.push(
      [
        "<output_schema>",
        "Your final answer must be a single JSON object that validates against this JSON Schema. Output only the JSON object, with no surrounding prose or markdown fences.",
        JSON.stringify(jsonSchema, null, 2),
        "</output_schema>"
      ].join("\n")
    );
  }
  return blocks.join("\n\n");
}

export function buildOpencodeArgs({
  prompt,
  model = null,
  variant = null,
  resumeSessionId = null,
  readOnly = false,
  autoApprove = false,
  title = null,
  rules = null,
  jsonSchema = null
}) {
  const args = ["run", "--format", "json"];
  if (title) {
    args.push("--title", title);
  }
  if (resumeSessionId) {
    args.push("--session", resumeSessionId);
  }
  if (model) {
    args.push("--model", model);
  }
  if (variant) {
    args.push("--variant", variant);
  }
  if (readOnly) {
    // The built-in plan agent cannot edit files, which is the strongest
    // read-only guarantee `opencode run` offers from the CLI surface.
    args.push("--agent", "plan");
  }
  if (autoApprove && !readOnly) {
    args.push("--auto");
  }
  args.push("--", composePrompt({ prompt, rules, jsonSchema }));
  return args;
}

// `opencode run --format json` emits one JSON event per line, e.g.
//   {"type":"text","sessionID":"ses_...","part":{"id":"prt_...","messageID":"msg_...","type":"text","text":"..."}}
// Text parts can be re-emitted as they stream, so the last payload per part id
// wins. The final answer is the text of the newest message that produced any.
export function parseEventStream(stdout) {
  const events = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  if (events.length === 0) {
    return null;
  }

  let sessionId = null;
  let stopReason = null;
  const textPartsByMessage = new Map();
  const messageOrder = [];
  // Tool parts stream one event per state change (pending/running/completed),
  // so count distinct part ids — the interesting number is "did this run do
  // work", not how chatty the stream was.
  const toolPartIds = new Set();

  for (const event of events) {
    sessionId = event.sessionID ?? event.part?.sessionID ?? sessionId;
    const part = event.part;
    if (!part) {
      continue;
    }
    if (event.type === "step_finish" && typeof part.reason === "string") {
      stopReason = part.reason;
    }
    if (event.type === "tool") {
      toolPartIds.add(part.id ?? `tool-${toolPartIds.size}`);
    }
    if (event.type === "text" && typeof part.text === "string") {
      const messageId = part.messageID ?? "message";
      if (!textPartsByMessage.has(messageId)) {
        textPartsByMessage.set(messageId, new Map());
        messageOrder.push(messageId);
      }
      const parts = textPartsByMessage.get(messageId);
      parts.set(part.id ?? `index-${parts.size}`, part.text);
    }
  }

  const lastMessageId = messageOrder.at(-1);
  const text = lastMessageId
    ? [...textPartsByMessage.get(lastMessageId).values()].join("\n\n").trim()
    : "";

  return { text, sessionId, stopReason, eventCount: events.length, toolEventCount: toolPartIds.size };
}

// The review contract asks for bare JSON, but models routinely wrap it in
// fences or prose. Try the strict reading first, then progressively looser ones.
export function extractStructuredJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }

  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    candidates.push(match[1]);
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function describeEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const part = event.part ?? {};
  switch (event.type) {
    case "step_start":
      return "[step] start";
    case "step_finish":
      return `[step] finish (${part.reason ?? "?"})`;
    case "tool":
      return `[tool] ${part.tool ?? part.name ?? "unknown"}${part.state?.status ? ` (${part.state.status})` : ""}`;
    case "text": {
      const preview = String(part.text ?? "").split(/\r?\n/, 1)[0].slice(0, 100);
      return preview ? `[text] ${preview}` : null;
    }
    default:
      return null;
  }
}

// Runs one headless opencode turn. The child is detached into its own process
// group so `cancel` and session teardown can terminate the whole tree.
// `opencode run` has no timeout flag of its own (confirmed against
// `opencode run --help`), so `timeoutMs` is the only deadline a stuck run has.
export function runOpencode(
  options,
  { cwd, logFile = null, onSpawn = null, onExit = null, timeoutMs = null } = {}
) {
  const args = buildOpencodeArgs(options);
  const startedAt = Date.now();
  const logStream = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;

  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let lineBuffer = "";
    let stderrTail = "";

    if (onSpawn) {
      // The buffered stream is handed over as accessors, not a copy: a
      // companion killed mid-run has to be able to store whatever opencode had
      // produced by then, from inside a synchronous signal handler.
      onSpawn(child, { getStdout: () => stdout, getStderrTail: () => stripAnsi(stderrTail) });
    }

    let timedOut = false;
    const deadline =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            // Signals the whole group: the child is detached, so its own
            // children would otherwise survive the kill.
            terminateProcessTree(child.pid ?? Number.NaN);
          }, timeoutMs)
        : null;
    const clearDeadline = () => {
      if (deadline) {
        clearTimeout(deadline);
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const note = describeEventLine(lineBuffer.slice(0, newlineIndex));
        if (note) {
          logStream?.write(`${note}\n`);
        }
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      logStream?.write(text);
    });

    child.on("error", (error) => {
      clearDeadline();
      logStream?.end();
      resolve({
        exitCode: null,
        spawnError: error.message,
        parsed: null,
        stdout: "",
        stderrTail,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });

    child.on("close", (code) => {
      clearDeadline();
      logStream?.end();
      // Announced before parsing: from here on the pid is dead but the job
      // record is still `running`, and parsing a large stream is not instant.
      // A throwing hook must not strand the promise.
      try {
        onExit?.(code);
      } catch {
        // Bookkeeping only; the run's verdict does not depend on it.
      }
      const stream = parseEventStream(stdout);
      const parsed = stream
        ? {
            text: stream.text,
            sessionId: stream.sessionId,
            stopReason: stream.stopReason,
            toolEventCount: stream.toolEventCount,
            structuredOutput: options.jsonSchema ? extractStructuredJson(stream.text) : null
          }
        : null;
      resolve({
        // A kill leaves `code === null` (signal), which classifies as failed. A
        // child that still managed to exit 0 inside the kill window produced a
        // real answer, and throwing it away would be worse than reporting it.
        exitCode: code,
        spawnError: null,
        parsed,
        stdout,
        stderrTail: stripAnsi(stderrTail),
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}
