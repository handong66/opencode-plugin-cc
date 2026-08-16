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
  structuredOutputInvalid = false,
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

  // The review-kind twin of the empty-answer case: the run talked, but what it
  // produced is not the deliverable the schema asked for. Falling back to the
  // raw output is right; calling it `completed` is not.
  if (structuredOutputInvalid) {
    return { ...base, state: "incomplete", reason: "schema-mismatch" };
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

// What to do next, per failure class. The classification never changes the
// pass/fail verdict — a misread stderr tail must only ever cost a wrong
// suggestion — so these are printed *above* the untouched stderr block.
export const FAILURE_CLASS_GUIDANCE = {
  model_unauthorized:
    "This account is not authorised for the requested model. Choose a model the provider actually grants, or drop --model and let opencode use its default. Retrying the same model will fail the same way.",
  model_not_found:
    "opencode does not recognise that model id — check the provider prefix and its casing (`aihubmix/…`, not `AIHubMix/…`). `opencode models` lists the ids it accepts, and its own `Did you mean:` hint is in the stderr below.",
  quota_exhausted:
    "The provider balance or quota is exhausted. Top it up or switch provider — this is not a plugin or prompt problem, and retrying will not help.",
  auth_required:
    "opencode has no usable credentials for this provider. Run `!opencode auth login`, then /opencode:setup to confirm before re-running.",
  provider_error:
    "The provider returned a server-side error, which is the one class here worth retrying once. If it repeats, switch provider rather than rewording the prompt.",
  opencode_failed:
    "opencode exited non-zero without a recognised reason. The stderr tail below is the only evidence; if it is empty, re-run with a narrower task or check `opencode run` by hand."
};

// Ordered because the tests are substring matches on a noisy tail: an HTTP code
// is the strongest signal, so 403/402/401 are read before the prose forms.
const FAILURE_CLASS_PATTERNS = [
  ["model_unauthorized", /\b403\b|not authorized to access the requested model|unauthorized to (?:use|access) (?:the )?model/i],
  ["quota_exhausted", /\b402\b|insufficient (?:credit|balance|funds|quota)|credit balance is too low|quota (?:exceeded|exhausted)|out of credits/i],
  ["auth_required", /\b401\b|no credentials|not authenticated|unauthenticated|authentication required|auth login/i],
  ["model_not_found", /model not found|did you mean|unknown model|no such model id/i],
  ["provider_error", /unexpected server error|internal server error|\b5\d\d\s+(?:error|status)/i]
];

// Classifies *why* a run failed, from the evidence a headless run leaves behind.
// Returns null for a run that did not fail: the caller keeps `failureClass` free
// for the companion's own labels (`timeout`, `interrupted`, `orphaned`).
export function classifyFailure({ exitCode = null, spawnError = null, stderrTail = "", rawOutput = "" } = {}) {
  if (!spawnError && exitCode === 0) {
    return null;
  }
  if (spawnError) {
    return "opencode_failed";
  }
  const haystack = `${String(stderrTail ?? "")}\n${String(rawOutput ?? "")}`;
  for (const [failureClass, pattern] of FAILURE_CLASS_PATTERNS) {
    if (pattern.test(haystack)) {
      return failureClass;
    }
  }
  return "opencode_failed";
}

// opencode announces an auto-rejected permission on stderr and still exits 0,
// e.g. `! permission requested: external_directory (/private/tmp/*);
// auto-rejecting`. Claude Code stages large prompts and material under
// /private/tmp/claude-501/<project>/<session>/scratchpad by default, so this is
// a structural collision between the two conventions, not an edge case.
const PERMISSION_REJECT_PATTERN = /permission requested:\s*([\w-]+)\s*\(([^)]*)\);\s*auto-rejecting/gi;

export function detectPermissionWarnings(stderrTail, { cwd = null } = {}) {
  const warnings = [];
  const seen = new Set();
  for (const match of String(stderrTail ?? "").matchAll(PERMISSION_REJECT_PATTERN)) {
    const permission = match[1];
    const target = match[2].trim();
    const key = `${permission}:${target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    warnings.push({
      class: permission === "external_directory" ? "external_path_blocked" : "permission_blocked",
      permission,
      path: target,
      message:
        permission === "external_directory"
          ? `external_path_blocked: opencode refused to read ${target} because it is outside ${cwd ?? "the working directory"}. Copy the file into the repo, or inline its contents in the prompt.`
          : `permission_blocked: opencode auto-rejected the ${permission} permission for ${target}. Anything that needed it was skipped.`
    });
  }
  return warnings;
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
  // Headless delegates obey repository bootstrap files that tell every agent to
  // load an interactive skill/persona first. That is invisible in the answer and
  // shows up only as turns and wall time, so it is counted here.
  const skillsLoaded = new Set();
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
      const skill = describeSkillUse(part);
      if (skill) {
        skillsLoaded.add(skill);
      }
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

  return {
    text,
    sessionId,
    stopReason,
    eventCount: events.length,
    toolEventCount: toolPartIds.size,
    skillsLoaded: [...skillsLoaded]
  };
}

// Two observed shapes: an explicit skill tool call, and a plain read of a
// SKILL.md — the corpus is full of runs whose *first* action was one or the
// other (89 of 231 opencode job logs, 57 of 128 grok ones).
function describeSkillUse(part) {
  const tool = String(part?.tool ?? part?.name ?? "");
  const input = part?.state?.input ?? part?.input ?? {};
  if (/^skills?$/i.test(tool)) {
    return String(input.name ?? input.skill ?? input.skill_name ?? "skill");
  }
  const target = String(input.filePath ?? input.file_path ?? input.path ?? "");
  if (/(^|\/)SKILL\.md$/i.test(target)) {
    return target;
  }
  return null;
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

// Enough of JSON Schema to hold `schemas/review-output.schema.json` to its
// word, with no dependency: type, required, enum, minLength, minimum/maximum,
// properties and items. `additionalProperties` is deliberately not enforced —
// an extra key is not a reason to throw away an otherwise well-formed review,
// and the renderer only reads the keys it knows.
export function validateAgainstSchema(value, schema, pointer = "") {
  const errors = [];
  const at = pointer || "(root)";
  if (!schema || typeof schema !== "object") {
    return errors;
  }

  const type = schema.type;
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [`${at}: expected an object`];
    }
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === null || value[key] === undefined) {
        errors.push(`${at}: missing required key "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== null && value[key] !== undefined) {
        errors.push(...validateAgainstSchema(value[key], subSchema, pointer ? `${pointer}.${key}` : key));
      }
    }
    return errors;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      return [`${at}: expected an array`];
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(item, schema.items, `${pointer}[${index}]`));
      });
    }
    return errors;
  }

  if (type === "string") {
    if (typeof value !== "string") {
      return [`${at}: expected a string`];
    }
    if (Number.isFinite(schema.minLength) && value.trim().length < schema.minLength) {
      errors.push(`${at}: must not be empty`);
    }
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number" || Number.isNaN(value) || (type === "integer" && !Number.isInteger(value))) {
      return [`${at}: expected ${type === "integer" ? "an integer" : "a number"}`];
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${at}: must be >= ${schema.minimum}`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${at}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }
  return errors;
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
      // A parsed object is not a review. `extractStructuredJson` will happily
      // return `{"note":"I could not finish"}` (or a JSON fragment lifted out
      // of narration), and the renderer used to turn that into a verdict with
      // an empty summary and no findings. Validate before believing it.
      let structuredOutput = null;
      let structuredOutputErrors = [];
      if (stream && options.jsonSchema) {
        const candidate = extractStructuredJson(stream.text);
        if (candidate) {
          structuredOutputErrors = validateAgainstSchema(candidate, options.jsonSchema);
          structuredOutput = structuredOutputErrors.length === 0 ? candidate : null;
        } else {
          structuredOutputErrors = ["(root): the final answer contained no JSON object"];
        }
      }
      const parsed = stream
        ? {
            text: stream.text,
            sessionId: stream.sessionId,
            stopReason: stream.stopReason,
            toolEventCount: stream.toolEventCount,
            skillsLoaded: stream.skillsLoaded ?? [],
            structuredOutput,
            structuredOutputErrors,
            expectedStructuredOutput: Boolean(options.jsonSchema)
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
