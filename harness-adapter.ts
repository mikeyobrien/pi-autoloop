import { join } from "node:path";
import { resolvePresetSource } from "@mobrienv/autoloop-core/config";
import { appendOperatorEvent } from "@mobrienv/autoloop-core/journal";
import { findRunByPrefix } from "@mobrienv/autoloop-core/registry/read";
import { resume, run } from "@mobrienv/autoloop-harness";
import { resolveAutoloopBin } from "./autoloop-bin.ts";
import type { HostWorker } from "./host-types.ts";
import type { HarnessPort, RunOutcome, StartRequest } from "./session-loop.ts";

// `host` is new in 0.12.0; declared here so this compiles against either version.
interface HostOptions {
  host: HostWorker;
  signal: AbortSignal;
}

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
    const options: HostOptions & { workDir: string; presetFile?: string } = {
      host,
      signal,
      workDir: request.cwd,
      ...(source.kind === "file" ? { presetFile: source.file } : {}),
    };
    return run(source.projectDir, request.objective, selfCommand(), options);
  },

  async resume(runId: string, cwd: string, host: HostWorker, signal: AbortSignal): Promise<RunOutcome> {
    const options: HostOptions & { selfCommand: string; baseStateDir: string } = {
      host,
      signal,
      selfCommand: selfCommand(),
      baseStateDir: join(cwd, ".autoloop"),
    };
    return resume(findRecord(cwd, runId), options);
  },

  guide(runId: string, cwd: string, text: string): void {
    const record = findRecord(cwd, runId);
    appendOperatorEvent(record.journal_file, record.run_id, "", "operator.guidance", text);
  },
};
