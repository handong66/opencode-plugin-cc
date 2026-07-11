import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenize, parseFlags } from "../plugins/opencode/scripts/lib/args.mjs";

test("tokenize splits on whitespace and honors quotes", () => {
  assert.deepEqual(tokenize('fix the "login page" bug'), ["fix", "the", "login page", "bug"]);
  assert.deepEqual(tokenize(["--model", "a/b"]), ["--model", "a/b"]);
  assert.deepEqual(tokenize(""), []);
});

test("parseFlags separates known flags from free text", () => {
  const { flags, rest, errors } = parseFlags(
    ["--model", "a/b", "--write", "fix", "the", "--weird", "bug"],
    { valueFlags: ["--model"], booleanFlags: ["--write"] }
  );
  assert.equal(flags.get("--model"), "a/b");
  assert.equal(flags.get("--write"), true);
  assert.deepEqual(rest, ["fix", "the", "--weird", "bug"]);
  assert.deepEqual(errors, []);
});

test("parseFlags reports value flags missing their value", () => {
  const { errors } = parseFlags(["--model"], { valueFlags: ["--model"], booleanFlags: [] });
  assert.equal(errors.length, 1);
});
