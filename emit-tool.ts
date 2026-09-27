import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HostTurn } from "./host-types.ts";

export const EMIT_TOOL_NAME = "autoloop_emit";

/** Reports this iteration's routing event to the autoloop harness. Registered once; activated while a loop is live. */
export function createEmitTool(activeTurn: () => HostTurn | null) {
  return defineTool({
    name: EMIT_TOOL_NAME,
    label: "Autoloop emit",
    description:
      "Emit the routing event for the current autoloop iteration. The topic must be one of the iteration's allowed events; the payload summarises the work for the next role.",
    promptSnippet: "Emit the current autoloop iteration's routing event",
    parameters: Type.Object({
      topic: Type.String({ description: "Event topic, e.g. tasks.ready or task.complete" }),
      payload: Type.String({ description: "Summary handed to the next iteration" }),
    }),
    async execute(_toolCallId, params) {
      const turn = activeTurn();
      if (!turn) throw new Error("No autoloop iteration is active.");
      const result = turn.emit(params.topic, params.payload);
      if (!result.ok) {
        const reason = result.error ?? `${params.topic} was rejected`;
        throw new Error(`${reason}. Allowed events: ${turn.allowedEvents.join(", ") || "(none)"}`);
      }
      const topic = result.topic ?? params.topic;
      return {
        content: [{ type: "text", text: `accepted ${topic}. End your reply when the iteration's work is done.` }],
        details: { topic, runId: turn.runId, iteration: turn.iteration },
      };
    },
  });
}
