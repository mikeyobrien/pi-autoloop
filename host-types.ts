// Mirror of the frozen `@mobrienv/autoloop-harness/host` contract (0.12.0).
// Replace with `export type * from "@mobrienv/autoloop-harness/host"` once 0.12.0 is published.

export interface EmitResult {
  ok: boolean;
  topic?: string;
  error?: string;
}

export interface HostWorker {
  /** Journaled as the backend label, e.g. "host:pi". */
  readonly label: string;
  /** Replaces the shell emit instructions in the prompt. */
  readonly eventToolHint: string;
  /** One iteration. Harness never calls again before the previous promise settles. Must not throw for model errors. */
  runTurn(turn: HostTurn): Promise<HostTurnResult>;
}

export interface HostTurn {
  readonly runId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly preset: string;
  readonly roles: readonly { readonly id: string; readonly prompt: string }[];
  readonly recentEvent: string;
  readonly allowedEvents: readonly string[];
  /** Exactly the text journaled in iteration.start.prompt. */
  readonly prompt: string;
  /** Validates against this iteration's routing, gates, task gate; journals accepted or event.invalid. */
  emit(topic: string, payload: string): EmitResult;
  /** Aborts on run stop or per-iteration deadline. */
  readonly signal: AbortSignal;
}

export type HostTurnResult =
  | { status: "completed"; output: string; usage?: HostUsage }
  | { status: "error"; output: string; usage?: HostUsage }
  | { status: "interrupted"; output: string; usage?: HostUsage };

export interface HostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}
