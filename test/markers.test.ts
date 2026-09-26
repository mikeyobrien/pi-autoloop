import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { END_MARKER, ITERATION_MARKER, readMarker } from "../context-floor.ts";
import { asDraft, endMarker, iterationMarker, registerMarkerRenderers, renderEnd, renderIteration } from "../markers.ts";
import { fakeTurn } from "./fakes.ts";

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as unknown as Theme;
const text = (lines: string[]) => lines.join("\n");

describe("iteration marker", () => {
  const marker = iterationMarker(fakeTurn({ iteration: 2, prompt: "ROLE PROMPT\nDo the thing" }));

  it("carries the harness prompt verbatim and routing details", () => {
    expect(marker.content).toBe("ROLE PROMPT\nDo the thing");
    expect(readMarker({ role: "custom", ...marker })).toEqual({ kind: "iteration", details: marker.details });
    expect(marker.details).toMatchObject({ runId: "run-1", iteration: 2, roles: ["builder"] });
  });

  it("renders collapsed as a headline and expanded with the prompt", () => {
    const collapsed = text(renderIteration(marker, false, 0, theme).render(120));
    expect(collapsed).toContain("autoloop run-1 · iteration 2/5 · role builder · after loop.start");
    expect(collapsed).not.toContain("Do the thing");
    const expanded = text(renderIteration(marker, true, 0, theme).render(120));
    expect(expanded).toContain("Do the thing");
  });

  it("renders without details and with array content", () => {
    const out = text(renderIteration({ content: [{ type: "text", text: "hi" }] }, true, 0, theme).render(80));
    expect(out).toContain("autoloop iteration");
    expect(out).toContain("hi");
    expect(text(renderIteration({ content: 42 }, true, 0, theme).render(80))).toContain("autoloop iteration");
  });
});

describe("end marker", () => {
  it("summarises the run for the model", () => {
    const m = endMarker({ runId: "r", stopReason: "completion_event", iterations: 3, costUsd: 0.5 });
    expect(m.content).toBe("Autoloop run r ended (completion_event) after 3 iteration(s), cost $0.50.");
    expect(text(renderEnd(m, 0, theme).render(120))).toContain("✓ autoloop r · completion_event · 3 iteration(s) · $0.50");
  });

  it("marks failures and shows the error", () => {
    const m = endMarker({ runId: "r", stopReason: "error", iterations: 0, costUsd: 0, error: "boom" });
    expect(m.content).toContain("Error: boom");
    const out = text(renderEnd(m, 0, theme).render(120));
    expect(out).toContain("■ autoloop r · error");
    expect(out).toContain("boom");
  });

  it("falls back to content without details", () => {
    expect(text(renderEnd({ content: "plain" }, 0, theme).render(80))).toContain("plain");
  });

  it("becomes a custom_message draft", () => {
    const m = endMarker({ runId: "r", stopReason: "stalled", iterations: 1, costUsd: 0 });
    expect(asDraft(m)).toEqual({ type: "custom_message", ...m });
  });
});

describe("registerMarkerRenderers", () => {
  it("registers both marker types", () => {
    const renderers = new Map<string, (...args: unknown[]) => { render(w: number): string[] }>();
    registerMarkerRenderers({
      registerMessageRenderer: (type: string, fn: never) => renderers.set(type, fn),
    } as never);
    const it = iterationMarker(fakeTurn());
    const en = endMarker({ runId: "r", stopReason: "stalled", iterations: 1, costUsd: 0 });
    expect(text(renderers.get(ITERATION_MARKER)!(it, { expanded: false, outputPad: 0 }, theme).render(80))).toContain("⟳");
    expect(text(renderers.get(END_MARKER)!(en, { expanded: false, outputPad: 0 }, theme).render(80))).toContain("stalled");
  });
});
