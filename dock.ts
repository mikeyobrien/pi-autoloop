import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AutoloopManager } from "./manager.ts";
import { readRegistry, findRun } from "./registry.ts";
import { formatElapsed } from "./types.ts";

const DOCK_WIDGET_ID = "autoloop-dock";

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
  private manager: AutoloopManager;
  private theme: Theme;
  private tui: { requestRender(): void };
  private cwd: string;
  private unsubscribe: (() => void) | null = null;

  constructor(opts: {
    manager: AutoloopManager;
    theme: Theme;
    tui: { requestRender(): void };
    cwd: string;
  }) {
    this.manager = opts.manager;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.cwd = opts.cwd;

    this.unsubscribe = this.manager.onEvent(() => {
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

    const activeRuns = this.manager.getRuns();
    if (activeRuns.length === 0) return [];

    const lines: string[] = [renderPanelRule(width, theme)];

    for (const run of activeRuns) {
      const id = run.runId || "discovering...";
      const elapsed = formatElapsed(Date.now() - run.startedAt);
      const progress = this.manager.getProgress(run.runId);
      const last = progress.at(-1);

      // Find registry record for iteration info
      const record = run.runId ? findRun(this.cwd, run.runId) : undefined;
      const iter = record?.iteration ?? last?.iter ?? 0;
      const maxIter = record?.max_iterations ?? "?";
      const latestEvent = record?.latest_event ?? last?.recent ?? "";
      const role = last?.role ?? "";

      // Title line: runId (preset) iter/max elapsed
      const title =
        accent(id) +
        dim(` (${run.preset})`) +
        dim(` iter=${iter}/${maxIter}`) +
        dim(` ${elapsed}`);
      lines.push(padLine(title, width));

      // Detail line: role + latest event
      const parts: string[] = [];
      if (role) parts.push(theme.fg("warning", role));
      if (latestEvent) parts.push(dim(latestEvent));
      if (parts.length > 0) {
        lines.push(padLine(parts.join(dim(" → ")), width));
      }
    }

    return lines;
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}

export function setupLoopDock(
  manager: AutoloopManager,
  setWidget: (
    key: string,
    content: unknown,
    options?: { placement: string },
  ) => void,
  getCwd: () => string,
): () => void {
  let dockComponent: LoopDockComponent | null = null;

  function updateDock() {
    const activeRuns = manager.getRuns();
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
          dockComponent = new LoopDockComponent({ manager, theme, tui, cwd: getCwd() });
          return dockComponent;
        },
        { placement: "aboveEditor" },
      );
    }
  }

  const unsub = manager.onEvent(() => updateDock());

  return () => {
    unsub();
    dockComponent?.dispose();
    dockComponent = null;
  };
}

export { DOCK_WIDGET_ID };
