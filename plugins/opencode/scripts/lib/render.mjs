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
    const elapsed =
      job.status === "running" || job.status === "queued"
        ? fmtDuration(Date.now() - Date.parse(job.createdAt ?? "") || 0)
        : fmtDuration(job.durationMs);
    lines.push(
      [job.id, job.kind, job.status, elapsed, firstLine(job.summary ?? job.promptPreview ?? "", 80)].join(" | ")
    );
  }
  lines.push("", "Use /opencode:result <id> for finished output, /opencode:cancel <id> to stop a running job.");
  return lines.join("\n");
}

export function renderJobDetail(job, payload, logTail) {
  const lines = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    `Duration: ${fmtDuration(job.durationMs)}`
  ];
  if (job.model) {
    lines.push(`Model: ${job.model}`);
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
  if (payload && (job.status === "completed" || job.status === "failed")) {
    lines.push("", "Stored output available. Run /opencode:result " + job.id + " to see it.");
  }
  return lines.join("\n");
}
