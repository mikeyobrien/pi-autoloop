import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Driver } from "./driver.ts";
import { findRun, readRegistry } from "./registry.ts";
import { renderCall, renderResult } from "./render.ts";
import { resolveAutoloopBin } from "./autoloop-bin.ts";
import type { AutoloopDetails, RunRecord } from "./types.ts";
import { formatIterationProgress } from "./native-state.ts";

const AutoloopParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("run"),
      Type.Literal("list"),
      Type.Literal("status"),
      Type.Literal("stop"),
      Type.Literal("inspect"),
      Type.Literal("presets"),
    ],
    {
      description:
        "Action: run (start autoloop in THIS session), list (show runs), status (get progress), stop (terminate), inspect (read artifacts), presets (list available presets)",
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
      description: "Run ID (required for stop; optional for status)",
    }),
  ),
  artifact: Type.Optional(
    Type.Union(
      [
        Type.Literal("scratchpad"),
        Type.Literal("journal"),
        Type.Literal("metrics"),
        Type.Literal("memory"),
      ],
      { description: "Artifact to inspect (for inspect action)" },
    ),
  ),
  backend: Type.Optional(
    Type.String({ description: "Ignored (native loops run in this session)" }),
  ),
  worktree: Type.Optional(
    Type.Boolean({ description: "Ignored (native loops run in this session, no worktree)" }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Enable verbose/debug output (for run)" }),
  ),
});

export function createAutoloopTool(pi: ExtensionAPI, driver: Driver) {
  return {
    name: "autoloop",
    label: "Autoloop",
    description: `Run autonomous LLM loops INSIDE this pi session (this session becomes the loop worker). Actions:
- run: Start an autoloop (requires preset, prompt). Returns immediately; subsequent turns are driven by the loop.
- list: Show active and recent runs
- status: Get run progress — returns journal path you can read with your own file tools
- stop: Stop the running autoloop (optional runId)
- inspect: Read structured run artifacts (requires runId, artifact)
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
          try {
            const state = driver.startRun({
              preset: params.preset,
              prompt: params.prompt,
              cwd: ctx.cwd,
              verbose: params.verbose,
            });
            return result(
              "run",
              true,
              `Started autoloop run ${state.runId} (preset: ${params.preset}). This session is now in loop mode: your next turns are the loop's iterations. Do the current role's work, then signal progress with loop_emit.`,
              {
                runId: state.runId,
              },
            );
          } catch (err) {
            return result("run", false, `Failed to start loop: ${(err as Error)?.message ?? err}`);
          }
        }
        case "list": {
          // Live in-process native loops, merged with legacy registry records.
          const runs: RunRecord[] = [];
          const active = new Set<string>();
          for (const s of driver.getRuns()) {
            active.add(s.runId);
            runs.push(nativeToRecord(s));
          }
          const allRecords = readRegistry(ctx.cwd);
          const latest = new Map<string, RunRecord>();
          for (const r of allRecords) latest.set(r.run_id, r);
          for (const r of latest.values()) {
            if (active.has(r.run_id)) continue;
            runs.push(r);
          }
          const summary = runs.length
            ? runs
                .map(
                  (r) =>
                    `${r.run_id} [${r.status}] ${r.preset}|${r.backend} iter=${formatIterationProgress(r.iteration, r.max_iterations)}`,
                )
                .join("\n")
            : "No runs found";
          return result("list", true, summary, { runs });
        }
        case "status": {
          // Prefer the live in-process loop state.
          const live = params.runId
            ? driver.getRuns().find((s) => s.runId === params.runId)
            : driver.getRuns()[0];
          if (live) {
            const rec = nativeToRecord(live);
            const msg = [
              `${rec.run_id} [${rec.status}] iter=${formatIterationProgress(rec.iteration, rec.max_iterations)} role=${live.activeRole}`,
              `journal: ${rec.journal_file}`,
            ].join("\n");
            return result("status", true, msg, {
              record: rec,
              runId: rec.run_id,
            });
          }
          if (!params.runId)
            return result("status", false, "No active loop; pass a runId to inspect a past run");
          const record = findRun(ctx.cwd, params.runId);
          if (!record)
            return result("status", false, `Run not found: ${params.runId}`);
          const msg = [
            `${record.run_id} [${record.status}] iter=${formatIterationProgress(record.iteration, record.max_iterations)} event=${record.latest_event}`,
            `journal: ${record.journal_file}`,
            `state_dir: ${record.state_dir}`,
            `work_dir: ${record.work_dir}`,
          ].join("\n");
          return result("status", true, msg, {
            record,
            runId: params.runId,
          });
        }
        case "stop": {
          const stopped = await driver.stop(params.runId);
          return result(
            "stop",
            stopped,
            stopped
              ? `Stopping loop${params.runId ? ` ${params.runId}` : ""} (terminates at next boundary)`
              : `No active loop to stop${params.runId ? `: ${params.runId}` : ""}`,
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

/** Project a live native LoopState onto the legacy RunRecord shape for renderers. */
function nativeToRecord(s: import("./types.ts").LoopState): RunRecord {
  const running = s.phase !== "idle";
  return {
    run_id: s.runId,
    status: running ? "running" : "completed",
    preset: s.preset,
    objective: s.objective,
    trigger: "cli",
    project_dir: "",
    work_dir: "",
    state_dir: "",
    journal_file: s.journalFile,
    parent_run_id: "",
    backend: "native",
    created_at: new Date(s.startedAt).toISOString(),
    updated_at: new Date().toISOString(),
    iteration: s.iteration,
    max_iterations: s.maxIterations,
    stop_reason: "",
    latest_event: "",
    isolation_mode: "none",
    worktree_name: "",
    worktree_path: "",
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
