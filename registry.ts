import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "./types.ts";

export function readRegistry(cwd: string): RunRecord[] {
  const registryPath = join(cwd, ".autoloop", "registry.jsonl");
  let content: string;
  try {
    content = readFileSync(registryPath, "utf-8");
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RunRecord);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

export function findRun(cwd: string, runId: string): RunRecord | undefined {
  const records = readRegistry(cwd);
  // Registry appends updates, so last match for a run_id is the latest
  let latest: RunRecord | undefined;
  for (const r of records) {
    if (r.run_id === runId) latest = r;
  }
  return latest;
}
