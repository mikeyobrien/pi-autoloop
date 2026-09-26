import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { AutoloopManager } from "./detached.ts";
import { setupMessageRenderer } from "./render.ts";
import { setupLoopDock } from "./dock.ts";
import { createAutoloopTool } from "./tool.ts";
import { findRun, readRegistry } from "./registry.ts";
import { allRunCompletions, runningRunCompletions, inspectCompletions } from "./completions.ts";
import { resolveAutoloopBin } from "./autoloop-bin.ts";
import { MESSAGE_TYPE_AUTOLOOP_UPDATE, type AutoloopUpdateDetails, formatElapsed } from "./types.ts";
import { SessionLoop, type HarnessPort } from "./session-loop.ts";
import { harnessAdapter } from "./harness-adapter.ts";
import { registerMarkerRenderers } from "./markers.ts";
import { createEmitTool, EMIT_TOOL_NAME } from "./emit-tool.ts";
import { closeOrphanedRuns } from "./restore.ts";

export default autoloopExtension(harnessAdapter);

/** The harness is injectable so a scripted harness can drive the real wiring end to end. */
export function autoloopExtension(harness: HarnessPort) {
  return (pi: ExtensionAPI) => register(pi, harness);
}

function register(pi: ExtensionAPI, harness: HarnessPort) {
  const manager = new AutoloopManager();
  let unsubscribe: (() => void) | null = null;
  let dock: ReturnType<typeof setupLoopDock> | null = null;
  let latestContext: ExtensionContext | null = null;

  const loop = new SessionLoop(
    {
      sendMessage: (message, options) => pi.sendMessage(message, options),
      sendUserMessage: (text) => pi.sendUserMessage(text),
      abortAgent: () => latestContext?.abort(),
      update: (view) => {
        setEmitToolActive(view !== null);
        dock?.refresh();
      },
    },
    harness,
  );

  function setEmitToolActive(active: boolean) {
    const tools = pi.getActiveTools();
    if (tools.includes(EMIT_TOOL_NAME) === active) return;
    pi.setActiveTools(active ? [...tools, EMIT_TOOL_NAME] : tools.filter((t) => t !== EMIT_TOOL_NAME));
  }

  setupMessageRenderer(pi);
  registerMarkerRenderers(pi);

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

      pi.sendMessage({
        customType: MESSAGE_TYPE_AUTOLOOP_UPDATE,
        content: `Autoloop run \`${runId}\` (${preset}) finished: **${status}** at iteration ${iter + 1}/${max}`,
        display: true,
        details,
      });
    }
  });

  pi.registerTool(createAutoloopTool(pi, manager, loop));
  pi.registerTool(createEmitTool(() => loop.activeTurn()));

  // -- In-session loop: pi boundaries drive the SessionLoop phase machine --

  pi.on("context", (event) => ({ messages: loop.projectContext(event.messages) }));
  pi.on("agent_start", (_event, ctx) => {
    latestContext = ctx;
    loop.onAgentStart();
  });
  pi.on("message_end", (event) => loop.onMessageEnd(event.message));
  pi.on("agent_before_settle", (event) => loop.onBeforeSettle(event));
  pi.on("agent_settled", () => loop.onSettled());
  // Compaction would summarise the iteration marker away and break the context floor.
  pi.on("session_before_compact", () => (loop.isLive() ? { cancel: true } : undefined));

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;

    if (!loop.isLive()) {
      setEmitToolActive(false);
      const closed = closeOrphanedRuns(ctx.sessionManager.getBranch(), (message) => pi.sendMessage(message));
      for (const runId of closed) {
        ctx.ui.notify(`Autoloop ${runId} was interrupted with its session. Resume it with /loop:resume ${runId}`, "info");
      }
    }

    // Detached mode shells out to the autoloop CLI
    try {
      execFileSync(resolveAutoloopBin(), ["--version"], { stdio: "ignore", timeout: 5000 });
    } catch {
      ctx.ui.notify(
        "autoloop CLI unavailable for detached runs. Try: npm install -g @mobrienv/autoloop (or set PI_AUTOLOOP_BIN)",
        "warning",
      );
    }

    // Set up the iteration dock (component factory, updates in place)
    dock?.dispose();
    dock = setupLoopDock(
      manager,
      () => loop.view(),
      (key, content, options) => ctx.ui.setWidget(key, content as any, options as any),
      () => latestContext?.cwd ?? process.cwd(),
    );
    dock.refresh();
  });

  pi.on("session_shutdown", async () => {
    loop.detach();
    unsubscribe?.();
    unsubscribe = null;
    dock?.dispose();
    dock = null;
    manager.cleanup();
  });

  // -- Slash commands: /loop:* --

  const RUN_USAGE = "Usage: /loop:run [--detached] <preset> <objective>";

  pi.registerCommand("loop:run", {
    description: "Run an autoloop preset in this session (or --detached as a CLI process). " + RUN_USAGE,
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
      const detached = parts[0] === "--detached";
      if (detached) parts.shift();
      const [preset, ...rest] = parts;
      const objective = rest.join(" ");
      if (!preset || !objective) {
        ctx.ui.notify(RUN_USAGE, "warning");
        return;
      }
      latestContext = ctx;
      if (detached) {
        manager.startRun(preset, objective, ctx.cwd);
        ctx.ui.notify(`Started detached autoloop: ${preset} (run ID discovering...)`, "info");
        return;
      }
      try {
        loop.start({ preset, objective, cwd: ctx.cwd });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("loop:resume", {
    description: "Resume an interrupted autoloop run in this session. Usage: /loop:resume <runId>",
    getArgumentCompletions: allRunCompletions(manager, () => getCwd()),
    handler: async (args, ctx) => {
      const runId = args?.trim();
      if (!runId) {
        ctx.ui.notify("Usage: /loop:resume <runId>", "warning");
        return;
      }
      latestContext = ctx;
      try {
        loop.resume(runId, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("loop:continue", {
    description: "Continue a paused in-session iteration",
    handler: async (_args, ctx) => {
      if (!loop.continue()) ctx.ui.notify("No paused autoloop iteration", "warning");
    },
  });

  pi.registerCommand("loop:guide", {
    description: "Queue durable guidance for the next iteration. Usage: /loop:guide <text>",
    handler: async (args, ctx) => {
      const text = args?.trim();
      if (!text) {
        ctx.ui.notify("Usage: /loop:guide <text>", "warning");
        return;
      }
      try {
        const queued = loop.guide(text);
        ctx.ui.notify(queued ? "Guidance queued for the next iteration" : "No live autoloop with a run id yet", queued ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
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
          `${r.run_id} [${r.status}] ${r.preset}|${r.backend} iter=${r.iteration + 1}/${r.max_iterations}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  const getCwd = () => latestContext?.cwd ?? process.cwd();

  pi.registerCommand("loop:status", {
    description: "Show status of a run. Usage: /loop:status <runId>",
    getArgumentCompletions: allRunCompletions(manager, getCwd),
    handler: async (args, ctx) => {
      const runId = args?.trim() || loop.view()?.runId;
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
        `Backend: ${record.backend}`,
        `Iteration: ${record.iteration + 1}/${record.max_iterations}`,
        `Event: ${record.latest_event}`,
        last ? `Role: ${last.role} | Outcome: ${last.outcome}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("loop:stop", {
    description: "Stop the in-session loop, or a detached run by id. Usage: /loop:stop [runId]",
    getArgumentCompletions: runningRunCompletions(manager, getCwd),
    handler: async (args, ctx) => {
      const runId = args?.trim();
      latestContext = ctx;
      const live = loop.view();
      if (!runId || runId === live?.runId) {
        ctx.ui.notify(loop.stop() ? `Stopping autoloop ${live?.runId ?? ""}`.trim() : "No live autoloop in this session", "info");
        return;
      }
      const stopped = await manager.stopRun(runId);
      ctx.ui.notify(
        stopped ? `Stopped: ${runId}` : `Failed to stop: ${runId}`,
        stopped ? "info" : "error",
      );
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
        resolveAutoloopBin(),
        ["inspect", artifact, "--run", runId, "--format", "md"],
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

