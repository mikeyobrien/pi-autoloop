import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { Driver } from "./driver.ts";
import { readRegistry } from "./registry.ts";
import type { RunRecord } from "./types.ts";

function deduplicatedRuns(
  driver: Driver,
  getCwd: () => string,
): RunRecord[] {
  const active = driver.getRuns();
  const registry = readRegistry(getCwd());

  // Build a map keyed by run_id — active (in-process) runs take priority.
  const byId = new Map<string, RunRecord>();

  // Registry records first (last entry per run_id wins).
  for (const r of registry) {
    byId.set(r.run_id, r);
  }

  // Active native loops override registry.
  for (const a of active) {
    if (!a.runId) continue;
    byId.set(a.runId, {
      run_id: a.runId,
      status: a.phase === "idle" ? "completed" : "running",
      preset: a.preset,
    } as RunRecord);
  }

  return Array.from(byId.values());
}

function matchPrefix(
  runs: RunRecord[],
  prefix: string,
): AutocompleteItem[] {
  const lower = prefix.toLowerCase();
  return runs
    .filter((r) => r.run_id.toLowerCase().startsWith(lower))
    .map((r) => ({
      value: r.run_id,
      label: r.run_id,
      description: `${r.preset} [${r.status}]`,
    }));
}

export function allRunCompletions(
  driver: Driver,
  getCwd: () => string,
): (prefix: string) => AutocompleteItem[] {
  return (prefix: string) => {
    const runs = deduplicatedRuns(driver, getCwd);
    return matchPrefix(runs, prefix);
  };
}

export function runningRunCompletions(
  driver: Driver,
  getCwd: () => string,
): (prefix: string) => AutocompleteItem[] {
  return (prefix: string) => {
    const runs = deduplicatedRuns(driver, getCwd);
    return matchPrefix(
      runs.filter((r) => r.status === "running"),
      prefix,
    );
  };
}

const ARTIFACTS: AutocompleteItem[] = [
  { value: "scratchpad", label: "scratchpad", description: "Iteration scratchpad" },
  { value: "journal", label: "journal", description: "Event journal" },
  { value: "metrics", label: "metrics", description: "Run metrics" },
  { value: "memory", label: "memory", description: "Run memory/learnings" },
];

export function inspectCompletions(
  driver: Driver,
  getCwd: () => string,
): (prefix: string) => AutocompleteItem[] {
  return (prefix: string) => {
    const spaceIdx = prefix.indexOf(" ");
    if (spaceIdx === -1) {
      // Phase 1: complete run IDs
      const runs = deduplicatedRuns(driver, getCwd);
      return matchPrefix(runs, prefix);
    }
    // Phase 2: complete artifact names after the run ID
    const artifactPrefix = prefix.slice(spaceIdx + 1).toLowerCase();
    return ARTIFACTS.filter((a) =>
      a.value.toLowerCase().startsWith(artifactPrefix),
    );
  };
}
