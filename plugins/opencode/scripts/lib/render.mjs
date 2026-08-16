const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function firstLine(text, maxLength = 120) {
  const line = String(text ?? "").split(/\r?\n/, 1)[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function footer(job) {
  const lines = ["", "---", `Job: ${job.id} (${job.kind}, ${job.status}, ${fmtDuration(job.durationMs)})`];
  if (job.opencodeSessionId) {
    lines.push(`opencode session: ${job.opencodeSessionId}`);
    lines.push(`Continue in opencode with: opencode -s ${job.opencodeSessionId}`);
  }
  return lines.join("\n");
}

export function renderTaskOutput(job, payload) {
  const text = String(payload.rawOutput ?? "").trim();
  const body = text || "[opencode returned no final output]";
  return `${body}\n${footer(job)}`;
}

const INCOMPLETE_REASON_DETAIL = {
  "empty-text": "opencode produced no final text at all.",
  "stop-reason": "The run stopped for a reason that is not a finished turn.",
  narration:
    "The last message reads like narration about work in progress, not the requested answer (tool calls happened, but the final text is very short)."
};

// The fourth renderer: a run that exited 0 without producing an answer. It must
// never look like a success, and it must never hide the partial output either.
export function renderIncompleteOutput(job, payload) {
  const text = String(payload.rawOutput ?? "").trim();
  const toolCalls = Number(payload.toolEventCount ?? 0);
  const lines = [
    `opencode stopped before producing a final answer (stopReason: ${payload.stopReason ?? "unknown"}, ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, ${text.length} chars of text).`
  ];
  const detail = INCOMPLETE_REASON_DETAIL[payload.outputStateReason];
  if (detail) {
    lines.push(detail);
  }
  lines.push("Partial output below — treat it as work-in-progress, not as the answer.");
  lines.push("", text || "[opencode produced no text]");

  const stderr = String(payload.stderrTail ?? "").trim();
  if (stderr) {
    lines.push("", "Most recent stderr:", "```", stderr.split(/\r?\n/).slice(-5).join("\n"), "```");
  }

  lines.push(
    "",
    "Recover with: /opencode:rescue --resume Return only the final answer itself. Do not read any more files and do not call any tools."
  );
  lines.push(footer(job));
  return lines.join("\n");
}

export function renderTaskFailure(job, payload) {
  const lines = [`opencode ${job.kind} run failed (exit code ${payload.exitCode ?? "unknown"}).`];
  if (payload.spawnError) {
    lines.push(`Spawn error: ${payload.spawnError}`);
  }
  const stderr = String(payload.stderrTail ?? "").trim();
  if (stderr) {
    lines.push("", "Most recent stderr:", "```", stderr.split(/\r?\n/).slice(-15).join("\n"), "```");
  }
  if (String(payload.rawOutput ?? "").trim()) {
    lines.push("", "Partial output:", String(payload.rawOutput).trim());
  }
  lines.push(footer(job));
  return lines.join("\n");
}

export function renderReviewOutput(job, payload) {
  const review = payload.structuredOutput;
  if (!review || typeof review !== "object") {
    const raw = String(payload.rawOutput ?? "").trim();
    return [
      "opencode returned review output that did not match the expected schema. Raw output below.",
      "",
      raw || "[empty output]",
      footer(job)
    ].join("\n");
  }

  const lines = [];
  const verdict = review.verdict === "approve" ? "APPROVE" : "NEEDS ATTENTION";
  lines.push(`Verdict: ${verdict}`);
  lines.push("");
  lines.push(String(review.summary ?? "").trim());

  const findings = Array.isArray(review.findings) ? [...review.findings] : [];
  findings.sort(
    (left, right) => (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
  );

  if (findings.length === 0) {
    lines.push("", "No material findings.");
  } else {
    lines.push("", `Findings (${findings.length}):`);
    findings.forEach((finding, index) => {
      const location = `${finding.file}:${finding.line_start}${
        finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""
      }`;
      const confidence = Number.isFinite(finding.confidence)
        ? ` (confidence ${Number(finding.confidence).toFixed(2)})`
        : "";
      lines.push("", `${index + 1}. [${finding.severity}] ${finding.title} — ${location}${confidence}`);
      if (finding.body) {
        lines.push(`   ${String(finding.body).trim().replace(/\n/g, "\n   ")}`);
      }
      if (finding.recommendation) {
        lines.push(`   Recommendation: ${String(finding.recommendation).trim().replace(/\n/g, "\n   ")}`);
      }
    });
  }

  const nextSteps = Array.isArray(review.next_steps) ? review.next_steps.filter(Boolean) : [];
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push(footer(job));
  return lines.join("\n");
}

export function renderJobList(jobs, { gateEnabled = false } = {}) {
  const lines = [`Review gate: ${gateEnabled ? "enabled" : "disabled"}`];
  if (jobs.length === 0) {
    lines.push("", "No opencode jobs recorded for this repository yet.");
    return lines.join("\n");
  }
  lines.push("", "id | kind | status | elapsed | summary");
  for (const job of jobs) {
    // Only a job whose process is still alive keeps counting up; an orphaned
    // record froze when its companion died and must say so.
    const elapsed =
      job.status === "running" || job.status === "queued"
        ? fmtDuration(Date.now() - Date.parse(job.createdAt ?? "") || 0)
        : fmtDuration(job.durationMs);
    const status = job.failureClass ? `${job.status} (${job.failureClass})` : job.status;
    lines.push(
      [job.id, job.kind, status, elapsed, firstLine(job.summary ?? job.promptPreview ?? "", 80)].join(" | ")
    );
  }
  lines.push("", "Use /opencode:result <id> for finished output, /opencode:cancel <id> to stop a running job.");
  return lines.join("\n");
}

export function renderJobDetail(job, payload, logTail) {
  const lines = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.failureClass ? `${job.status} (${job.failureClass})` : job.status}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    `Duration: ${fmtDuration(job.durationMs)}`
  ];
  if (job.model) {
    lines.push(`Model: ${job.model}`);
  }
  if (payload?.outputState || job.outputState) {
    lines.push(`Output state: ${payload?.outputState ?? job.outputState}`);
  }
  if (payload?.stopReason) {
    lines.push(`Stop reason: ${payload.stopReason}`);
  }
  if (job.opencodeSessionId) {
    lines.push(`opencode session: ${job.opencodeSessionId} (opencode -s ${job.opencodeSessionId})`);
  }
  if (job.promptPreview) {
    lines.push(`Prompt: ${job.promptPreview}`);
  }
  if (logTail) {
    lines.push("", "Recent activity:", "```", logTail, "```");
  }
  if (job.failureClass === "orphaned") {
    lines.push(
      "",
      `The companion process for this job died before it could store a result.${job.logFile ? ` Partial output may exist in ${job.logFile}.` : ""}`,
      "Re-run with /opencode:rescue --resume to continue that opencode session."
    );
  }
  if (payload && ["completed", "failed", "incomplete"].includes(job.status)) {
    lines.push("", "Stored output available. Run /opencode:result " + job.id + " to see it.");
  }
  return lines.join("\n");
}
