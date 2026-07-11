import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_REVIEW_INPUT_CHARS = 180_000;
const MAX_UNTRACKED_FILES_INLINED = 10;
const MAX_UNTRACKED_FILE_BYTES = 20_000;

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

export function isGitRepository(cwd) {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 1024);
  return sample.includes(0);
}

function section(title, body) {
  const trimmed = String(body ?? "").trimEnd();
  if (!trimmed) {
    return "";
  }
  return `## ${title}\n\n${trimmed}\n`;
}

function collectUntracked(cwd) {
  const raw = tryGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const files = raw.split("\n").filter(Boolean);
  if (files.length === 0) {
    return { list: "", contents: "", count: 0 };
  }

  const parts = [];
  let inlined = 0;
  for (const file of files) {
    if (inlined >= MAX_UNTRACKED_FILES_INLINED) {
      break;
    }
    const absolute = path.join(cwd, file);
    let buffer;
    try {
      const stats = fs.statSync(absolute);
      if (!stats.isFile() || stats.size > MAX_UNTRACKED_FILE_BYTES) {
        continue;
      }
      buffer = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) {
      continue;
    }
    inlined += 1;
    parts.push(`### New file: ${file}\n\n\`\`\`\n${buffer.toString("utf8")}\n\`\`\``);
  }

  return {
    list: files.join("\n"),
    contents: parts.join("\n\n"),
    count: files.length
  };
}

// Builds the inline repository context fed to the review prompt. opencode also
// gets read access to the checkout, but the diff travels in the prompt so the
// review works even when tool use is restricted.
export function collectReviewInput(cwd, { base = null, scope = "auto" } = {}) {
  if (!isGitRepository(cwd)) {
    throw new Error("Not a git repository. Run the review from inside a git checkout.");
  }

  const useBranch = Boolean(base) || scope === "branch";
  if (scope === "branch" && !base) {
    throw new Error("--scope branch requires --base <ref>.");
  }

  let label;
  let body;
  if (useBranch) {
    if (!refExists(cwd, base)) {
      throw new Error(`Base ref not found: ${base}`);
    }
    label = `branch diff against ${base}`;
    const log = tryGit(cwd, ["log", "--oneline", `${base}..HEAD`]);
    const diff = tryGit(cwd, ["diff", `${base}...HEAD`]);
    if (!diff.trim() && !log.trim()) {
      return { label, input: "", isEmpty: true };
    }
    body = [section("Commits since base", log), section("Diff vs base", diff)].filter(Boolean).join("\n");
  } else {
    label = "uncommitted working tree changes";
    const status = tryGit(cwd, ["status", "--short", "--untracked-files=all"]);
    const staged = tryGit(cwd, ["diff", "--cached"]);
    const unstaged = tryGit(cwd, ["diff"]);
    const untracked = collectUntracked(cwd);
    if (!staged.trim() && !unstaged.trim() && untracked.count === 0) {
      return { label, input: "", isEmpty: true };
    }
    body = [
      section("git status", status),
      section("Staged diff", staged),
      section("Unstaged diff", unstaged),
      section("Untracked files", untracked.list),
      section("Untracked file contents", untracked.contents)
    ]
      .filter(Boolean)
      .join("\n");
  }

  let input = body;
  if (input.length > MAX_REVIEW_INPUT_CHARS) {
    input = `${input.slice(0, MAX_REVIEW_INPUT_CHARS)}\n\n[Review input truncated at ${MAX_REVIEW_INPUT_CHARS} characters. Use the repository checkout to inspect the rest.]`;
  }

  return { label, input, isEmpty: false };
}
