import { join, resolve as resolvePath } from "node:path";
import { resolvePresetSource } from "@mobrienv/autoloop-core/config";
import { appendOperatorEvent } from "@mobrienv/autoloop-core/journal";
import { findRunByPrefix } from "@mobrienv/autoloop-core/registry/read";
import { resume, resumeProblem, run } from "@mobrienv/autoloop-harness";
import { resolveAutoloopBin } from "./autoloop-bin.ts";
import type { HostWorker } from "./host-types.ts";
import type { HarnessPort, RunOutcome, StartRequest } from "./session-loop.ts";

// `host` is new in 0.12.0; declared here so this compiles against either version.
interface HostOptions {
  host: HostWorker;
  signal: AbortSignal;
}

// Metareview runs a second worker, which the host preflight refuses; most bundled presets enable it.
const IN_SESSION_CONFIG = { review: { enabled: false } };
// The harness logs to stderr, which would draw over pi's TUI.
const QUIET = "none";

/** The generated `autoloops memory|task` wrappers re-invoke this command. */
const selfCommand = () => `'${resolveAutoloopBin()}'`;

function findRecord(cwd: string, runId: string) {
  const found = findRunByPrefix(join(cwd, ".autoloop", "registry.jsonl"), runId);
  if (!found) throw new Error(`no autoloop run matching ${runId}`);
  if (Array.isArray(found)) throw new Error(`${runId} is ambiguous: ${found.map((r) => r.run_id).join(", ")}`);
  return found;
}

export const harnessAdapter: HarnessPort = {
  async run(request: StartRequest, host: HostWorker, signal: AbortSignal): Promise<RunOutcome> {
    const source = resolvePresetSource(request.preset, "");
    if (!source) throw new Error(`unknown autoloop preset: ${request.preset}`);
    const options: HostOptions & {
      workDir: string;
      presetFile?: string;
      configOverride: Record<string, unknown>;
      logLevel: string;
      noWorktree: boolean;
    } = {
      host,
      signal,
      workDir: request.cwd,
      // Pi's tools act on the session cwd; a worktree run would edit files the agent never sees.
      noWorktree: true,
      configOverride: IN_SESSION_CONFIG,
      logLevel: QUIET,
      ...(source.kind === "file" ? { presetFile: source.file } : {}),
    };
    return run(source.projectDir, request.objective, selfCommand(), options);
  },

  async resume(runId: string, cwd: string, host: HostWorker, signal: AbortSignal): Promise<RunOutcome> {
    const record = findRecord(cwd, runId);
    const problem = resumeProblem(record);
    if (problem) throw new Error(problem);
    if (record.isolation_mode === "worktree") {
      throw new Error(`${record.run_id} runs in a worktree, which pi's tools cannot reach; resume it with the autoloop CLI`);
    }
    if (resolvePath(record.work_dir) !== resolvePath(cwd)) {
      throw new Error(`${record.run_id} works in ${record.work_dir}; resume it from a pi session there`);
    }
    const options: HostOptions & { selfCommand: string; baseStateDir: string; configOverride: Record<string, unknown>; logLevel: string } = {
      host,
      signal,
      configOverride: IN_SESSION_CONFIG,
      logLevel: QUIET,
      selfCommand: selfCommand(),
      baseStateDir: join(cwd, ".autoloop"),
    };
    return resume(record, options);
  },

  guide(runId: string, cwd: string, text: string): void {
    const record = findRecord(cwd, runId);
    appendOperatorEvent(record.journal_file, record.run_id, "", "operator.guidance", text);
  },
};
