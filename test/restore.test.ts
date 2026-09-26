import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { closeOrphanedRuns, orphanedRuns } from "../restore.ts";
import { endMarker, iterationMarker, type MarkerMessage } from "../markers.ts";
import { fakeTurn } from "./fakes.ts";

let seq = 0;
const entry = (message: MarkerMessage<unknown>): SessionEntry =>
  ({ type: "custom_message", id: `e${seq++}`, parentId: null, timestamp: "", ...message }) as SessionEntry;
const iter = (runId: string, iteration: number) => entry(iterationMarker(fakeTurn({ runId, iteration })));
const end = (runId: string) => entry(endMarker({ runId, stopReason: "completion_event", iterations: 1, costUsd: 0 }));
const chat = { type: "message", id: "m", parentId: null, timestamp: "", message: { role: "user", content: "hi" } } as unknown as SessionEntry;

describe("orphanedRuns", () => {
  it.each<[string, SessionEntry[], string[]]>([
    ["no loops", [chat], []],
    ["closed run", [iter("a", 1), iter("a", 2), end("a")], []],
    ["open run", [chat, iter("a", 1), iter("a", 2), chat], ["a"]],
    ["resumed after end and left open", [iter("a", 1), end("a"), iter("a", 2)], ["a"]],
    ["one closed, one open", [iter("a", 1), end("a"), iter("b", 1)], ["b"]],
  ])("%s", (_name, branch, expected) => {
    expect(orphanedRuns(branch).map((r) => r.runId)).toEqual(expected);
  });

  it("reports the latest iteration of an orphan", () => {
    expect(orphanedRuns([iter("a", 1), iter("a", 3)])[0]).toMatchObject({ runId: "a", iteration: 3 });
  });
});

describe("closeOrphanedRuns", () => {
  it("appends an interrupted end marker per orphan and returns their ids", () => {
    const sent: MarkerMessage<unknown>[] = [];
    expect(closeOrphanedRuns([iter("a", 2), chat], (m) => sent.push(m))).toEqual(["a"]);
    expect(sent).toEqual([endMarker({ runId: "a", stopReason: "interrupted", iterations: 2, costUsd: 0 })]);
  });

  it("is idempotent once the end marker is on the branch", () => {
    const sent: MarkerMessage<unknown>[] = [];
    const branch = [iter("a", 2)];
    closeOrphanedRuns(branch, (m) => sent.push(m));
    expect(closeOrphanedRuns([...branch, entry(sent[0])], (m) => sent.push(m))).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});
