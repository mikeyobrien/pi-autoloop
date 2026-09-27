import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readMarker, type IterationMarkerDetails } from "./context-floor.ts";
import { endMarker, type MarkerMessage } from "./markers.ts";

/** Runs whose latest iteration marker on this branch has no end marker after it. */
export function orphanedRuns(branch: readonly SessionEntry[]): IterationMarkerDetails[] {
  const open = new Map<string, IterationMarkerDetails>();
  for (const entry of branch) {
    if (entry.type !== "custom_message") continue;
    const message = { role: "custom", customType: entry.customType, details: entry.details };
    const marker = readMarker(message);
    if (marker?.kind === "iteration") open.set(marker.details.runId, marker.details);
    else if (marker?.kind === "end") open.delete(marker.details.runId);
  }
  return [...open.values()];
}

/**
 * session_start with no live loop: an open segment belongs to a run that died with its session.
 * Closing it lifts the context floor. Never triggers a turn. Returns the closed run ids.
 */
export function closeOrphanedRuns(
  branch: readonly SessionEntry[],
  send: (message: MarkerMessage<unknown>) => void,
): string[] {
  return orphanedRuns(branch).map((run) => {
    send(endMarker({ runId: run.runId, stopReason: "interrupted", iterations: run.iteration, costUsd: 0 }));
    return run.runId;
  });
}
