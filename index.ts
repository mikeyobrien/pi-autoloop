import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { Driver } from "./driver.ts";
import { registerLoopTools } from "./tools-loop.ts";
import { setupMessageRenderer } from "./render.ts";
import { setupLoopDock } from "./dock.ts";
import { createAutoloopTool } from "./tool.ts";
import { findRun, readRegistry } from "./registry.ts";
import { allRunCompletions, runningRunCompletions, inspectCompletions } from "./completions.ts";
import { resolveAutoloopBin } from "./autoloop-bin.ts";
import {
  MESSAGE_TYPE_AUTOLOOP_UPDATE,
  type AutoloopUpdateDetails,
  formatElapsed,
} from "./types.ts";
import { formatIterationProgress } from "./native-state.ts";

export default function (pi: ExtensionAPI) {
  const driver = new Driver(pi);
  let unsubscribe: (() => void) | null = null;
  let cleanupDock: (() => void) | null = null;
  let latestContext: ExtensionContext | null = null;

  setupMessageRenderer(pi);

  // When a native loop terminates, surface a completion message in the session.
  unsubscribe = driver.onEvent((event) => {
    if (event.type === "run_ended") {
      const { runId } = event;
      // Derive the completion string from the RunSummary + loop limits (carried on
      // the event), NOT from the in-memory LoopState — the loop is already deleted
      // by finalize() and its counters are not the source of truth for this string.
      const info = event.info;
      const preset = info?.preset ?? "unknown";
      const completed = info?.iterations ?? 0;
      const max = info?.maxIterations ?? 0;
      const status = info?.stopReason ?? "finished";
      const elapsed = info ? formatElapsed(Date.now() - info.startedAt) : "?";

      const details: AutoloopUpdateDetails = {
        runId,
        preset,
        status,
        iteration: completed,
        maxIterations: max,
        elapsed,
      };

      // completed = number of iterations that actually finished; max = configured
      // ceiling. Both come straight from the engine's terminal summary/limits.
      const progress = max > 0 ? `${completed}/${max} iterations` : `${completed} iterations`;
      pi.sendMessage(
        {
          customType: MESSAGE_TYPE_AUTOLOOP_UPDATE,
          content: `Autoloop run \`${runId}\` (${preset}) ${status} after ${progress}`,
          display: true,
          details,
        },
        { triggerTurn: false },
      );
    }
  });

  // Native loop_emit / loop_memory / loop_task tools (used by the worker inside a loop).
  registerLoopTools(pi, driver);

  // The user-facing `autoloop` tool (run/list/status/stop/inspect/presets).
  pi.registerTool(createAutoloopTool(pi, driver));

  // -- Native loop drive: delegate pi session events to the driver. Each handler
  //    no-ops unless a loop is actively driving this session's turns. --

  pi.on("before_agent_start", (event, ctx) => driver.onBeforeAgentStart(event, ctx));
  pi.on("context", (event, ctx) => driver.onContext(event, ctx));
  pi.on("agent_end", (event, ctx) => driver.onAgentEnd(event, ctx));

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;

    // Verify the autoloop binary is runnable (still used by inspect/presets).
    try {
      execFileSync(resolveAutoloopBin(), ["--version"], { stdio: "ignore", timeout: 5000 });
    } catch {
      ctx.ui.notify(
        "autoloop CLI unavailable. Try: npm install -g @mobrienv/autoloop (or set PI_AUTOLOOP_BIN)",
        "warning",
      );
    }

    // Set up the iteration dock (component factory, updates in place).
    cleanupDock?.();
    cleanupDock = setupLoopDock(
      driver,
      (key, content, options) => ctx.ui.setWidget(key, content as any, options as any),
      () => latestContext?.cwd ?? process.cwd(),
    );
  });

  pi.on("session_shutdown", async () => {
    // Mark any active native run interrupted (the loop dies with pi).
    driver.shutdown();
    unsubscribe?.();
    unsubscribe = null;
    cleanupDock?.();
    cleanupDock = null;
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
      try {
        const state = driver.startRun({ preset, prompt, cwd: ctx.cwd });
        ctx.ui.notify(
          `Started autoloop: ${preset} (run ${state.runId}). This session is now the loop worker.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Failed to start loop: ${(err as Error)?.message ?? err}`, "error");
      }
    },
  });

  const getCwd = () => latestContext?.cwd ?? process.cwd();

  pi.registerCommand("loop:list", {
    description: "List all autoloop runs",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      // Active native loops (in-process).
      for (const s of driver.getRuns()) {
        lines.push(
          `${s.runId} [${s.phase}] ${s.preset} iter=${formatIterationProgress(s.iteration, s.maxIterations)} role=${s.activeRole}`,
        );
      }
      // Legacy registry runs (from the old spawned-CLI version).
      const active = new Set(driver.getRuns().map((s) => s.runId));
      const allRecords = readRegistry(ctx.cwd);
      const latest = new Map<string, typeof allRecords[0]>();
      for (const r of allRecords) latest.set(r.run_id, r);
      for (const r of latest.values()) {
        if (active.has(r.run_id)) continue;
        lines.push(
          `${r.run_id} [${r.status}] ${r.preset}|${r.backend} iter=${formatIterationProgress(r.iteration, r.max_iterations)}`,
        );
      }
      ctx.ui.notify(lines.length ? lines.join("\n") : "No autoloop runs found", "info");
    },
  });

  pi.registerCommand("loop:status", {
    description: "Show status of a run. Usage: /loop:status <runId>",
    getArgumentCompletions: allRunCompletions(driver, getCwd),
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /loop:status <runId>", "warning");
        return;
      }
      // Prefer the live in-process loop state.
      const live = driver.getRuns().find((s) => s.runId === runId);
      if (live) {
        const msg = [
          `Run: ${live.runId}`,
          `Phase: ${live.phase}`,
          `Preset: ${live.preset}`,
          `Iteration: ${formatIterationProgress(live.iteration, live.maxIterations)}`,
          `Role: ${live.activeRole}`,
          `Journal: ${live.journalFile}`,
        ].join("\n");
        ctx.ui.notify(msg, "info");
        return;
      }
      // Fall back to legacy registry records.
      const record = findRun(ctx.cwd, runId);
      if (!record) {
        ctx.ui.notify(`Run not found: ${runId}`, "warning");
        return;
      }
      const msg = [
        `Run: ${record.run_id}`,
        `Status: ${record.status}`,
        `Preset: ${record.preset}`,
        `Backend: ${record.backend}`,
        `Iteration: ${formatIterationProgress(record.iteration, record.max_iterations)}`,
        `Event: ${record.latest_event}`,
      ].join("\n");
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("loop:stop", {
    description: "Stop the running autoloop. Usage: /loop:stop [runId]",
    getArgumentCompletions: runningRunCompletions(driver, getCwd),
    handler: async (args, ctx) => {
      const runId = args?.trim() || undefined;
      latestContext = ctx;
      const stopped = await driver.stop(runId);
      ctx.ui.notify(
        stopped
          ? `Stopping loop${runId ? ` ${runId}` : ""} (terminates at next boundary)`
          : `No active loop to stop${runId ? `: ${runId}` : ""}`,
        stopped ? "info" : "error",
      );
    },
  });

  pi.registerCommand("loop:inspect", {
    description:
      "Read a run artifact. Usage: /loop:inspect <runId> <scratchpad|journal|metrics|memory>",
    getArgumentCompletions: inspectCompletions(driver, getCwd),
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
        resolveAutoloopBin(),
        ["inspect", artifact, "--run-id", runId, "--format", "md"],
        { timeout: 10_000 },
      );
      const output = res.stdout?.trim() || res.stderr?.trim() || "No output";
      ctx.ui.notify(output, res.code === 0 ? "info" : "error");
    },
  });

  pi.registerCommand("loop:presets", {
    description: "List available autoloop presets",
    handler: async (_args, ctx) => {
      const res = await pi.exec(resolveAutoloopBin(), ["list"], { timeout: 10_000 });
      const output = res.stdout?.trim() || "No presets found";
      ctx.ui.notify(output, res.code === 0 ? "info" : "error");
    },
  });
}
