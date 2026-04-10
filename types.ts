import type { ChildProcess } from "node:child_process";

export interface RunRecord {
  run_id: string;
  status: "running" | "completed" | "failed" | "timed_out" | "stopped";
  preset: string;
  objective: string;
  trigger: string;
  project_dir: string;
  work_dir: string;
  state_dir: string;
  journal_file: string;
  parent_run_id: string;
  backend: string;
  created_at: string;
  updated_at: string;
  iteration: number;
  max_iterations: number;
  stop_reason: string;
  latest_event: string;
  isolation_mode: string;
  worktree_name: string;
  worktree_path: string;
  pid?: number;
}

export interface ProgressLine {
  ts: string;
  run_id: string;
  iter: number;
  role: string;
  recent: string;
  emitted: string;
  outcome: string;
}

export interface AutoloopRunState {
  runId: string;
  preset: string;
  prompt: string;
  cwd: string;
  process: ChildProcess;
  stdoutLogFile: string;
  startedAt: number;
}

export type AutoloopEvent =
  | { type: "run_started"; runId: string; preset: string }
  | { type: "run_ended"; runId: string; record?: RunRecord }
  | { type: "run_progress"; runId: string; progress: ProgressLine }
  | { type: "runs_changed" };

export const MESSAGE_TYPE_AUTOLOOP_UPDATE = "autoloop-update";

export interface AutoloopUpdateDetails {
  runId: string;
  preset: string;
  status: string;
  iteration: number;
  maxIterations: number;
  elapsed: string;
}

export interface AutoloopDetails {
  action: string;
  success: boolean;
  message: string;
  runId?: string;
  runs?: RunRecord[];
  record?: RunRecord;
  progress?: ProgressLine[];
  output?: string;
}

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
