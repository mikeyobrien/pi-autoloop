import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { autoloopExtension } from "../index.ts";
import { startNotice, TREE_BLOCKED } from "../session-loop.ts";
import { FakeHarness, fakeTurn } from "./fakes.ts";

type Handler = (...args: any[]) => any;

/** Records handlers and commands; every other ExtensionAPI call is a no-op. */
function fakeExtensionApi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const tools = new Map<string, { execute: Handler }>();
  const api = new Proxy(
    {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
      registerTool: (tool: { name: string; execute: Handler }) => tools.set(tool.name, tool),
      getActiveTools: () => [],
    } as Record<string, unknown>,
    { get: (target, key: string) => target[key] ?? (() => undefined) },
  ) as unknown as ExtensionAPI;
  return { api, handlers, commands, tools };
}

function fakeCtx() {
  const notices: Array<{ text: string; level: string }> = [];
  return {
    notices,
    cwd: "/repo",
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
    hasPendingMessages: () => false,
  };
}

let harness: FakeHarness;
let wiring: ReturnType<typeof fakeExtensionApi>;

beforeEach(() => {
  harness = new FakeHarness();
  wiring = fakeExtensionApi();
  autoloopExtension(harness)(wiring.api);
});

describe("in-session wiring", () => {
  it("/loop:run starts the loop and discloses that metareview is off", async () => {
    const ctx = fakeCtx();
    await wiring.commands.get("loop:run")!("autocode add rate limiting", ctx);
    expect(harness.started).toEqual([{ kind: "run", request: { preset: "autocode", objective: "add rate limiting", cwd: "/repo" } }]);
    expect(ctx.notices).toEqual([{ text: startNotice("autocode"), level: "info" }]);
  });

  it("the autoloop tool's start notice discloses that metareview is off", async () => {
    const result = await wiring.tools.get("autoloop")!.execute("id", { action: "run", preset: "autocode", prompt: "x" }, undefined, undefined, fakeCtx());
    expect(result.content[0].text).toContain("Metareview is disabled for in-session runs");
  });

  it("cancels tree navigation while a loop is live", async () => {
    const tree = wiring.handlers.get("session_before_tree")!;
    const ctx = fakeCtx();
    expect(tree({ type: "session_before_tree" }, ctx)).toBeUndefined();

    await wiring.commands.get("loop:run")!("autocode x", ctx);
    ctx.notices.length = 0;
    expect(tree({ type: "session_before_tree" }, ctx)).toEqual({ cancel: true });
    expect(ctx.notices).toEqual([{ text: TREE_BLOCKED, level: "warning" }]);
  });

  it("/loop:guide before the run id is queued and flushed on the first turn", async () => {
    const ctx = fakeCtx();
    await wiring.commands.get("loop:guide")!("prefer redis", ctx);
    expect(ctx.notices).toEqual([{ text: "No live autoloop in this session", level: "warning" }]);

    await wiring.commands.get("loop:run")!("autocode x", ctx);
    ctx.notices.length = 0;
    await wiring.commands.get("loop:guide")!("prefer redis", ctx);
    expect(ctx.notices).toEqual([{ text: "Guidance queued for the next iteration", level: "info" }]);
    void harness.turn(fakeTurn());
    expect(harness.guidance).toEqual([{ runId: "run-1", cwd: "/repo", text: "prefer redis" }]);
  });

  it("re-sends a marker dropped by an abort through the session's pending-message check", async () => {
    const sent: unknown[] = [];
    (wiring.api as unknown as Record<string, unknown>).sendMessage = (m: unknown) => sent.push(m);
    const ctx = fakeCtx();
    await wiring.commands.get("loop:run")!("autocode x", ctx);
    void harness.turn(fakeTurn());
    wiring.handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
    expect(sent).toHaveLength(2);
  });
});
