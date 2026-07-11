import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const STDERR_TAIL_CHARS = 4000;
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
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

  for (const event of events) {
    sessionId = event.sessionID ?? event.part?.sessionID ?? sessionId;
    const part = event.part;
    if (!part) {
      continue;
    }
    if (event.type === "step_finish" && typeof part.reason === "string") {
      stopReason = part.reason;
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

  return { text, sessionId, stopReason, eventCount: events.length };
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
export function runOpencode(options, { cwd, logFile = null, onSpawn = null } = {}) {
  const args = buildOpencodeArgs(options);
  const startedAt = Date.now();
  const logStream = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;

  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (onSpawn) {
      onSpawn(child);
    }

    let stdout = "";
    let lineBuffer = "";
    let stderrTail = "";
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
      logStream?.end();
      resolve({
        exitCode: null,
        spawnError: error.message,
        parsed: null,
        stdout: "",
        stderrTail,
        durationMs: Date.now() - startedAt
      });
    });

    child.on("close", (code) => {
      logStream?.end();
      const stream = parseEventStream(stdout);
      const parsed = stream
        ? {
            text: stream.text,
            sessionId: stream.sessionId,
            stopReason: stream.stopReason,
            structuredOutput: options.jsonSchema ? extractStructuredJson(stream.text) : null
          }
        : null;
      resolve({
        exitCode: code,
        spawnError: null,
        parsed,
        stdout,
        stderrTail: stripAnsi(stderrTail),
        durationMs: Date.now() - startedAt
      });
    });
  });
}
