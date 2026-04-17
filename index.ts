import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AutoloopManager } from "./manager.ts";
import { renderStatusWidget, setupMessageRenderer } from "./render.ts";
import { setupLoopDock, DOCK_WIDGET_ID } from "./dock.ts";
import { createAutoloopTool } from "./tool.ts";
import { findRun, readRegistry } from "./registry.ts";
import { allRunCompletions, runningRunCompletions, inspectCompletions } from "./completions.ts";
import { MESSAGE_TYPE_AUTOLOOP_UPDATE, type AutoloopUpdateDetails, formatElapsed } from "./types.ts";

export default function (pi: ExtensionAPI) {
  const manager = new AutoloopManager();
  let unsubscribe: (() => void) | null = null;
  let cleanupDock: (() => void) | null = null;
  let latestContext: ExtensionContext | null = null;

  setupMessageRenderer(pi);

  function updateWidget() {
    if (!latestContext?.hasUI) return;
    const activeRuns = manager.getRuns();
    const recentRecords = readRegistry(latestContext.cwd);
    const maxWidth = process.stdout.columns || 120;
    const lines = renderStatusWidget(
      activeRuns,
      recentRecords,
      latestContext.ui.theme,
      maxWidth,
    );
    latestContext.ui.setWidget(
      "autoloop",
      lines.length > 0 ? lines : undefined,
      { placement: "belowEditor" },
    );
  }

  unsubscribe = manager.onEvent((event) => {
    if (event.type === "run_ended") {
      const { runId, record } = event;
      const status = record?.status ?? "unknown";
      const preset = record?.preset ?? "unknown";
      const iter = record?.iteration ?? 0;
      const max = record?.max_iterations ?? 0;

      // Compute elapsed from active run state or registry timestamps
      const activeRun = manager.getRuns().find((r) => r.runId === runId);
      let elapsed: string;
      if (activeRun) {
        elapsed = formatElapsed(Date.now() - activeRun.startedAt);
      } else if (record?.created_at && record?.updated_at) {
        elapsed = formatElapsed(new Date(record.updated_at).getTime() - new Date(record.created_at).getTime());
      } else {
        elapsed = "?";
      }

      const details: AutoloopUpdateDetails = {
        runId,
        preset,
        status,
        iteration: iter,
        maxIterations: max,
        elapsed,
      };

      pi.sendMessage(
        {
          customType: MESSAGE_TYPE_AUTOLOOP_UPDATE,
          content: `Autoloop run \`${runId}\` (${preset}) finished: **${status}** at iteration ${iter}/${max}`,
          display: true,
          details,
        },
        { triggerTurn: true },
      );
    }
    updateWidget();
  });

  pi.registerTool(createAutoloopTool(pi, manager));

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    updateWidget();
    // Set up the iteration dock (component factory, updates in place)
    cleanupDock?.();
    cleanupDock = setupLoopDock(
      manager,
      (key, content, options) => ctx.ui.setWidget(key, content as any, options as any),
      () => latestContext?.cwd ?? process.cwd(),
    );
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = null;
    cleanupDock?.();
    cleanupDock = null;
    manager.cleanup();
  });

  // -- Slash commands: /loop:* --

  pi.registerCommand("loop:run", {
    description: "Start an autoloop run. Usage: /loop:run <preset> <prompt>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /loop:run <preset> <prompt>", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/);
      const preset = parts[0];
      const prompt = parts.slice(1).join(" ");
      if (!prompt) {
        ctx.ui.notify("Usage: /loop:run <preset> <prompt>", "warning");
        return;
      }
      latestContext = ctx;
      const state = manager.startRun(preset, prompt, ctx.cwd);
      ctx.ui.notify(
        `Started autoloop: ${preset} (run ID discovering...)`,
        "info",
      );
      updateWidget();
    },
  });

  pi.registerCommand("loop:list", {
    description: "List all autoloop runs",
    handler: async (_args, ctx) => {
      const allRecords = readRegistry(ctx.cwd);
      const latest = new Map<string, typeof allRecords[0]>();
      for (const r of allRecords) latest.set(r.run_id, r);
      const runs = [...latest.values()];
      if (!runs.length) {
        ctx.ui.notify("No autoloop runs found", "info");
        return;
      }
      const lines = runs.map(
        (r) =>
          `${r.run_id} [${r.status}] ${r.preset} iter=${r.iteration}/${r.max_iterations}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  const getCwd = () => latestContext?.cwd ?? process.cwd();

  pi.registerCommand("loop:status", {
    description: "Show status of a run. Usage: /loop:status <runId>",
    getArgumentCompletions: allRunCompletions(manager, getCwd),
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /loop:status <runId>", "warning");
        return;
      }
      const record = findRun(ctx.cwd, runId);
      if (!record) {
        ctx.ui.notify(`Run not found: ${runId}`, "warning");
        return;
      }
      const progress = manager.getProgress(runId);
      const last = progress.at(-1);
      const msg = [
        `Run: ${record.run_id}`,
        `Status: ${record.status}`,
        `Preset: ${record.preset}`,
        `Iteration: ${record.iteration}/${record.max_iterations}`,
        `Event: ${record.latest_event}`,
        last ? `Role: ${last.role} | Outcome: ${last.outcome}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("loop:stop", {
    description: "Stop a running autoloop. Usage: /loop:stop <runId>",
    getArgumentCompletions: runningRunCompletions(manager, getCwd),
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /loop:stop <runId>", "warning");
        return;
      }
      latestContext = ctx;
      const stopped = await manager.stopRun(runId);
      ctx.ui.notify(
        stopped ? `Stopped: ${runId}` : `Failed to stop: ${runId}`,
        stopped ? "info" : "error",
      );
      updateWidget();
    },
  });

  pi.registerCommand("loop:inspect", {
    description:
      "Read a run artifact. Usage: /loop:inspect <runId> <scratchpad|journal|metrics|memory>",
    getArgumentCompletions: inspectCompletions(manager, getCwd),
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const runId = parts[0];
      const artifact = parts[1];
      if (!runId || !artifact) {
        ctx.ui.notify(
          "Usage: /loop:inspect <runId> <scratchpad|journal|metrics|memory>",
          "warning",
        );
        return;
      }
      const valid = ["scratchpad", "journal", "metrics", "memory"];
      if (!valid.includes(artifact)) {
        ctx.ui.notify(`Artifact must be one of: ${valid.join(", ")}`, "warning");
        return;
      }
      const res = await pi.exec(
        "autoloop",
        ["inspect", artifact, "--format", "md"],
        { timeout: 10_000 },
      );
      const output = res.stdout?.trim() || res.stderr?.trim() || "No output";
      ctx.ui.notify(output, res.code === 0 ? "info" : "error");
    },
  });

  pi.registerCommand("loop:presets", {
    description: "List available autoloop presets",
    handler: async (_args, ctx) => {
      const res = await pi.exec("autoloop", ["list"], { timeout: 10_000 });
      const output = res.stdout?.trim() || "No presets found";
      ctx.ui.notify(output, res.code === 0 ? "info" : "error");
    },
  });
}
