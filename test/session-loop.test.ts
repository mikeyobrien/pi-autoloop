import { beforeEach, describe, expect, it } from "vitest";
import { asDraft, endMarker, iterationMarker } from "../markers.ts";
import { CONTINUE_PROMPT, SessionLoop } from "../session-loop.ts";
import { assistant, assistantError, beforeSettle, FakeHarness, FakePi, fakeTurn, flush, markerMessage, user } from "./fakes.ts";

const REQUEST = { preset: "autocode", objective: "Add rate limiting", cwd: "/repo" };

let pi: FakePi;
let harness: FakeHarness;
let loop: SessionLoop;

beforeEach(() => {
  pi = new FakePi();
  harness = new FakeHarness();
  loop = new SessionLoop(pi, harness);
});

/** Starts a loop and delivers turn 1's marker, as pi does after sendMessage. */
function startFirstTurn(turn = fakeTurn()) {
  loop.start(REQUEST);
  const result = harness.turn(turn);
  const marker = markerMessage(iterationMarker(turn));
  loop.onMessageEnd(marker);
  return { turn, result, marker };
}

describe("starting", () => {
  it("hands the request to the harness and sends the first marker as a triggering follow-up", () => {
    const turn = fakeTurn();
    loop.start(REQUEST);
    expect(harness.started).toEqual([{ kind: "run", request: REQUEST }]);
    expect(pi.lastView()).toMatchObject({ phase: "deciding", runId: null, preset: "autocode", iteration: 0 });

    void harness.turn(turn);
    expect(pi.sent).toEqual([{ message: iterationMarker(turn), options: { triggerTurn: true, deliverAs: "followUp" } }]);
    expect(pi.lastView()).toEqual({
      phase: "working",
      runId: "run-1",
      preset: "autocode",
      iteration: 1,
      maxIterations: 5,
      roles: ["builder"],
      costUsd: 0,
    });
  });

  it("refuses a second loop while one is live", () => {
    loop.start(REQUEST);
    expect(() => loop.start(REQUEST)).toThrow(/already live/);
    expect(() => loop.resume("x", "/repo")).toThrow(/already live/);
  });

  it("resumes a run by id", () => {
    loop.resume("run-9", "/repo");
    expect(harness.started).toEqual([{ kind: "resume", runId: "run-9", cwd: "/repo" }]);
    expect(loop.guide("keep going")).toBe(true);
    expect(harness.guidance).toEqual([{ runId: "run-9", cwd: "/repo", text: "keep going" }]);
  });
});

describe("iteration boundary", () => {
  it("settle → next: resolves the turn and drafts the next marker with continue", async () => {
    const { result, marker } = startFirstTurn();
    loop.onMessageEnd(assistant("working on it", 0.02));
    loop.onMessageEnd(assistant("done", 0.03));
    const existing = { type: "custom" as const, customType: "other" };
    const settle = loop.onBeforeSettle(beforeSettle([marker, assistant("done")], "completed", [existing]));

    expect(await result).toEqual({
      status: "completed",
      output: "done",
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 2, costUsd: 0.05 },
    });
    expect(pi.lastView()?.phase).toBe("deciding");

    const turn2 = fakeTurn({ iteration: 2, recentEvent: "tasks.ready" });
    void harness.turn(turn2);
    expect(await settle).toEqual({ entries: [existing, asDraft(iterationMarker(turn2))], continue: true });
    expect(pi.sent).toHaveLength(1);
    expect(loop.activeTurn()).toBe(turn2);
    expect(pi.lastView()).toMatchObject({ phase: "working", iteration: 2, costUsd: 0.05 });
  });

  it("settle → end: drafts the end marker without continuing and goes idle", async () => {
    const { result, marker } = startFirstTurn();
    loop.onMessageEnd(assistant("all done", 0.25));
    const settle = loop.onBeforeSettle(beforeSettle([marker]));
    await result;
    await harness.end({ runId: "run-1", iterations: 1, stopReason: "completion_event" });

    const end = endMarker({ runId: "run-1", stopReason: "completion_event", iterations: 1, costUsd: 0.25 });
    expect(await settle).toEqual({ entries: [asDraft(end)], continue: false });
    expect(loop.isLive()).toBe(false);
    expect(pi.lastView()).toBeNull();
    expect(pi.sent).toHaveLength(1);
  });

  it("ignores before_settle when the armed marker is not in context", async () => {
    const turn = fakeTurn();
    loop.start(REQUEST);
    void harness.turn(turn);
    const otherRun = markerMessage(iterationMarker(fakeTurn({ runId: "other" })));
    expect(await loop.onBeforeSettle(beforeSettle([user("pre-loop chat"), otherRun]))).toBeUndefined();
    expect(pi.lastView()?.phase).toBe("working");
  });

  it("ignores before_settle when no loop is live", async () => {
    expect(await loop.onBeforeSettle(beforeSettle([user("hi")]))).toBeUndefined();
  });

  it("reports an error outcome as an error turn", async () => {
    const { result, marker } = startFirstTurn();
    void loop.onBeforeSettle(beforeSettle([marker], "error"));
    expect(await result).toMatchObject({ status: "error" });
  });

  it("leaves an aborted outcome to agent_settled", async () => {
    const { marker } = startFirstTurn();
    expect(await loop.onBeforeSettle(beforeSettle([marker], "aborted"))).toBeUndefined();
    expect(pi.lastView()?.phase).toBe("working");
  });
});

describe("usage and output", () => {
  it("counts only messages after the marker is delivered", async () => {
    const turn = fakeTurn();
    loop.start(REQUEST);
    const result = harness.turn(turn);
    loop.onMessageEnd(assistant("pre-loop reply", 1));
    loop.onMessageEnd(markerMessage(iterationMarker(turn)));
    loop.onMessageEnd(user("steer: use the limiter"));
    loop.onMessageEnd(assistant("iteration reply", 0.1));
    loop.onMessageEnd(assistant("   ", 0.1));
    void loop.onBeforeSettle(beforeSettle([markerMessage(iterationMarker(turn))]));
    expect(await result).toMatchObject({ output: "iteration reply", usage: { costUsd: 0.2, inputTokens: 200 } });
  });

  it("ignores message_end when no turn is armed", () => {
    loop.onMessageEnd(assistant("idle chat"));
    expect(pi.views).toEqual([]);
  });
});

describe("pause (Esc)", () => {
  it("Esc → paused; a user-driven run later settles the same iteration", async () => {
    const { result, marker } = startFirstTurn();
    loop.onSettled();
    expect(pi.lastView()?.phase).toBe("paused");

    loop.onAgentStart();
    expect(pi.lastView()?.phase).toBe("working");
    loop.onMessageEnd(user("try the other approach"));
    loop.onMessageEnd(assistant("switched approach"));
    void loop.onBeforeSettle(beforeSettle([marker, user("try the other approach"), assistant("switched approach")]));
    expect(await result).toMatchObject({ status: "completed", output: "switched approach" });
  });

  it("does not pause before the first marker is delivered", () => {
    loop.start(REQUEST);
    void harness.turn(fakeTurn());
    pi.pending = true;
    loop.onSettled();
    expect(pi.lastView()?.phase).toBe("working");
  });

  it("Esc while deciding: the drafted marker commits and the new iteration pauses", async () => {
    const { result, marker } = startFirstTurn();
    const settle = loop.onBeforeSettle(beforeSettle([marker]));
    await result;
    const turn2 = fakeTurn({ iteration: 2 });
    void harness.turn(turn2);
    expect(await settle).toMatchObject({ continue: true });
    loop.onSettled();
    expect(pi.lastView()).toMatchObject({ phase: "paused", iteration: 2 });
    expect(loop.activeTurn()).toBe(turn2);
  });

  it("/loop:continue only acts while paused", () => {
    expect(loop.continue()).toBe(false);
    startFirstTurn();
    expect(loop.continue()).toBe(false);
    loop.onSettled();
    expect(loop.continue()).toBe(true);
    expect(pi.userMessages).toEqual([CONTINUE_PROMPT]);
  });

  it("agent_start outside a pause changes nothing", () => {
    loop.onAgentStart();
    startFirstTurn();
    const before = pi.views.length;
    loop.onAgentStart();
    expect(pi.views).toHaveLength(before);
  });
});

describe("stop", () => {
  it("returns false when idle", () => {
    expect(loop.stop()).toBe(false);
  });

  it("while working: aborts the agent and the run, interrupts the turn, then posts the end marker", async () => {
    const { result } = startFirstTurn();
    loop.onMessageEnd(assistant("partial"));
    expect(loop.stop()).toBe(true);
    expect(pi.aborts).toBe(1);
    expect(harness.signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ status: "interrupted", output: "partial" });

    loop.onSettled();
    expect(pi.lastView()?.phase).toBe("deciding");
    await harness.end({ runId: "run-1", iterations: 1, stopReason: "interrupted" });
    expect(pi.sent.at(-1)).toEqual({
      message: endMarker({ runId: "run-1", stopReason: "interrupted", iterations: 1, costUsd: 0.01 }),
    });
    expect(loop.isLive()).toBe(false);
  });

  it("while paused: interrupts without aborting the idle agent", async () => {
    const { result } = startFirstTurn();
    loop.onSettled();
    loop.stop();
    expect(pi.aborts).toBe(0);
    expect(await result).toMatchObject({ status: "interrupted" });
  });

  it("while deciding at a boundary: the parked handler drafts the end marker", async () => {
    const { result, marker } = startFirstTurn();
    const settle = loop.onBeforeSettle(beforeSettle([marker]));
    await result;
    loop.stop();
    expect(harness.signal?.aborted).toBe(true);
    await harness.end({ runId: "run-1", iterations: 1, stopReason: "interrupted" });
    expect(await settle).toMatchObject({ continue: false, entries: [{ customType: "autoloop-end" }] });
  });

  it("before the first turn: the end marker is sent directly", async () => {
    loop.start(REQUEST);
    loop.stop();
    await harness.end({ iterations: 0, stopReason: "interrupted" });
    expect(pi.sent).toEqual([{ message: endMarker({ runId: "", stopReason: "interrupted", iterations: 0, costUsd: 0 }) }]);
  });
});

describe("harness-driven interruption and failure", () => {
  it("a per-iteration deadline interrupts the turn and the next turn is sent fresh", async () => {
    const deadline = new AbortController();
    const { result } = startFirstTurn(fakeTurn({ signal: deadline.signal }));
    deadline.abort();
    expect(await result).toMatchObject({ status: "interrupted" });
    expect(pi.aborts).toBe(1);

    const turn2 = fakeTurn({ iteration: 2 });
    void harness.turn(turn2);
    expect(pi.sent.at(-1)).toEqual({
      message: iterationMarker(turn2),
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
  });

  it("a turn requested with an aborted signal is interrupted immediately", async () => {
    loop.start(REQUEST);
    const aborted = new AbortController();
    aborted.abort();
    expect(await harness.turn(fakeTurn({ signal: aborted.signal }))).toEqual({ status: "interrupted", output: "" });
    expect(pi.sent).toEqual([]);
  });

  it("an overlapping turn request is an invariant violation", () => {
    startFirstTurn();
    expect(() => harness.turn(fakeTurn({ iteration: 2 }))).toThrow(/while the session loop is working/);
  });

  it("a harness crash ends the loop with an error marker", async () => {
    startFirstTurn();
    await harness.crash(new Error("preset not found"));
    expect(pi.aborts).toBe(1);
    expect(pi.sent.at(-1)?.message.details).toEqual({
      runId: "run-1",
      stopReason: "error",
      iterations: 1,
      costUsd: 0,
      error: "preset not found",
    });
    expect(loop.isLive()).toBe(false);
  });

  it("a non-Error rejection before any turn still ends the loop", async () => {
    loop.start(REQUEST);
    await harness.crash("bad");
    expect(pi.sent.at(-1)?.message.details).toMatchObject({ runId: "", iterations: 0, error: "bad" });
  });
});

describe("guide", () => {
  it("needs a live loop with a known run id", () => {
    expect(loop.guide("x")).toBe(false);
    loop.start(REQUEST);
    expect(loop.guide("x")).toBe(false);
    void harness.turn(fakeTurn());
    expect(loop.guide("prefer lib/limits.ts")).toBe(true);
    expect(harness.guidance).toEqual([{ runId: "run-1", cwd: "/repo", text: "prefer lib/limits.ts" }]);
  });
});

describe("marker dropped by Esc before delivery", () => {
  const followUp = { triggerTurn: true, deliverAs: "followUp" };

  it("re-sends the marker once pi settles without having delivered it", () => {
    const turn = fakeTurn();
    loop.start(REQUEST);
    void harness.turn(turn);
    loop.onSettled();
    expect(pi.sent).toEqual([
      { message: iterationMarker(turn), options: followUp },
      { message: iterationMarker(turn), options: followUp },
    ]);
    expect(pi.lastView()?.phase).toBe("working");
  });

  it("does not re-send while pi still holds the marker in its queue", () => {
    loop.start(REQUEST);
    void harness.turn(fakeTurn());
    pi.pending = true;
    loop.onSettled();
    expect(pi.sent).toHaveLength(1);
  });

  it("does not re-send a delivered marker; it pauses instead", () => {
    startFirstTurn();
    loop.onSettled();
    expect(pi.sent).toHaveLength(1);
    expect(pi.lastView()?.phase).toBe("paused");
  });

  it("a stop before the settle wins over the re-send", async () => {
    loop.start(REQUEST);
    const result = harness.turn(fakeTurn());
    loop.stop();
    loop.onSettled();
    expect(await result).toMatchObject({ status: "interrupted" });
    expect(pi.sent).toHaveLength(1);
  });

  it("never re-sends a drafted marker", async () => {
    const { result, marker } = startFirstTurn();
    void loop.onBeforeSettle(beforeSettle([marker]));
    await result;
    void harness.turn(fakeTurn({ iteration: 2 }));
    loop.onSettled();
    expect(pi.sent).toHaveLength(1);
  });
});

describe("assistant errors", () => {
  it("reports the provider error text instead of an earlier reply", async () => {
    const { result, marker } = startFirstTurn();
    loop.onMessageEnd(assistant("progress so far"));
    loop.onMessageEnd(assistantError("", "429 Too Many Requests"));
    void loop.onBeforeSettle(beforeSettle([marker], "error"));
    expect(await result).toMatchObject({ status: "error", output: "429 Too Many Requests" });
  });

  it("keeps partial text from the failing response alongside the error", async () => {
    const { result, marker } = startFirstTurn();
    loop.onMessageEnd(assistantError("halfway", "overloaded_error"));
    void loop.onBeforeSettle(beforeSettle([marker], "error"));
    expect(await result).toMatchObject({ output: "halfway\noverloaded_error" });
  });

  it("marks an error without a message", async () => {
    const { result, marker } = startFirstTurn();
    loop.onMessageEnd(assistant("earlier"));
    loop.onMessageEnd(assistantError(" ", undefined));
    void loop.onBeforeSettle(beforeSettle([marker], "error"));
    expect(await result).toMatchObject({ output: "assistant error" });
  });
});

