import { createRequire } from "node:module";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type {
  AgentToolResult,
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  MESSAGE_TYPE_AUTOLOOP_UPDATE,
  type AutoloopDetails,
  type AutoloopRunState,
  type AutoloopUpdateDetails,
  type RunRecord,
  formatElapsed,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Optional dependency: @aliou/pi-utils-ui
//
// Provides ToolCallHeader, ToolBody, ToolFooter for rich tool rendering.
// Available at runtime when @aliou/pi-processes is installed (shared Node.js
// process). We resolve it dynamically because jiti scopes module resolution
// per-extension directory. Falls back to plain Text rendering when absent.
// ---------------------------------------------------------------------------
let ToolCallHeader: any = null;
let ToolBody: any = null;
let ToolFooter: any = null;

function tryLoadPiUtilsUi(): void {
  const home = process.env.HOME ?? "";
  const searchPaths = [
    join(home, ".npm-global/lib/node_modules/@aliou/pi-processes"),
    join(home, ".local/lib/node_modules/@aliou/pi-processes"),
    join(home, "node_modules/@aliou/pi-processes"),
  ];
  for (const base of searchPaths) {
    const pkg = join(base, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      const req = createRequire(pkg);
      const utils = req("@aliou/pi-utils-ui");
      ToolCallHeader = utils.ToolCallHeader;
      ToolBody = utils.ToolBody;
      ToolFooter = utils.ToolFooter;
      return;
    } catch {
      continue;
    }
  }
}
tryLoadPiUtilsUi();

export function renderCall(
  args: { action?: string; preset?: string; runId?: string; artifact?: string; prompt?: string; backend?: string; worktree?: boolean; verbose?: boolean },
  theme: Theme,
): Component {
  const optionArgs: Array<{ label: string; value: string }> = [];
  let mainArg: string | undefined;

  // Pick the most relevant arg as mainArg
  if (args.preset) mainArg = args.preset;
  else if (args.runId) mainArg = args.runId;

  // Secondary args as optionArgs
  if (args.preset && args.runId) {
    optionArgs.push({ label: "run", value: args.runId });
  }
  if (args.artifact) {
    optionArgs.push({ label: "artifact", value: args.artifact });
  }
  if (args.backend) {
    optionArgs.push({ label: "backend", value: args.backend });
  }
  if (args.worktree) {
    optionArgs.push({ label: "worktree", value: "true" });
  }

  const longArgs: Array<{ label?: string; value: string }> = [];
  if (args.prompt && args.prompt.length > 60) {
    longArgs.push({ label: "prompt", value: args.prompt });
  } else if (args.prompt) {
    optionArgs.push({ label: "prompt", value: args.prompt });
  }

  if (ToolCallHeader) {
    return new ToolCallHeader(
      {
        toolName: "Autoloop",
        action: args.action,
        mainArg,
        optionArgs,
        longArgs,
      },
      theme,
    );
  }

  // Fallback: plain text
  let text = theme.fg("accent", theme.bold("autoloop "));
  text += theme.fg("accent", args.action ?? "?");
  if (mainArg) text += ` ${theme.fg("muted", mainArg)}`;
  return new Text(text, 0, 0);
}

export function renderResult(
  result: AgentToolResult<AutoloopDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  if (options.isPartial) {
    return new Text(theme.fg("muted", "Autoloop: running..."), 0, 0);
  }

  const d = result.details;

  // Framework sets details to {} when tool throws
  if (!d?.action) {
    const textBlock = result.content.find((c) => c.type === "text");
    const errorMsg = (textBlock?.type === "text" && textBlock.text) || "Tool execution failed";
    return new Text(theme.fg("error", errorMsg), 0, 0);
  }

  if (!d.success) {
    if (ToolBody) {
      return new ToolBody(
        {
          fields: [
            { label: "Error", value: theme.fg("error", d.message), showCollapsed: true },
          ],
        },
        options,
        theme,
      );
    }
    return new Text(theme.fg("error", `✗ ${d.action}: ${d.message}`), 0, 0);
  }

  switch (d.action) {
    case "run":
      return renderRunResult(d, options, theme);
    case "list":
      return renderListResult(d, options, theme);
    case "status":
      return renderStatusResult(d, options, theme);
    default:
      if (ToolBody) {
        return new ToolBody(
          {
            fields: [
              { label: "Result", value: d.message, showCollapsed: true },
            ],
          },
          options,
          theme,
        );
      }
      return new Text(d.message, 0, 0);
  }
}

function renderRunResult(d: AutoloopDetails, options: ToolRenderResultOptions, theme: Theme): Component {
  if (!ToolBody) {
    const icon = d.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
    return new Text(`${icon} run ${d.runId ?? ""} — ${d.message}`, 0, 0);
  }

  const fields: Array<{ label: string; value: string; showCollapsed?: boolean } | Text> = [
    {
      label: "Status",
      value: theme.fg("success", "Started") + (d.runId ? ` ${theme.fg("accent", d.runId)}` : ""),
      showCollapsed: true,
    },
  ];

  if (d.message) {
    fields.push(new Text(theme.fg("muted", d.message), 0, 0) as Text & { showCollapsed?: boolean });
  }

  return new ToolBody({ fields }, options, theme);
}

function renderListResult(d: AutoloopDetails, options: ToolRenderResultOptions, theme: Theme): Component {
  const runs = d.runs ?? [];

  if (runs.length === 0) {
    if (ToolBody) {
      return new ToolBody(
        { fields: [{ label: "Runs", value: "No runs found", showCollapsed: true }] },
        options,
        theme,
      );
    }
    return new Text(theme.fg("dim", "No runs found"), 0, 0);
  }

  const runningCount = runs.filter((r) => r.status === "running").length;
  const summary = `${runs.length} run(s), ${runningCount} running`;

  const lines: string[] = [theme.fg("success", summary)];
  for (const r of runs) {
    let color: Parameters<Theme["fg"]>[0];
    switch (r.status) {
      case "running": color = "accent"; break;
      case "completed": color = "success"; break;
      case "failed": case "timed_out": case "stopped": color = "error"; break;
      default: color = "dim";
    }
    lines.push(
      `  ${theme.fg(color, r.run_id)} ${theme.fg("dim", `[${r.status}]`)} ${r.preset} iter=${r.iteration}/${r.max_iterations}`,
    );
  }

  if (!ToolBody) {
    return new Text(lines.join("\n"), 0, 0);
  }

  const fields: Array<{ label: string; value: string; showCollapsed?: boolean } | (Text & { showCollapsed?: boolean })> = [
    new Text(lines.join("\n"), 0, 0) as Text & { showCollapsed?: boolean },
    { label: "Runs", value: summary, showCollapsed: true },
  ];

  const footerItems: Array<{ label: string; value: string }> = [];
  if (runningCount > 0) footerItems.push({ label: "running", value: String(runningCount) });
  const failedCount = runs.filter((r) => r.status === "failed" || r.status === "timed_out").length;
  if (failedCount > 0) footerItems.push({ label: "failed", value: String(failedCount) });

  return new ToolBody(
    {
      fields,
      footer: footerItems.length > 0 && ToolFooter ? new ToolFooter(theme, { items: footerItems, separator: " | " }) : undefined,
    },
    options,
    theme,
  );
}

function renderStatusResult(d: AutoloopDetails, options: ToolRenderResultOptions, theme: Theme): Component {
  const r = d.record;
  if (!r) {
    if (ToolBody) {
      return new ToolBody(
        { fields: [{ label: "Status", value: d.message, showCollapsed: true }] },
        options,
        theme,
      );
    }
    return new Text(d.message, 0, 0);
  }

  let statusColor: Parameters<Theme["fg"]>[0];
  switch (r.status) {
    case "running": statusColor = "accent"; break;
    case "completed": statusColor = "success"; break;
    case "failed": case "timed_out": case "stopped": statusColor = "error"; break;
    default: statusColor = "dim";
  }

  const statusLine = `${theme.fg(statusColor, r.run_id)} ${theme.fg(statusColor, `[${r.status}]`)} iter=${r.iteration}/${r.max_iterations}`;

  const progress = d.progress;
  const last = progress?.at(-1);

  const detailLines = [
    `  Preset: ${r.preset}`,
    `  Event: ${r.latest_event}`,
    last ? `  Role: ${last.role} | Outcome: ${last.outcome}` : "",
  ].filter(Boolean);

  if (!ToolBody) {
    return new Text([statusLine, ...detailLines].join("\n"), 0, 0);
  }

  const fields: Array<{ label: string; value: string; showCollapsed?: boolean } | (Text & { showCollapsed?: boolean })> = [
    new Text([statusLine, ...detailLines].join("\n"), 0, 0) as Text & { showCollapsed?: boolean },
    { label: "Status", value: statusLine, showCollapsed: true },
  ];

  return new ToolBody({ fields }, options, theme);
}

function truncName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
}

interface WidgetEntry {
  name: string;
  status: string;
  iter?: number;
  maxIter?: number;
  elapsed: string;
}

function formatEntry(entry: WidgetEntry, theme: Theme): string {
  const name = truncName(entry.name);
  let color: Parameters<Theme["fg"]>[0];
  switch (entry.status) {
    case "running":
      color = "accent";
      break;
    case "completed":
      color = "success";
      break;
    case "failed":
    case "timed_out":
    case "stopped":
      color = "error";
      break;
    default:
      color = "dim";
  }
  const progress =
    entry.iter != null && entry.maxIter != null
      ? ` ${entry.iter}/${entry.maxIter}`
      : "";
  return `${theme.fg(color, name)} ${theme.fg("dim", entry.status + progress + " " + entry.elapsed)}`;
}

export function renderStatusWidget(
  activeRuns: AutoloopRunState[],
  recentRecords: RunRecord[],
  theme: Theme,
  maxWidth?: number,
): string[] {
  if (activeRuns.length === 0) return [];

  // Build entries from active runs only
  const entries: WidgetEntry[] = [];

  for (const run of activeRuns) {
    const id = run.runId || "pending";
    entries.push({
      name: id,
      status: "running",
      elapsed: formatElapsed(Date.now() - run.startedAt),
    });
  }

  if (entries.length === 0) return [];

  const prefix = theme.fg("dim", "loops: ");
  const prefixLen = visibleWidth(prefix);
  const separator = theme.fg("dim", " | ");
  const separatorLen = visibleWidth(separator);
  const effectiveMax = maxWidth ?? 200;

  const parts: string[] = [];
  let currentLen = prefixLen;
  let includedCount = 0;

  for (const entry of entries) {
    const formatted = formatEntry(entry, theme);
    const formattedLen = visibleWidth(formatted);
    const remaining = entries.length - includedCount - 1;
    const needed =
      includedCount > 0 ? separatorLen + formattedLen : formattedLen;

    let reservedForSuffix = 0;
    if (remaining > 0) {
      const suffixText = `+${remaining} more`;
      reservedForSuffix = separatorLen + visibleWidth(suffixText);
    }

    if (
      currentLen + needed + reservedForSuffix > effectiveMax &&
      includedCount > 0
    ) {
      const hiddenCount = entries.length - includedCount;
      if (hiddenCount > 0) parts.push(theme.fg("dim", `+${hiddenCount} more`));
      break;
    }

    parts.push(formatted);
    currentLen += needed;
    includedCount++;
  }

  if (includedCount === 0 && entries.length > 0) {
    parts.push(formatEntry(entries[0], theme));
  }

  if (parts.length === 0) return [];

  const line = prefix + parts.join(separator);
  return [
    visibleWidth(line) > effectiveMax
      ? truncateToWidth(line, effectiveMax)
      : line,
  ];
}

interface AutoloopUpdateMessage {
  customType: string;
  content: string | Array<{ type: string; text?: string }>;
  details?: AutoloopUpdateDetails;
}

function getContentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("");
}

export function setupMessageRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<AutoloopUpdateDetails>(
    MESSAGE_TYPE_AUTOLOOP_UPDATE,
    (
      message: AutoloopUpdateMessage,
      _options: MessageRenderOptions,
      theme: Theme,
    ) => {
      const details = message.details;

      if (!details) {
        return new Text(getContentText(message.content), 0, 0);
      }

      let icon: string;
      let color: "success" | "error" | "warning";

      switch (details.status) {
        case "completed":
          icon = "\u2713";
          color = "success";
          break;
        case "failed":
        case "timed_out":
          icon = "\u2717";
          color = "error";
          break;
        case "stopped":
          icon = "\u2717";
          color = "warning";
          break;
        default:
          icon = "\u2713";
          color = "success";
      }

      const text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `"${details.preset}"`) +
        theme.fg("muted", ` (${details.runId})`) +
        " " +
        theme.fg(color, details.status) +
        theme.fg("muted", ` ${details.iteration}/${details.maxIterations} ${details.elapsed}`);

      return new Text(text, 0, 0);
    },
  );
}
