import type { AgentBeforeSettleEvent, BoundaryResult, ContextEvent } from "@earendil-works/pi-coding-agent";
import { isIterationMarkerFor, projectLoopContext, type EndMarkerDetails } from "./context-floor.ts";
import type { HostTurn, HostTurnResult, HostUsage, HostWorker } from "./host-types.ts";
import { asDraft, endMarker, iterationMarker, type MarkerMessage } from "./markers.ts";

export type AgentMessage = ContextEvent["messages"][number];

export interface PiPort {
  sendMessage(message: MarkerMessage<unknown>, options?: { triggerTurn: true; deliverAs: "followUp" }): void;
  sendUserMessage(text: string): void;
  abortAgent(): void;
  /** True while pi still holds queued steering or follow-up messages. */
  hasPendingMessages(): boolean;
  notify(text: string, level: "info" | "warning"): void;
  /** Called after every phase change; drives the dock, status line, and emit tool activation. */
  update(view: LoopView | null): void;
}

export interface StartRequest {
  preset: string;
  objective: string;
  cwd: string;
}

/** The subset of the harness RunSummary the host needs. */
export interface RunOutcome {
  runId?: string;
  iterations: number;
  stopReason: string;
}

export interface HarnessPort {
  run(request: StartRequest, host: HostWorker, signal: AbortSignal): Promise<RunOutcome>;
  resume(runId: string, cwd: string, host: HostWorker, signal: AbortSignal): Promise<RunOutcome>;
  guide(runId: string, cwd: string, text: string): void;
}

export interface LoopView {
  phase: "working" | "paused" | "deciding";
  runId: string | null;
  preset: string;
  iteration: number;
  maxIterations: number;
  roles: string[];
  costUsd: number;
}

interface LiveRun {
  readonly preset: string;
  readonly cwd: string;
  readonly controller: AbortController;
  runId: string | null;
  lastTurn: HostTurn | null;
  costUsd: number;
  /** /loop:guide text given before the harness assigned a run id. */
  pendingGuidance: string[];
}

interface ArmedTurn {
  readonly turn: HostTurn;
  /** The marker reached the model's context; before then, assistant messages belong to pre-loop chat. */
  delivered: boolean;
  /** The marker went out through sendMessage rather than as a before_settle draft. */
  sent: boolean;
  usage: HostUsage;
  output: string;
  readonly settle: (result: HostTurnResult) => void;
}

type Next = { kind: "turn"; turn: HostTurn } | { kind: "end"; end: EndMarkerDetails } | { kind: "released" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export type Phase =
  | { kind: "idle" }
  | { kind: "working"; live: LiveRun; armed: ArmedTurn }
  | { kind: "paused"; live: LiveRun; armed: ArmedTurn }
  /** The harness has the floor. `parked` is a before_settle handler waiting to draft the next marker. */
  | { kind: "deciding"; live: LiveRun; parked: Deferred<Next> | null };

export const CONTINUE_PROMPT = "Continue the iteration.";
export const TREE_BLOCKED = "An autoloop is live in this session; /loop:stop it before navigating the tree.";

export function startNotice(preset: string): string {
  return `Autoloop ${preset} started in this session. Metareview is disabled for in-session runs; use --detached to keep it.`;
}
const EMPTY_USAGE: HostUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

export class SessionLoop implements HostWorker {
  readonly label = "host:pi";
  readonly eventToolHint = "Call the `autoloop_emit` tool with {topic, payload}.";
  private phase: Phase = { kind: "idle" };

  constructor(
    private readonly pi: PiPort,
    private readonly harness: HarnessPort,
  ) {}

  start(request: StartRequest): void {
    const live = this.open(request.preset, request.cwd, null);
    this.drive(live, this.harness.run(request, this, live.controller.signal));
  }

  resume(runId: string, cwd: string): void {
    const live = this.open("", cwd, runId);
    this.drive(live, this.harness.resume(runId, cwd, this, live.controller.signal));
  }

  /** Returns false when no loop is live. */
  stop(): boolean {
    if (this.phase.kind === "idle") return false;
    this.phase.live.controller.abort();
    if (this.phase.kind !== "deciding") this.interrupt(this.phase.armed);
    return true;
  }

  /** Returns false unless the loop is paused. */
  continue(): boolean {
    if (this.phase.kind !== "paused") return false;
    this.pi.sendUserMessage(CONTINUE_PROMPT);
    return true;
  }

  /** Durable guidance for the next iteration prompt; held until the harness assigns a run id. Returns false when idle. */
  guide(text: string): boolean {
    if (this.phase.kind === "idle") return false;
    const { live } = this.phase;
    if (live.runId === null) live.pendingGuidance.push(text);
    else this.harness.guide(live.runId, live.cwd, text);
    return true;
  }

  /** Tree navigation would move the leaf off the live iteration's marker. */
  treeBlocked(): string | null {
    return this.phase.kind === "idle" ? null : TREE_BLOCKED;
  }

  /** Session shutdown: stop the run without writing to the transcript; restore.ts closes the segment later. */
  detach(): void {
    const phase = this.phase;
    if (phase.kind === "idle") return;
    phase.live.controller.abort();
    if (phase.kind === "deciding") phase.parked?.resolve({ kind: "released" });
    else phase.armed.settle({ status: "interrupted", output: phase.armed.output, usage: phase.armed.usage });
    this.setPhase({ kind: "idle" });
  }

  view(): LoopView | null {
    const phase = this.phase;
    if (phase.kind === "idle") return null;
    const turn = phase.kind === "deciding" ? phase.live.lastTurn : phase.armed.turn;
    return {
      phase: phase.kind,
      runId: phase.live.runId,
      preset: turn?.preset ?? phase.live.preset,
      iteration: turn?.iteration ?? 0,
      maxIterations: turn?.maxIterations ?? 0,
      roles: turn?.roles.map((r) => r.id) ?? [],
      costUsd: phase.live.costUsd + (phase.kind === "deciding" ? 0 : phase.armed.usage.costUsd),
    };
  }

  /** The turn whose marker the model has seen; the only turn autoloop_emit may report to. */
  activeTurn(): HostTurn | null {
    if (this.phase.kind !== "working" && this.phase.kind !== "paused") return null;
    return this.phase.armed.delivered ? this.phase.armed.turn : null;
  }

  isLive(): boolean {
    return this.phase.kind !== "idle";
  }

  runTurn(turn: HostTurn): Promise<HostTurnResult> {
    const phase = this.phase;
    if (phase.kind !== "deciding") {
      throw new Error(`autoloop harness requested a turn while the session loop is ${phase.kind}`);
    }
    phase.live.runId = turn.runId;
    phase.live.lastTurn = turn;
    this.flushGuidance(phase.live, turn.runId);
    if (turn.signal.aborted) return Promise.resolve({ status: "interrupted", output: "" });
    return new Promise((resolve) => {
      const onAbort = () => this.interrupt(armed);
      const armed: ArmedTurn = {
        turn,
        delivered: phase.parked !== null,
        sent: phase.parked === null,
        usage: { ...EMPTY_USAGE },
        output: "",
        settle: (result) => {
          turn.signal.removeEventListener("abort", onAbort);
          phase.live.costUsd += armed.usage.costUsd;
          resolve(result);
        },
      };
      turn.signal.addEventListener("abort", onAbort, { once: true });
      this.setPhase({ kind: "working", live: phase.live, armed });
      if (phase.parked) phase.parked.resolve({ kind: "turn", turn });
      else this.pi.sendMessage(iterationMarker(turn), { triggerTurn: true, deliverAs: "followUp" });
    });
  }

  onAgentStart(): void {
    if (this.phase.kind === "paused") this.setPhase({ ...this.phase, kind: "working" });
  }

  onMessageEnd(message: AgentMessage): void {
    if (this.phase.kind !== "working" && this.phase.kind !== "paused") return;
    const armed = this.phase.armed;
    if (!armed.delivered) {
      armed.delivered = isIterationMarkerFor(message, armed.turn.runId, armed.turn.iteration);
      return;
    }
    if (message.role !== "assistant") return;
    const { usage } = message;
    armed.usage = {
      inputTokens: armed.usage.inputTokens + usage.input,
      outputTokens: armed.usage.outputTokens + usage.output,
      cacheReadTokens: armed.usage.cacheReadTokens + usage.cacheRead,
      cacheWriteTokens: armed.usage.cacheWriteTokens + usage.cacheWrite,
      costUsd: armed.usage.costUsd + usage.cost.total,
    };
    const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    // The harness classifies failures from the output, so an error must not report an earlier reply's text.
    if (message.stopReason === "error") {
      const error = message.errorMessage ?? "assistant error";
      armed.output = text.trim() ? `${text}\n${error}` : error;
    } else if (text.trim()) armed.output = text;
    this.pi.update(this.view());
  }

  /** The iteration boundary: ours only when the armed turn's marker is in the settled context. */
  async onBeforeSettle(event: AgentBeforeSettleEvent): Promise<BoundaryResult | undefined> {
    const phase = this.phase;
    if (phase.kind !== "working" && phase.kind !== "paused") return undefined;
    const { armed, live } = phase;
    const { runId, iteration } = armed.turn;
    if (event.outcome === "aborted") return undefined;
    if (!event.context.contextMessages.some((m) => isIterationMarkerFor(m, runId, iteration))) return undefined;
    const parked = deferred<Next>();
    this.setPhase({ kind: "deciding", live, parked });
    armed.settle({
      status: event.outcome === "error" ? "error" : "completed",
      output: armed.output,
      usage: armed.usage,
    });
    const next = await parked.promise;
    if (next.kind === "released") return undefined;
    if (next.kind === "end") return { entries: [...event.entries, asDraft(endMarker(next.end))], continue: false };
    return { entries: [...event.entries, asDraft(iterationMarker(next.turn))], continue: true };
  }

  /**
   * Pi settled without our boundary (Esc skips before_settle): the iteration stays open, paused.
   * An abort also clears pi's queues, dropping a marker still waiting as a follow-up; pi is idle
   * now, so re-sending it starts the iteration.
   */
  onSettled(): void {
    if (this.phase.kind !== "working") return;
    const { armed } = this.phase;
    if (armed.delivered) this.setPhase({ ...this.phase, kind: "paused" });
    else if (armed.sent && !this.pi.hasPendingMessages()) {
      this.pi.sendMessage(iterationMarker(armed.turn), { triggerTurn: true, deliverAs: "followUp" });
    }
  }

  /** Fails closed: a live iteration whose marker was projected away sees only its marker. */
  projectContext(messages: AgentMessage[]): AgentMessage[] {
    const projected = projectLoopContext(messages);
    if (this.phase.kind !== "working" && this.phase.kind !== "paused") return projected;
    const { armed } = this.phase;
    if (!armed.delivered) return projected;
    if (projected.some((m) => isIterationMarkerFor(m, armed.turn.runId, armed.turn.iteration))) return projected;
    return [{ role: "custom", ...iterationMarker(armed.turn), timestamp: Date.now() }];
  }

  private open(preset: string, cwd: string, runId: string | null): LiveRun {
    if (this.phase.kind !== "idle") {
      throw new Error(`autoloop ${this.phase.live.runId ?? "run"} is already live in this session; /loop:stop it first`);
    }
    const live: LiveRun = {
      preset,
      cwd,
      runId,
      controller: new AbortController(),
      lastTurn: null,
      costUsd: 0,
      pendingGuidance: [],
    };
    this.setPhase({ kind: "deciding", live, parked: null });
    return live;
  }

  private drive(live: LiveRun, run: Promise<RunOutcome>): void {
    run.then(
      (outcome) => this.finish(live, { stopReason: outcome.stopReason, iterations: outcome.iterations, runId: outcome.runId }),
      (error: unknown) =>
        this.finish(live, {
          stopReason: "error",
          iterations: live.lastTurn?.iteration ?? 0,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  private finish(live: LiveRun, outcome: { stopReason: string; iterations: number; runId?: string; error?: string }): void {
    const phase = this.phase;
    if (phase.kind === "idle" || phase.live !== live) return;
    if (phase.kind !== "deciding") this.interrupt(phase.armed);
    const end: EndMarkerDetails = {
      runId: outcome.runId ?? live.runId ?? "",
      stopReason: outcome.stopReason,
      iterations: outcome.iterations,
      costUsd: live.costUsd,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    const parked = this.phase.kind === "deciding" ? this.phase.parked : null;
    this.setPhase({ kind: "idle" });
    if (live.pendingGuidance.length > 0) {
      this.pi.notify(`The run ended before it started; guidance not delivered: ${live.pendingGuidance.join(" / ")}`, "warning");
    }
    if (parked) parked.resolve({ kind: "end", end });
    else this.pi.sendMessage(endMarker(end));
  }

  /** Runs inside runTurn, so a failed write is reported rather than thrown at the harness. */
  private flushGuidance(live: LiveRun, runId: string): void {
    for (const text of live.pendingGuidance.splice(0)) {
      try {
        this.harness.guide(runId, live.cwd, text);
      } catch (error) {
        this.pi.notify(`Guidance not delivered: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
  }

  /** Ends the armed turn as interrupted. No-op once the turn has moved on. */
  private interrupt(armed: ArmedTurn): void {
    const phase = this.phase;
    if ((phase.kind !== "working" && phase.kind !== "paused") || phase.armed !== armed) return;
    if (phase.kind === "working") this.pi.abortAgent();
    this.setPhase({ kind: "deciding", live: phase.live, parked: null });
    armed.settle({ status: "interrupted", output: armed.output, usage: armed.usage });
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.pi.update(this.view());
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
