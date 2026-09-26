import { describe, expect, it } from "vitest";
import { createEmitTool, EMIT_TOOL_NAME } from "../emit-tool.ts";
import type { HostTurn } from "../host-types.ts";
import { fakeTurn } from "./fakes.ts";

const call = (turn: HostTurn | null, topic = "tasks.ready", payload = "3 tasks queued") =>
  createEmitTool(() => turn).execute("call-1", { topic, payload }, undefined, undefined, {} as never);

describe("autoloop_emit", () => {
  it("is named for the harness prompt hint", () => {
    expect(createEmitTool(() => null).name).toBe(EMIT_TOOL_NAME);
  });

  it("forwards an accepted event to the armed turn", async () => {
    const emitted: Array<[string, string]> = [];
    const turn = fakeTurn({ emit: (t, p) => (emitted.push([t, p]), { ok: true, topic: t }) });
    const result = await call(turn);
    expect(emitted).toEqual([["tasks.ready", "3 tasks queued"]]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("accepted tasks.ready") });
    expect(result.details).toEqual({ topic: "tasks.ready", runId: "run-1", iteration: 1 });
  });

  it("reports the topic the harness journaled when hooks rewrite it", async () => {
    const result = await call(fakeTurn({ emit: () => ({ ok: true, topic: "review.ready" }) }));
    expect(result.details).toMatchObject({ topic: "review.ready" });
    const plain = await call(fakeTurn({ emit: () => ({ ok: true }) }));
    expect(plain.details).toMatchObject({ topic: "tasks.ready" });
  });

  it("fails with the harness reason and the allowed events when rejected", async () => {
    const turn = fakeTurn({
      allowedEvents: ["task.complete", "review.failed"],
      emit: () => ({ ok: false, error: "tasks.ready not allowed after review.passed" }),
    });
    await expect(call(turn)).rejects.toThrow(
      "tasks.ready not allowed after review.passed. Allowed events: task.complete, review.failed",
    );
  });

  it("fails with a generic reason when the harness gives none", async () => {
    await expect(call(fakeTurn({ allowedEvents: [], emit: () => ({ ok: false }) }))).rejects.toThrow(
      "tasks.ready was rejected. Allowed events: (none)",
    );
  });

  it("fails when no iteration is active", async () => {
    await expect(call(null)).rejects.toThrow("No autoloop iteration is active.");
  });
});
