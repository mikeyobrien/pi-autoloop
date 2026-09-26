import type { CustomMessageEntryDraft, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  END_MARKER,
  ITERATION_MARKER,
  type EndMarkerDetails,
  type IterationMarkerDetails,
} from "./context-floor.ts";
import type { HostTurn } from "./host-types.ts";

export interface MarkerMessage<T> {
  customType: typeof ITERATION_MARKER | typeof END_MARKER;
  content: string;
  display: true;
  details: T;
}

const SUCCESS_REASONS = new Set(["completed", "completion_event", "completion_promise"]);

export function iterationMarker(turn: HostTurn): MarkerMessage<IterationMarkerDetails> {
  return {
    customType: ITERATION_MARKER,
    content: turn.prompt,
    display: true,
    details: {
      runId: turn.runId,
      iteration: turn.iteration,
      maxIterations: turn.maxIterations,
      preset: turn.preset,
      roles: turn.roles.map((r) => r.id),
      recentEvent: turn.recentEvent,
    },
  };
}

export function endMarker(end: EndMarkerDetails): MarkerMessage<EndMarkerDetails> {
  const error = end.error ? ` Error: ${end.error}` : "";
  return {
    customType: END_MARKER,
    content: `Autoloop run ${end.runId} ended (${end.stopReason}) after ${end.iterations} iteration(s), cost ${formatCost(end.costUsd)}.${error}`,
    display: true,
    details: end,
  };
}

export function asDraft<T>(message: MarkerMessage<T>): CustomMessageEntryDraft {
  return { type: "custom_message", ...message };
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

export function iterationHeadline(d: IterationMarkerDetails): string {
  const roles = d.roles.length > 0 ? ` · role ${d.roles.join(", ")}` : "";
  return `autoloop ${d.runId} · iteration ${d.iteration}/${d.maxIterations}${roles} · after ${d.recentEvent}`;
}

export function endHeadline(d: EndMarkerDetails): string {
  return `autoloop ${d.runId} · ${d.stopReason} · ${d.iterations} iteration(s) · ${formatCost(d.costUsd)}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

export function renderIteration(
  message: { content: unknown; details?: IterationMarkerDetails },
  expanded: boolean,
  outputPad: number,
  theme: Theme,
): Box {
  const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
  const d = message.details;
  const headline = d ? iterationHeadline(d) : "autoloop iteration";
  const hint = expanded ? "" : theme.fg("dim", " (expand to read the prompt)");
  box.addChild(new Text(theme.fg("accent", `⟳ ${headline}`) + hint, 0, 0));
  if (expanded) box.addChild(new Text(theme.fg("muted", contentText(message.content)), 0, 1));
  return box;
}

export function renderEnd(
  message: { content: unknown; details?: EndMarkerDetails },
  outputPad: number,
  theme: Theme,
): Box {
  const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
  const d = message.details;
  if (!d) {
    box.addChild(new Text(contentText(message.content), 0, 0));
    return box;
  }
  const ok = SUCCESS_REASONS.has(d.stopReason);
  const line = theme.fg(ok ? "success" : "warning", `${ok ? "✓" : "■"} ${endHeadline(d)}`);
  box.addChild(new Text(d.error ? `${line}\n${theme.fg("error", d.error)}` : line, 0, 0));
  return box;
}

export function registerMarkerRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<IterationMarkerDetails>(ITERATION_MARKER, (message, { expanded, outputPad }, theme) =>
    renderIteration(message, expanded, outputPad, theme),
  );
  pi.registerMessageRenderer<EndMarkerDetails>(END_MARKER, (message, { outputPad }, theme) =>
    renderEnd(message, outputPad, theme),
  );
}
