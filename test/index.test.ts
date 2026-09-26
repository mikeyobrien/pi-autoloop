import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { autoloopExtension } from "../index.ts";
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
