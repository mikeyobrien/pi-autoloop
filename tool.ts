import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AutoloopManager } from "./detached.ts";
import { startNotice, type SessionLoop } from "./session-loop.ts";
import { findRun, readRegistry } from "./registry.ts";
import { renderCall, renderResult } from "./render.ts";
import { resolveAutoloopBin } from "./autoloop-bin.ts";
import type { AutoloopDetails, RunRecord } from "./types.ts";

const AutoloopParams = Type.Object({
  action: StringEnum(
    ["run", "list", "status", "stop", "inspect", "presets"] as const,
    {
      description:
        "Action: run (start autoloop), list (show runs), status (get progress), stop (terminate), inspect (read artifacts), presets (list available presets)",
    },
  ),
  preset: Type.Optional(
    Type.String({ description: "Preset name (required for run)" }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "Task prompt (required for run)" }),
  ),
  runId: Type.Optional(
    Type.String({
      description: "Run ID (required for status/stop/inspect)",
    }),
  ),
  artifact: Type.Optional(
    StringEnum(["scratchpad", "journal", "metrics", "memory"] as const, {
      description: "Artifact to inspect (for inspect action)",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["session", "detached"] as const, {
      description:
        "session (default): run the loop in this pi session with you as the worker. detached: spawn the autoloop CLI in the background",
    }),
  ),
  backend: Type.Optional(
    Type.String({ description: "Override backend command (detached runs only)" }),
  ),
  worktree: Type.Optional(
    Type.Boolean({ description: "Use git worktree isolation (detached runs only)" }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Enable verbose/debug output (detached runs only)" }),
  ),
});

export function createAutoloopTool(pi: ExtensionAPI, manager: AutoloopManager, loop: SessionLoop) {
  return {
    name: "autoloop",
    label: "Autoloop",
    description: `Run autonomous LLM loops. Actions:
- run: Start an autoloop (requires preset, prompt). Default mode "session" runs it in this conversation: after your reply ends, each iteration arrives as a message with a fresh context; do the work and call autoloop_emit. mode "detached" spawns a background CLI run
- list: Show active and recent runs
- status: Get run progress — returns journal/state_dir/work_dir paths you can read with your own file tools (requires runId)
- stop: Stop the in-session loop (no runId) or a detached run (runId)
- inspect: Read structured run artifacts (requires runId, artifact). For ad-hoc files (progress.md, fix-log.md, scratchpads), get state_dir from status and read files directly with your read/bash tools.
- presets: List available presets`,
    promptSnippet: "Run autonomous LLM loops for complex multi-step tasks",
    parameters: AutoloopParams,

    renderCall: (args: Record<string, unknown>, theme: Theme) =>
      renderCall(
        args as Parameters<typeof renderCall>[0],
        theme,
      ),

    renderResult: (
      result: AgentToolResult<AutoloopDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
    ) => renderResult(result, options, theme),

    async execute(
      _toolCallId: string,
      params: {
        action: string;
        preset?: string;
        prompt?: string;
        mode?: "session" | "detached";
        runId?: string;
        artifact?: string;
        backend?: string;
        worktree?: boolean;
        verbose?: boolean;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: AutoloopDetails;
    }> {
      switch (params.action) {
        case "run": {
          if (!params.preset || !params.prompt) {
            return result(
              "run",
              false,
              "Missing required params: preset and prompt",
            );
          }
          if (params.mode !== "detached") {
            try {
              loop.start({ preset: params.preset, objective: params.prompt, cwd: ctx.cwd });
            } catch (error) {
              return result("run", false, error instanceof Error ? error.message : String(error));
            }
            return result(
              "run",
              true,
              `${startNotice(params.preset)} Iteration 1 starts after this reply; end your reply now.`,
            );
          }
          const state = manager.startRun(
            params.preset,
            params.prompt,
            ctx.cwd,
            {
              backend: params.backend,
              worktree: params.worktree,
              verbose: params.verbose,
            },
          );
          return result(
            "run",
            true,
            `Started autoloop run (preset: ${params.preset})`,
            {
              runId: state.runId || "(discovering...)",
            },
          );
        }
        case "list": {
          const allRecords = readRegistry(ctx.cwd);
          // Deduplicate: keep only the latest record per run_id
          const latest = new Map<string, RunRecord>();
          for (const r of allRecords) latest.set(r.run_id, r);
          const runs = [...latest.values()];
          const summary = runs.length
            ? runs
                .map(
                  (r) =>
                    `${r.run_id} [${r.status}] ${r.preset}|${r.backend} iter=${r.iteration + 1}/${r.max_iterations}`,
                )
                .join("\n")
            : "No runs found";
          return result("list", true, summary, { runs });
        }
        case "status": {
          if (!params.runId)
            return result("status", false, "Missing required param: runId");
          const record = findRun(ctx.cwd, params.runId);
          const progress = manager.getProgress(params.runId);
          if (!record)
            return result("status", false, `Run not found: ${params.runId}`);
          const msg = [
            `${record.run_id} [${record.status}] iter=${record.iteration + 1}/${record.max_iterations} event=${record.latest_event}`,
            `journal: ${record.journal_file}`,
            `state_dir: ${record.state_dir}`,
            `work_dir: ${record.work_dir}`,
          ].join("\n");
          return result("status", true, msg, {
            record,
            progress,
            runId: params.runId,
          });
        }
        case "stop": {
          const liveRunId = loop.view()?.runId;
          if (!params.runId || params.runId === liveRunId) {
            const stopping = loop.stop();
            return result(
              "stop",
              stopping,
              stopping ? `Stopping in-session autoloop ${liveRunId ?? ""}`.trim() : "No live autoloop in this session",
              liveRunId ? { runId: liveRunId } : undefined,
            );
          }
          const stopped = await manager.stopRun(params.runId);
          return result(
            "stop",
            stopped,
            stopped
              ? `Stopped run ${params.runId}`
              : `Failed to stop run ${params.runId}`,
            { runId: params.runId },
          );
        }
        case "inspect": {
          if (!params.runId || !params.artifact)
            return result(
              "inspect",
              false,
              "Missing required params: runId and artifact",
            );
          const res = await pi.exec(
            resolveAutoloopBin(),
            ["inspect", params.artifact, "--run", params.runId, "--format", "md"],
            { timeout: 10_000 },
          );
          const output =
            res.stdout?.trim() || res.stderr?.trim() || "No output";
          return result("inspect", res.code === 0, output, {
            output,
            runId: params.runId,
          });
        }
        case "presets": {
          const res = await pi.exec(resolveAutoloopBin(), ["list"], { timeout: 10_000 });
          const output = res.stdout?.trim() || "No presets found";
          return result("presets", res.code === 0, output, { output });
        }
        default:
          return result(
            params.action,
            false,
            `Unknown action: ${params.action}`,
          );
      }
    },
  };
}

function result(
  action: string,
  success: boolean,
  message: string,
  extra?: Partial<AutoloopDetails>,
) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { action, success, message, ...extra },
  };
}
