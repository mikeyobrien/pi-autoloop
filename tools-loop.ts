import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { emit } from "@mobrienv/autoloop-harness/emit";
import { addLearning, addRunLearning } from "@mobrienv/autoloop-core/memory";
import { addTask, completeTask } from "@mobrienv/autoloop-core/tasks";

import type { Driver } from "./driver.ts";

interface LoopToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function res(text: string, details: Record<string, unknown>, isError = false): LoopToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

/**
 * Native loop tools. Each execute() targets the ACTIVE loop's paths and mirrors
 * the CLI runtime-tool dispatch exactly (see autoloop-cli main.js / commands/*),
 * so file effects are byte-identical to `autoloop emit|memory|task`.
 *
 * The Driver publishes the AUTOLOOP_* runtime env at the start of every
 * iteration; emit/addTask/completeTask/addRunLearning all resolve their target
 * files through those env vars + the loop's projectDir/stateDir, matching the
 * CLI. getActiveLoopPaths re-applies that env defensively so a tool that fires
 * slightly outside the seeded window never misroutes a write.
 */
export function registerLoopTools(pi: ExtensionAPI, driver: Driver): void {
  const activePaths = () => {
    const state = driver.getRuns().find((s) => s.phase !== "idle");
    if (!state) return null;
    return driver.getActiveLoopPaths(state.runId);
  };

  const noLoop = (tool: string) =>
    res(
      `${tool}: no active autoloop in this session. This tool only works inside a running loop.`,
      { ok: false, error: "no_active_loop" },
      true,
    );

  // -- loop_emit --
  pi.registerTool({
    name: "loop_emit",
    label: "Loop Emit",
    description:
      "Emit an autoloop routing event for the current iteration. Use in place of any " +
      "`{{TOOL_PATH}} emit <topic> <payload>` instruction in your role. The loop advances " +
      "based on the topic you emit (e.g. tasks.ready, review.passed, task.complete).",
    promptSnippet: "Emit an autoloop routing event (replaces `autoloop emit`).",
    parameters: Type.Object({
      topic: Type.String({ description: "Event topic, e.g. `task.complete`, `review.passed`." }),
      payload: Type.Optional(
        Type.String({ description: "Free-text payload/summary for the event." }),
      ),
    }),
    async execute(_id, params): Promise<LoopToolResult> {
      const paths = activePaths();
      if (!paths) return noLoop("loop_emit");
      const p = params as { topic: string; payload?: string };
      const r = emit(paths.projectDir, p.topic, p.payload ?? "");
      if (r.ok) return res(`emitted ${r.topic ?? p.topic}`, { ok: true, topic: r.topic ?? p.topic });
      return res(r.error ?? `rejected ${p.topic}`, { ok: false, topic: p.topic, error: r.error }, true);
    },
  });

  // -- loop_memory --
  pi.registerTool({
    name: "loop_memory",
    label: "Loop Memory",
    description:
      "Record a learning into autoloop memory. Defaults to run-scoped memory (this run only); " +
      "use scope=project to persist across runs. Replaces any `autoloop memory add` instruction.",
    promptSnippet: "Record an autoloop learning (replaces `autoloop memory add`).",
    parameters: Type.Object({
      text: Type.String({ description: "The learning to record." }),
      source: Type.Optional(
        Type.String({ description: "Source tag for the learning (default: manual)." }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("run"), Type.Literal("project")], {
          description: "run = this run only (default); project = persist across runs.",
        }),
      ),
    }),
    async execute(_id, params): Promise<LoopToolResult> {
      const paths = activePaths();
      if (!paths) return noLoop("loop_memory");
      const p = params as unknown as { text: string; source?: string; scope?: string };
      const source = p.source ?? "manual";
      if (p.scope === "project") addLearning(paths.projectDir, p.text, source);
      else addRunLearning(paths.stateDir, p.text, source);
      return res(`recorded ${p.scope === "project" ? "project" : "run"} learning`, {
        ok: true,
        scope: p.scope ?? "run",
      });
    },
  });

  // -- loop_task --
  pi.registerTool({
    name: "loop_task",
    label: "Loop Task",
    description:
      "Add or complete an autoloop task. Open blocking tasks prevent the loop from completing, " +
      "so complete them as you finish. Replaces any `autoloop task add|complete` instruction.",
    promptSnippet: "Add/complete an autoloop task (replaces `autoloop task`).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("complete")], {
        description: "add a new task or complete an existing one.",
      }),
      text: Type.Optional(Type.String({ description: "Task text (required for add)." })),
      id: Type.Optional(Type.String({ description: "Task id (required for complete)." })),
    }),
    async execute(_id, params): Promise<LoopToolResult> {
      const paths = activePaths();
      if (!paths) return noLoop("loop_task");
      const p = params as unknown as { action: string; text?: string; id?: string };
      if (p.action === "add") {
        if (!p.text) return res("loop_task add: `text` is required", { ok: false, error: "missing_text" }, true);
        const id = addTask(paths.projectDir, p.text, "manual");
        return res(`added task ${id}`, { ok: true, id });
      }
      if (p.action === "complete") {
        if (!p.id) return res("loop_task complete: `id` is required", { ok: false, error: "missing_id" }, true);
        const ok = completeTask(paths.projectDir, p.id);
        return res(ok ? `completed task ${p.id}` : `task not found: ${p.id}`, { ok, id: p.id }, !ok);
      }
      return res(`unknown action: ${p.action}`, { ok: false, error: "unknown_action" }, true);
    },
  });
}
