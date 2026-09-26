import type { AgentBeforeSettleEvent } from "@earendil-works/pi-coding-agent";
import type { EmitResult, HostTurn, HostTurnResult, HostWorker } from "../host-types.ts";
import type { MarkerMessage } from "../markers.ts";
import type { AgentMessage, HarnessPort, LoopView, PiPort, RunOutcome, StartRequest } from "../session-loop.ts";

export function fakeTurn(over: Partial<Omit<HostTurn, "emit">> & { emit?: HostTurn["emit"] } = {}): HostTurn {
  return {
    runId: "run-1",
    iteration: 1,
    maxIterations: 5,
    preset: "autocode",
    roles: [{ id: "builder", prompt: "You build." }],
    recentEvent: "loop.start",
    allowedEvents: ["tasks.ready"],
    prompt: "Iteration prompt",
    emit: (topic): EmitResult => ({ ok: true, topic }),
    signal: new AbortController().signal,
    ...over,
  };
}

export class FakePi implements PiPort {
  sent: Array<{ message: MarkerMessage<unknown>; options?: object }> = [];
  userMessages: string[] = [];
  aborts = 0;
  pending = false;
  views: Array<LoopView | null> = [];

  sendMessage(message: MarkerMessage<unknown>, options?: object): void {
    this.sent.push(options ? { message, options } : { message });
  }
  sendUserMessage(text: string): void {
    this.userMessages.push(text);
  }
  abortAgent(): void {
    this.aborts++;
  }
  hasPendingMessages(): boolean {
    return this.pending;
  }
  update(view: LoopView | null): void {
    this.views.push(view);
  }
  lastView(): LoopView | null | undefined {
    return this.views.at(-1);
  }
}

/** A scripted harness: the test decides when turns happen and when the run ends. */
export class FakeHarness implements HarnessPort {
  host: HostWorker | null = null;
  signal: AbortSignal | null = null;
  started: Array<{ kind: "run"; request: StartRequest } | { kind: "resume"; runId: string; cwd: string }> = [];
  guidance: Array<{ runId: string; cwd: string; text: string }> = [];
  private settle: { resolve(o: RunOutcome): void; reject(e: unknown): void } | null = null;

  run(request: StartRequest, host: HostWorker, signal: AbortSignal): Promise<RunOutcome> {
    this.started.push({ kind: "run", request });
    return this.attach(host, signal);
  }
  resume(runId: string, cwd: string, host: HostWorker, signal: AbortSignal): Promise<RunOutcome> {
    this.started.push({ kind: "resume", runId, cwd });
    return this.attach(host, signal);
  }
  guide(runId: string, cwd: string, text: string): void {
    this.guidance.push({ runId, cwd, text });
  }

  turn(turn: HostTurn): Promise<HostTurnResult> {
    if (!this.host) throw new Error("harness not started");
    return this.host.runTurn(turn);
  }
  /** Resolves the run and lets the loop's finish handler run. */
  async end(outcome: RunOutcome): Promise<void> {
    this.settle?.resolve(outcome);
    await flush();
  }
  async crash(error: unknown): Promise<void> {
    this.settle?.reject(error);
    await flush();
  }

  private attach(host: HostWorker, signal: AbortSignal): Promise<RunOutcome> {
    this.host = host;
    this.signal = signal;
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

export function markerMessage(message: MarkerMessage<unknown>): AgentMessage {
  return { role: "custom", ...message, timestamp: 0 } as AgentMessage;
}

export function assistantError(text: string, errorMessage: string | undefined): AgentMessage {
  return { ...assistant(text), stopReason: "error", ...(errorMessage ? { errorMessage } : {}) } as AgentMessage;
}

export function assistant(text: string, cost = 0.01): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 100,
      output: 10,
      cacheRead: 5,
      cacheWrite: 1,
      totalTokens: 116,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
}

export function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

export function beforeSettle(
  contextMessages: AgentMessage[],
  outcome: AgentBeforeSettleEvent["outcome"] = "completed",
  entries: AgentBeforeSettleEvent["entries"] = [],
): AgentBeforeSettleEvent {
  return {
    type: "agent_before_settle",
    outcome,
    entries,
    continue: false,
    context: { contextEntries: [], contextMessages, llmMessages: [], pendingMessages: [], canContinue: true },
  };
}
