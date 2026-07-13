import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import type { Driver } from "./driver.ts";
import { formatElapsed } from "./types.ts";

const DOCK_WIDGET_ID = "autoloop-dock";

/**
 * Event topics that carry real progress signal (shown in the dock).
 * Source: AgentSpacesAgentInterfaceFrontend loops-dashboard-panel.
 * Structural events (iteration.start, backend.start, etc.) are hidden.
 */
const MEANINGFUL_TOPICS = new Set([
  "loop.start", "loop.stop", "loop.complete",
  "brief.ready", "tasks.ready", "research.ready", "design.ready", "spec.ready",
  "review.passed", "review.rejected", "review.ready", "review.start",
  "fix.ready", "fix.verified", "rootcause.ready", "hypothesis.ready", "cause.found",
  "task.complete", "operator.guidance",
  "spec.revise", "qa.planned", "qa.executed", "qa.continue", "surfaces.identified",
  "build.blocked",
  "wave.timeout", "wave.failed",
]);

/**
 * Read the latest meaningful event { topic, payload } from a journal file.
 * Returns { topic, payload } for the newest meaningful entry, or null.
 */
function readLatestMeaningful(journalFile: string): { topic: string; payload: string } | null {
  try {
    const content = readFileSync(journalFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as { topic?: string; payload?: string };
        if (entry.topic && MEANINGFUL_TOPICS.has(entry.topic)) {
          return {
            topic: entry.topic,
            payload: (entry.payload ?? "").replace(/\s+/g, " ").trim(),
          };
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file unreadable
  }
  return null;
}

function renderPanelRule(width: number, theme: Theme): string {
  return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function padLine(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const len = visibleWidth(content);
  const truncated = len > innerWidth ? truncateToWidth(content, innerWidth) : content;
  return ` ${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))} `;
}

export class LoopDockComponent implements Component {
  private driver: Driver;
  private theme: Theme;
  private tui: { requestRender(): void };
  private cwd: string;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: {
    driver: Driver;
    theme: Theme;
    tui: { requestRender(): void };
    cwd: string;
  }) {
    this.driver = opts.driver;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.cwd = opts.cwd;

    this.unsubscribe = this.driver.onEvent(() => {
      this.tui.requestRender();
    });
  }

  handleInput(_data: string): boolean {
    return false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme;
    const dim = (s: string) => theme.fg("dim", s);
    const accent = (s: string) => theme.fg("accent", s);

    const activeRuns = this.driver.getRuns();
    if (activeRuns.length === 0) return [];

    const lines: string[] = [renderPanelRule(width, theme)];

    for (const run of activeRuns) {
      const id = run.runId || "starting...";
      const elapsed = formatElapsed(Date.now() - run.startedAt);
      const iter = run.iteration;
      const maxIter = run.maxIterations || "?";
      const role = run.activeRole;

      // Latest meaningful journal event (topic + payload summary).
      const meaningful = run.journalFile ? readLatestMeaningful(run.journalFile) : null;
      const latestEvent = meaningful?.topic ?? "";

      // Single-line status: 🔁 runId (preset) iter=N/M elapsed · role → event
      const label = run.preset;
      const detailParts: string[] = [];
      if (role) detailParts.push(theme.fg("warning", role));
      if (latestEvent) detailParts.push(dim(latestEvent));
      const detail = detailParts.length > 0 ? dim(" · ") + detailParts.join(dim(" → ")) : "";
      const line =
        "🔁 " +
        accent(id) +
        dim(` (${label})`) +
        dim(` iter=${iter + 1}/${maxIter}`) +
        dim(` ${elapsed}`) +
        detail;
      lines.push(padLine(line, width));

      // Second line: latest meaningful event payload (summary), truncated.
      if (meaningful?.payload) {
        lines.push(padLine(dim(meaningful.payload), width));
      }
    }

    return lines;
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}

export function setupLoopDock(
  driver: Driver,
  setWidget: (
    key: string,
    content: unknown,
    options?: { placement: string },
  ) => void,
  getCwd: () => string,
): () => void {
  let dockComponent: LoopDockComponent | null = null;

  function updateDock() {
    const activeRuns = driver.getRuns();
    if (activeRuns.length === 0) {
      setWidget(DOCK_WIDGET_ID, undefined);
      if (dockComponent) {
        dockComponent.dispose();
        dockComponent = null;
      }
      return;
    }

    if (!dockComponent) {
      setWidget(
        DOCK_WIDGET_ID,
        (tui: { requestRender(): void }, theme: Theme) => {
          dockComponent = new LoopDockComponent({ driver, theme, tui, cwd: getCwd() });
          return dockComponent;
        },
        { placement: "aboveEditor" },
      );
    }
  }

  const unsub = driver.onEvent(() => updateDock());

  return () => {
    unsub();
    dockComponent?.dispose();
    dockComponent = null;
  };
}

export { DOCK_WIDGET_ID };
