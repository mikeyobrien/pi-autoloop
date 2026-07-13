// Legacy registry record shape (child-process runs). Retained so /loop:inspect,
// /loop:list and the completion helpers can still read old .autoloop/registry.jsonl
// entries written by the pre-native (spawned-CLI) version.
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

/**
 * Lifecycle phase of a native loop.
 *  - idle:               constructed, not yet started
 *  - awaiting-iteration: seed sent (or about to be), waiting for the turn to begin
 *  - running:            an iteration turn is in flight (pi's model is working)
 *  - stopping:           stop requested; will terminate at the next boundary
 */
export type LoopPhase = "idle" | "awaiting-iteration" | "running" | "stopping";

/**
 * Authoritative in-memory state for a single native (in-pi) loop.
 *
 * Field naming intentionally preserves `.runId` / `.preset` / `.startedAt` so the
 * dock, completions, and index continue to compile against the same accessors
 * they used for the old child-process AutoloopRunState.
 */
export interface LoopState {
  runId: string;
  preset: string;
  objective: string;
  startedAt: number;
  iteration: number;
  maxIterations: number;
  activeRole: string;
  phase: LoopPhase;
  journalFile: string;
}

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
  progress?: unknown;
  output?: string;
}

/**
 * Native loop lifecycle events emitted by the Driver. `run_progress` carries the
 * per-iteration routing snapshot (iteration / role / most-recent event) that the
 * dock and status surfaces render.
 */
export interface RunEndedInfo {
  /** Preset name for the completed run. */
  preset: string;
  /** Authoritative completed-iteration count (from the RunSummary). */
  iterations: number;
  /** Configured iteration ceiling (from the loop limits). */
  maxIterations: number;
  /** Terminal reason (e.g. "complete", "max_iterations", "interrupted"). */
  stopReason: string;
  /** Run start epoch ms, for elapsed display. */
  startedAt: number;
}

export type AutoloopEvent =
  | { type: "run_started"; runId: string; preset: string }
  | { type: "run_ended"; runId: string; info?: RunEndedInfo; record?: RunRecord }
  | {
      type: "run_progress";
      runId: string;
      iteration: number;
      role: string;
      event: string;
    }
  | { type: "runs_changed" };

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
