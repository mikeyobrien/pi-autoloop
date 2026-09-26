import { describe, expect, it } from "vitest";
import {
  END_MARKER,
  ITERATION_MARKER,
  isIterationMarkerFor,
  projectLoopContext,
  readMarker,
  type MessageLike,
} from "../context-floor.ts";

type Msg = MessageLike & { id: string; customType?: string; details?: unknown };

const user = (id: string): Msg => ({ role: "user", id });
const iter = (runId: string, iteration: number): Msg => ({
  role: "custom",
  id: `${runId}#${iteration}`,
  customType: ITERATION_MARKER,
  details: { runId, iteration, maxIterations: 10, preset: "p", roles: [], recentEvent: "loop.start" },
});
const end = (runId: string, tag = ""): Msg => ({
  role: "custom",
  id: `${runId}!end${tag}`,
  customType: END_MARKER,
  details: { runId, stopReason: "completed", iterations: 1, costUsd: 0 },
});

const ids = (messages: Msg[]) => projectLoopContext(messages).map((m) => m.id);

describe("projectLoopContext", () => {
  it.each<[string, Msg[], string[]]>([
    ["no loop keeps everything", [user("a"), user("b")], ["a", "b"]],
    ["empty transcript", [], []],
    ["open run floors at its latest marker", [user("pre"), iter("r", 1), user("w1"), iter("r", 2), user("w2")], ["r#2", "w2"]],
    ["open run with only its first marker", [user("pre"), iter("r", 1), user("w1")], ["r#1", "w1"]],
    [
      "closed run collapses to its end marker",
      [user("pre"), iter("r", 1), user("w1"), iter("r", 2), end("r"), user("post")],
      ["pre", "r!end", "post"],
    ],
    [
      "multiple closed runs each collapse",
      [user("a"), iter("r", 1), end("r"), user("b"), iter("s", 1), user("w"), end("s"), user("c")],
      ["a", "r!end", "b", "s!end", "c"],
    ],
    [
      "resumed run reopens after its end and floors at the new marker",
      [user("a"), iter("r", 1), end("r", "1"), user("b"), iter("r", 2), user("w")],
      ["r#2", "w"],
    ],
    [
      "resumed run that closes again collapses both segments",
      [user("a"), iter("r", 1), end("r", "1"), user("b"), iter("r", 2), end("r", "2"), user("c")],
      ["a", "r!end1", "b", "r!end2", "c"],
    ],
    [
      "closed run nested inside an open segment is collapsed",
      [user("a"), iter("r", 1), user("w"), iter("s", 1), user("x"), end("s")],
      ["r#1", "w", "s!end"],
    ],
    [
      "interleaved runs: open run keeps floor, closed run collapses",
      [user("a"), iter("r", 1), iter("s", 1), user("x"), end("s"), iter("r", 2), user("w")],
      ["r#2", "w"],
    ],
    ["end marker without a run start is kept", [user("a"), end("r"), user("b")], ["a", "r!end", "b"]],
  ])("%s", (_name, messages, expected) => {
    expect(ids(messages)).toEqual(expected);
  });

  it("is idempotent", () => {
    const fixtures: Msg[][] = [
      [user("y"), iter("a", 1), user("x"), iter("b", 1), end("b")],
      [user("a"), iter("r", 1), end("r"), iter("r", 2), user("w")],
      [user("a"), iter("r", 1), user("w"), iter("r", 2), end("r"), user("post")],
    ];
    for (const messages of fixtures) {
      const once = projectLoopContext(messages);
      expect(projectLoopContext(once)).toEqual(once);
    }
  });

  it("ignores custom messages with malformed details", () => {
    const bogus: Msg[] = [
      { role: "custom", id: "no-details", customType: ITERATION_MARKER },
      { role: "custom", id: "no-run", customType: ITERATION_MARKER, details: { iteration: 1 } },
      { role: "custom", id: "no-iter", customType: ITERATION_MARKER, details: { runId: "r" } },
      { role: "custom", id: "other", customType: "note", details: { runId: "r", iteration: 1 } },
      user("u"),
    ];
    expect(ids(bogus)).toEqual(["no-details", "no-run", "no-iter", "other", "u"]);
  });
});

describe("marker readers", () => {
  it("reads iteration and end markers", () => {
    expect(readMarker(iter("r", 3))).toMatchObject({ kind: "iteration", details: { runId: "r", iteration: 3 } });
    expect(readMarker(end("r"))).toMatchObject({ kind: "end", details: { runId: "r" } });
    expect(readMarker(user("u"))).toBeNull();
  });

  it("matches a marker by run and iteration", () => {
    expect(isIterationMarkerFor(iter("r", 2), "r", 2)).toBe(true);
    expect(isIterationMarkerFor(iter("r", 2), "r", 3)).toBe(false);
    expect(isIterationMarkerFor(iter("r", 2), "s", 2)).toBe(false);
    expect(isIterationMarkerFor(end("r"), "r", 2)).toBe(false);
  });
});
