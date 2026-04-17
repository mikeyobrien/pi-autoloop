import { StringEnum } from "@mariozechner/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AutoloopManager } from "./manager.ts";
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
  backend: Type.Optional(
    Type.String({ description: "Override backend command (for run)" }),
  ),
  worktree: Type.Optional(
    Type.Boolean({ description: "Use git worktree isolation (for run)" }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Enable verbose/debug output (for run)" }),
  ),
});

export function createAutoloopTool(pi: ExtensionAPI, manager: AutoloopManager) {
  return {
    name: "autoloop",
    label: "Autoloop",
    description: `Run autonomous LLM loops. Actions:
- run: Start an autoloop (requires preset, prompt)
- list: Show active and recent runs
- status: Get run progress — returns journal/state_dir/work_dir paths you can read with your own file tools (requires runId)
- stop: Stop a running autoloop (requires runId)
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
          if (!params.runId)
            return result("stop", false, "Missing required param: runId");
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
            ["inspect", params.artifact, "--run-id", params.runId, "--format", "md"],
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
