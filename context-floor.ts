export const ITERATION_MARKER = "autoloop-iteration";
export const END_MARKER = "autoloop-end";

export interface IterationMarkerDetails {
  runId: string;
  iteration: number;
  maxIterations: number;
  preset: string;
  roles: string[];
  recentEvent: string;
}

export interface EndMarkerDetails {
  runId: string;
  stopReason: string;
  iterations: number;
  costUsd: number;
  error?: string;
}

export type LoopMarker =
  | { kind: "iteration"; details: IterationMarkerDetails }
  | { kind: "end"; details: EndMarkerDetails };

/** The fields of a pi message this module reads; every AgentMessage and custom message entry fits. */
export interface MessageLike {
  readonly role: string;
}

/** Markers come back from persisted transcripts, so details are checked, not trusted. */
export function readMarker(message: MessageLike): LoopMarker | null {
  if (message.role !== "custom") return null;
  const { customType, details } = message as MessageLike & { customType?: unknown; details?: unknown };
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.runId !== "string") return null;
  if (customType === ITERATION_MARKER && typeof d.iteration === "number") {
    return { kind: "iteration", details: d as unknown as IterationMarkerDetails };
  }
  if (customType === END_MARKER) return { kind: "end", details: d as unknown as EndMarkerDetails };
  return null;
}

export function isIterationMarkerFor(message: MessageLike, runId: string, iteration: number): boolean {
  const marker = readMarker(message);
  return marker?.kind === "iteration" && marker.details.runId === runId && marker.details.iteration === iteration;
}

/**
 * Derives the LLM context from the transcript alone.
 * - A closed run (iteration markers followed by its end marker) collapses to the end marker.
 *   A resumed run reopens after its end marker and closes again at the next one.
 * - An open run floors the context at its latest iteration marker.
 * - Everything outside a run is kept. Idempotent.
 */
export function projectLoopContext<M extends MessageLike>(messages: readonly M[]): M[] {
  const openedAt = new Map<string, number>();
  const latestMarker = new Map<string, number>();
  const dropped: Array<[from: number, to: number]> = [];
  messages.forEach((message, index) => {
    const marker = readMarker(message);
    if (!marker) return;
    const { runId } = marker.details;
    if (marker.kind === "iteration") {
      if (!openedAt.has(runId)) openedAt.set(runId, index);
      latestMarker.set(runId, index);
      return;
    }
    const from = openedAt.get(runId);
    if (from === undefined) return;
    dropped.push([from, index]);
    openedAt.delete(runId);
    latestMarker.delete(runId);
  });
  const floor = Math.max(0, ...latestMarker.values());
  return messages.filter((_, index) => index >= floor && !dropped.some(([from, to]) => index >= from && index < to));
}
