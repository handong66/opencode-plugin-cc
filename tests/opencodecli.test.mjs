import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpencodeArgs,
  composePrompt,
  extractStructuredJson,
  parseEventStream,
  stripAnsi
} from "../plugins/opencode/scripts/lib/opencodecli.mjs";

test("stripAnsi removes escape sequences but keeps bracketed text", () => {
  const esc = String.fromCharCode(27);
  assert.equal(stripAnsi(`${esc}[0mhello ${esc}[32m[tool] read${esc}[0m`), "hello [tool] read");
});

test("buildOpencodeArgs maps read-only runs to the plan agent", () => {
  const args = buildOpencodeArgs({ prompt: "task text", readOnly: true, autoApprove: true });
  assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
  assert.ok(args.includes("--agent"));
  assert.equal(args[args.indexOf("--agent") + 1], "plan");
  assert.ok(!args.includes("--auto"), "read-only must never auto-approve");
  assert.equal(args.at(-1), "task text");
  assert.equal(args.at(-2), "--", "prompt must be positional after --");
});

test("buildOpencodeArgs maps write runs to --auto with model/variant/session", () => {
  const args = buildOpencodeArgs({
    prompt: "-starts with dash",
    model: "anthropic/claude-sonnet-4-5",
    variant: "high",
    resumeSessionId: "ses_abc",
    autoApprove: true
  });
  assert.ok(args.includes("--auto"));
  assert.ok(!args.includes("--agent"));
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5");
  assert.equal(args[args.indexOf("--variant") + 1], "high");
  assert.equal(args[args.indexOf("--session") + 1], "ses_abc");
  assert.equal(args.at(-1), "-starts with dash");
});

test("composePrompt folds rules and schema into the prompt", () => {
  const prompt = composePrompt({ prompt: "review this", rules: "no side effects", jsonSchema: { type: "object" } });
  assert.match(prompt, /<system_rules>\nno side effects\n<\/system_rules>/);
  assert.match(prompt, /<output_schema>/);
  assert.match(prompt, /"type": "object"/);
  assert.ok(prompt.indexOf("no side effects") < prompt.indexOf("review this"));
});

test("parseEventStream extracts session, stop reason, and final text (real capture)", () => {
  // Events captured verbatim from `opencode run --format json` v1.17.15.
  const stdout = [
    '{"type":"step_start","timestamp":1783782739399,"sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","part":{"id":"prt_f51bc8dc1001F7quBZjUh5NX1q","messageID":"msg_f51bc8394001T1sMV4MyES1bck","sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","type":"step-start"}}',
    '{"type":"text","timestamp":1783782740298,"sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","part":{"id":"prt_f51bc9125001NwZTcZQOnFqnPO","messageID":"msg_f51bc8394001T1sMV4MyES1bck","sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","type":"text","text":"OK","time":{"start":1783782740261,"end":1783782740280}}}',
    '{"type":"step_finish","timestamp":1783782740298,"sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","part":{"id":"prt_f51bc913d001waIh3fCLg7Sgpr","reason":"stop","messageID":"msg_f51bc8394001T1sMV4MyES1bck","sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","type":"step-finish","tokens":{"total":8100,"input":8087,"output":2,"reasoning":11,"cache":{"write":0,"read":0}},"cost":0}}'
  ].join("\n");
  const parsed = parseEventStream(stdout);
  assert.equal(parsed.text, "OK");
  assert.equal(parsed.sessionId, "ses_0ae437d23ffeJtaD6ceMAAJlCK");
  assert.equal(parsed.stopReason, "stop");
});

test("parseEventStream keeps the last payload per part and the newest message", () => {
  const line = (messageID, partId, text) =>
    JSON.stringify({ type: "text", sessionID: "ses_x", part: { id: partId, messageID, sessionID: "ses_x", type: "text", text } });
  const stdout = [
    line("msg_1", "prt_a", "old answer"),
    line("msg_2", "prt_b", "new"),
    line("msg_2", "prt_b", "new answer, streamed"),
    "not json",
    ""
  ].join("\n");
  const parsed = parseEventStream(stdout);
  assert.equal(parsed.text, "new answer, streamed");
});

test("parseEventStream returns null when no events are present", () => {
  assert.equal(parseEventStream(""), null);
  assert.equal(parseEventStream("plain text output"), null);
});

test("extractStructuredJson handles bare, fenced, and prose-wrapped JSON", () => {
  assert.deepEqual(extractStructuredJson('{"verdict":"approve"}'), { verdict: "approve" });
  assert.deepEqual(extractStructuredJson('Here you go:\n```json\n{"verdict":"approve"}\n```'), {
    verdict: "approve"
  });
  assert.deepEqual(extractStructuredJson('prefix {"verdict":"approve"} suffix'), { verdict: "approve" });
  assert.equal(extractStructuredJson("no json here"), null);
  assert.equal(extractStructuredJson('["array","not","object"]'), null);
});
