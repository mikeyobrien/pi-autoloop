import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type {
  ExtensionAPI,
  ContextEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  AgentEndEvent,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// AgentMessage and ContextEventResult are not re-exported from the package entry
// point; derive them structurally from the ContextEvent type instead.
type AgentMessage = ContextEvent["messages"][number];
interface ContextEventResult {
  messages?: AgentMessage[];
}

import * as config from "@mobrienv/autoloop-core/config";
import {
  buildLoopContext,
  initStore,
  ensureLayout,
  installRuntimeTools,
  reloadLoop,
} from "@mobrienv/autoloop-harness/config-helpers";
import { buildIterationContext, type IterationContext } from "@mobrienv/autoloop-harness/prompt";
import { finishIteration } from "@mobrienv/autoloop-harness/iteration";
import {
  appendLoopStart,
  appendIterationStart,
  appendBackendStart,
  appendBackendFinish,
  appendIterationFinish,
} from "@mobrienv/autoloop-harness/parallel";
import { registryStart, registryProgress, registryStop } from "@mobrienv/autoloop-harness/registry-bridge";
import type { LoopContext, RunSummary } from "@mobrienv/autoloop-harness/types";
import { appendEvent } from "@mobrienv/autoloop-core/journal";
import { jsonField } from "@mobrienv/autoloop-core";

import type { AutoloopEvent, LoopState } from "./types.ts";
import { withNativeBackend } from "./native-state.ts";
import { appendFileSync } from "node:fs";

// Env-gated diagnostic log for the native loop driver. Off by default (zero cost).
// Set AUTOLOOP_DRIVER_DEBUG=/path/to/log to trace context resets per iteration.
const DRIVER_DEBUG = process.env.AUTOLOOP_DRIVER_DEBUG;
function dbg(entry: Record<string, unknown>): void {
  if (!DRIVER_DEBUG) return;
  try {
    appendFileSync(DRIVER_DEBUG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    /* best-effort */
  }
}

export interface StartRunOptions {
  preset: string;
  prompt: string;
  cwd: string;
  backend?: string;
  verbose?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * One live native loop. Holds the authoritative loop state, the reloaded
 * LoopContext for the in-flight iteration, and the watermark/pending-turn
 * bookkeeping that ties pi's session events back into autoloop's engine.
 */
interface ActiveLoop {
  state: LoopState;
  loop: LoopContext; // top-level context (survives reloads via aliased holders)
  cwd: string;

  /**
   * Best-known full-transcript length just before THIS iteration's seed was
   * appended. Used only as a lower bound for locating the seed message; the real
   * slice point is derived from the seed message's identity, not this counter.
   */
  watermark: number;
  /**
   * The exact prompt text sent as this iteration's seed user message. The seed is
   * relocated by this text on every context event (see findSeedIndex) rather than by
   * object identity, since pi rebuilds message objects between a turn's LLM calls.
   */
  seedPrompt: string;
  /** The IterationContext for the in-flight iteration (passed to finishIteration). */
  iter: IterationContext | null;
  /** Epoch ms at which the current iteration started (for per-iteration elapsed_s). */
  iterStartedAt: number;
  /** True while a loop iteration is being driven; distinguishes loop turns from user turns. */
  active: boolean;
  /** Resolves with the RunSummary once the CURRENT iteration's finishIteration settles. */
  pendingTurn: Deferred<RunSummary> | null;
  /** Set on stop()/session_shutdown so the next boundary terminates the loop. */
  aborted: boolean;
  /** True once a terminal journal.stop + registryStop pair has been written. */
  terminalWritten: boolean;
}

/**
 * Native driver: pi's interactive session is the worker. Replaces the old
 * child-process AutoloopManager. Keeps the same onEvent/emit EventEmitter idiom
 * so dock.ts / index.ts consume events unchanged.
 */
export class Driver {
  private pi: ExtensionAPI;
  private events = new EventEmitter();
  private loops = new Map<string, ActiveLoop>();

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  // -- Event plumbing (mirrors AutoloopManager) --

  onEvent(listener: (event: AutoloopEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private emit(event: AutoloopEvent): void {
    this.events.emit("event", event);
  }

  getRuns(): LoopState[] {
    return Array.from(this.loops.values()).map((l) => l.state);
  }

  /** The single active loop, if any. v1 is one-loop-per-pi-session. */
  private current(): ActiveLoop | undefined {
    for (const l of this.loops.values()) {
      if (l.active || l.state.phase !== "idle") return l;
    }
    return this.loops.values().next().value;
  }

  isLoopActive(): boolean {
    const l = this.current();
    return !!l && l.active;
  }

  /**
   * Paths for a loop's current LoopContext, for the native loop_* tools. Re-applies
   * the runtime env defensively so emit/memory/task writes always resolve to the
   * right files even if a tool fires slightly outside the seeded env window.
   */
  getActiveLoopPaths(runId: string):
    | { projectDir: string; stateDir: string; tasksFile: string; journalFile: string }
    | null {
    const active = this.loops.get(runId);
    if (!active) return null;
    if (active.iter) this.applyRuntimeEnv(active.loop, active.iter);
    return {
      projectDir: active.loop.paths.projectDir,
      stateDir: active.loop.paths.stateDir,
      tasksFile: active.loop.paths.tasksFile,
      journalFile: active.loop.paths.journalFile,
    };
  }

  // -- Lifecycle --

  /**
   * Start a native loop. Builds the LoopContext, writes loop.start + registry,
   * then kicks off iteration 1 by seeding pi's session. Returns immediately with
   * the LoopState; the loop drives itself off agent_end.
   */
  startRun(opts: StartRunOptions): LoopState {
    if (this.current()?.active) {
      throw new Error(
        "A loop is already active in this session. /loop:stop it first.",
      );
    }

    const projectDir = config.resolveProjectDir(opts.preset, "");
    if (!projectDir) {
      throw new Error(`preset \`${opts.preset}\` not found`);
    }

    const backendOverride: Record<string, unknown> = {};
    // Native loops run inside pi's own session; no worktree in v1.
    let loop = withNativeBackend(
      buildLoopContext(projectDir, opts.prompt, "autoloop", {
        workDir: opts.cwd,
        backendOverride,
        logLevel: opts.verbose ? "debug" : null,
        trigger: "cli",
        noWorktree: true,
      }),
    );
    loop = initStore(loop);
    ensureLayout(loop.paths.stateDir);
    installRuntimeTools(loop);
    appendLoopStart(loop);
    registryStart(loop);

    const state: LoopState = {
      runId: loop.runtime.runId,
      preset: opts.preset,
      objective: opts.prompt,
      startedAt: Date.now(),
      iteration: 0,
      maxIterations: loop.limits.maxIterations,
      activeRole: "",
      phase: "awaiting-iteration",
      journalFile: loop.paths.journalFile,
    };

    const active: ActiveLoop = {
      state,
      loop,
      cwd: opts.cwd,
      watermark: 0,
      seedPrompt: "",
      iter: null,
      iterStartedAt: Date.now(),
      active: true,
      pendingTurn: null,
      aborted: false,
      terminalWritten: false,
    };
    this.loops.set(state.runId, active);

    this.emit({ type: "run_started", runId: state.runId, preset: opts.preset });
    this.emit({ type: "runs_changed" });

    // Kick off the loop. Do not await — the promise resolves at loop end.
    void this.runLoop(active);

    return state;
  }

  /**
   * Top-level loop runner. `this.iterate` is the injected executor autoloop's
   * finishIteration recurses through. The returned promise settles once the loop
   * reaches a terminal state (complete / stop / interrupted).
   */
  private async runLoop(active: ActiveLoop): Promise<void> {
    let summary: RunSummary;
    try {
      summary = await this.iterate(active.loop, 1);
    } catch (err) {
      summary = {
        iterations: active.state.iteration,
        stopReason: `error:${(err as Error)?.message ?? "unknown"}`,
        runId: active.state.runId,
      };
    }
    this.finalize(active, summary);
  }

  /**
   * The pi-native executor. Mirrors runReviewThenIterate's guards + runIteration's
   * journal side-effects, but drives pi's session instead of spawning a backend.
   *
   * Called by startRun (iteration 1) and recursively by finishIteration
   * (iteration N+1). Returns a promise that resolves when THIS iteration's
   * finishIteration settles (which is itself the next iterate's result, chaining
   * to the terminal summary).
   */
  private iterate = async (
    loopCtx: LoopContext,
    iteration: number,
  ): Promise<RunSummary> => {
    // Called both directly (startRun -> iteration 1) and recursively by
    // finishIteration (iteration N+1), always as iterate(loop, iteration).
    const active = this.byLoop(loopCtx) ?? this.current();
    if (!active) {
      return { iterations: iteration - 1, stopReason: "interrupted" };
    }

    if (active.aborted) {
      return {
        iterations: iteration - 1,
        stopReason: "interrupted",
        runId: active.state.runId,
      };
    }

    // Reload config for the live iteration (matches iterateWith).
    const liveLoop = withNativeBackend(reloadLoop(active.loop));
    installRuntimeTools(liveLoop);
    active.loop = liveLoop;

    // Guard: iteration limit (matches runReviewThenIterate).
    if (iteration > liveLoop.limits.maxIterations) {
      return this.stopMaxIterations(active, liveLoop, iteration);
    }

    const iter = buildIterationContext(liveLoop, iteration);
    active.iter = iter;
    active.iterStartedAt = Date.now();
    active.state.iteration = iter.iteration;
    active.state.activeRole = iter.allowedRoles[0] ?? "";
    active.state.phase = "awaiting-iteration";

    // Journal side-effects that runIteration writes before running the backend.
    appendIterationStart(liveLoop, iter);
    appendBackendStart(liveLoop, iter);

    // Publish the runtime env so native loop_* tools produce byte-identical
    // journal/memory/task file effects to the CLI emit tool path.
    this.applyRuntimeEnv(liveLoop, iter);

    this.emit({
      type: "run_progress",
      runId: active.state.runId,
      iteration: iter.iteration,
      role: active.state.activeRole,
      event: iter.recentEvent,
    });
    this.emit({ type: "runs_changed" });

    // Lower bound for locating the seed. The authoritative slice point is the seed
    // message's text identity (re-resolved in onContext each call), so this counter
    // never needs to be exact — it only bounds the scan and disambiguates the seed
    // from any earlier identical user text.
    active.watermark = this.sessionLength;
    active.seedPrompt = iter.prompt;
    active.state.phase = "running";
    const turn = deferred<RunSummary>();
    active.pendingTurn = turn;

    // Seeding the prompt as a real user message shows the iteration boundary in
    // scrollback AND triggers the turn.
    this.pi.sendUserMessage(iter.prompt, { deliverAs: "followUp" });

    return turn.promise;
  };

  /**
   * agent_end handler: the iteration boundary. Collect this iteration's assistant
   * output (messages after the watermark), write backend/iteration finish, then
   * hand off to finishIteration which computes routing/completion and recurses.
   */
  onAgentEnd(event: AgentEndEvent, _ctx: ExtensionContext): void {
    const active = this.current();
    if (!active || !active.active || !active.pendingTurn || !active.iter) {
      return; // not a loop-driven turn (user's own input)
    }

    // event.messages is THIS run's new messages (seed + assistant/tool rounds).
    // All of it is this iteration's output, so collect from index 0. Do NOT derive
    // any transcript watermark from its length — it is a partial array whose length
    // is NOT a full-transcript index (that would strand tool pairs / leak prior
    // iterations). The full-transcript length is tracked only in onContext.
    const newMessages = event.messages ?? [];
    const output = this.collectAssistantOutput(newMessages, 0);
    dbg({
      event: "agent_end",
      iteration: active.iter.iteration,
      role: active.iter.roleAgent,
      newMessageCount: newMessages.length,
      outputLen: output.length,
    });

    const liveLoop = active.loop;
    const iter = active.iter;
    const turn = active.pendingTurn;
    active.pendingTurn = null;
    active.iter = null;

    // Journal finish events (matches runIteration ordering after the backend).
    // elapsed_s is per-iteration (from this iteration's start), matching how
    // runIteration records it — not cumulative from the whole-run start.
    const elapsedS = Math.floor((Date.now() - active.iterStartedAt) / 1000);
    appendBackendFinish(liveLoop, iter, output, 0, false);
    appendIterationFinish(liveLoop, iter, output, 0, false, elapsedS);
    registryProgress(liveLoop, iter.iteration);

    if (active.aborted) {
      // User-initiated stop with a turn in flight: write the terminal pair so the
      // journal has a loop.stop marker and the registry lands in a terminal status,
      // mirroring the harness stop path. finalize() no-ops these when already done.
      this.writeInterruptedTerminal(active, iter.iteration);
      turn.resolve({
        iterations: iter.iteration,
        stopReason: "interrupted",
        runId: active.state.runId,
      });
      return;
    }

    // finishIteration reads the journal for routing, then either terminates or
    // calls this.iterate(loop, iteration+1). Its resolved summary becomes THIS
    // turn's result, chaining recursion up to the terminal summary.
    finishIteration(liveLoop, iter, output, this.iterate).then(
      (summary) => turn.resolve(summary),
      (err) => turn.reject(err),
    );
  }

  /**
   * context handler: the watermark swap. Replace the model-facing transcript with
   * only THIS iteration's messages (seed + in-progress tool rounds). NEVER fall
   * back to the full array; NEVER leak prior iterations.
   */
  onContext(event: ContextEvent, _ctx: ExtensionContext): ContextEventResult | void {
    const active = this.current();
    // Use the SAME guard as onAgentEnd: only rewrite the transcript when a
    // loop-seeded turn is genuinely in flight. If the user submits a message in the
    // inter-iteration gap (pendingTurn/iter cleared, phase not running), leave the
    // transcript untouched so their turn is not sliced at a stale watermark.
    if (
      !active ||
      !active.active ||
      !active.pendingTurn ||
      !active.iter ||
      active.state.phase !== "running"
    ) {
      return; // user-driven / non-loop turn: leave the transcript untouched
    }
    const messages = event.messages ?? [];
    // Track the true full-transcript length here (the ONLY place we see the full
    // array). This becomes the next iteration's watermark lower bound.
    this.sessionLength = messages.length;

    // Resolve THIS iteration's seed by content on EVERY call. `context` fires before
    // every LLM call in a turn, and pi rebuilds the message objects between calls —
    // so caching the seed object and reusing indexOf() fails (indexOf returns -1 on
    // the rebuilt array) and strands the slice on the watermark fallback, leaking the
    // prior iteration's trailing message into the model's view. Re-scanning by the
    // seed's text identity keeps every call — the first AND every mid-tool-round
    // call — sliced at the exact seed. (Caught by the live smoke test: iter 2's
    // follow-up calls came back start=watermark instead of start=seedIndex.)
    let start = this.findSeedIndex(messages, active);
    if (start < 0) {
      // Seed not yet located (e.g. delivery queued behind a still-streaming turn).
      // Fall back to the watermark lower bound rather than the full array.
      start = Math.min(Math.max(active.watermark, 0), messages.length);
    }

    const sliced = messages.slice(start);
    dbg({
      event: "context",
      iteration: active.iter.iteration,
      role: active.iter.roleAgent,
      receivedCount: messages.length,
      receivedRoles: messages.map((m: any) => m.role),
      start,
      returnedCount: sliced.length,
      returnedRoles: sliced.map((m: any) => m.role),
    });
    if (sliced.length === 0) {
      // Empty slice would let emitContext keep the FULL transcript unchanged (the
      // leaky full-array fallback). Never allow that: synthesize a minimal valid
      // transcript containing just this iteration's seed prompt.
      return { messages: [{ role: "user", content: active.seedPrompt, timestamp: Date.now() } as AgentMessage] };
    }
    return { messages: sliced };
  }

  /**
   * Index of this iteration's seed user message, resolved by content. Scans from the
   * end so the seed (appended last, immediately before the turn triggers) wins over
   * any earlier identical user text, and only considers messages at-or-after the
   * watermark. Returns -1 if not yet present. Called on every `context` event — must
   * NOT cache a message-object reference, since pi rebuilds message objects between
   * the LLM calls of a single turn.
   */
  private findSeedIndex(messages: AgentMessage[], active: ActiveLoop): number {
    const lo = Math.max(active.watermark, 0);
    for (let i = messages.length - 1; i >= lo; i--) {
      const m = messages[i] as any;
      if (m?.role !== "user") continue;
      if (this.userText(m) === active.seedPrompt) return i;
    }
    return -1;
  }

  /** Flatten a user message's content to plain text for seed identity matching. */
  private userText(m: any): string {
    const content = m?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("");
    }
    return "";
  }

  /**
   * before_agent_start handler: append the static harness block + role preamble
   * (redirecting {{TOOL_PATH}} emit instructions to the native loop_* tools).
   * Stable across iterations -> prompt-cache friendly. Chained across extensions.
   */
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    _ctx: ExtensionContext,
  ): BeforeAgentStartEventResult | void {
    const active = this.current();
    if (!active || !active.active) return;
    const block = this.harnessSystemBlock(active.loop);
    return { systemPrompt: event.systemPrompt + block };
  }

  /**
   * Stop a run. Marks aborted; the loop terminates at the next agent_end boundary.
   * If no turn is in flight, terminates immediately as interrupted.
   */
  async stop(runId?: string): Promise<boolean> {
    const active = runId ? this.loops.get(runId) : this.current();
    if (!active) return false;
    active.aborted = true;
    active.state.phase = "stopping";

    if (!active.pendingTurn) {
      // No turn in flight -> terminate now.
      this.finalize(active, {
        iterations: active.state.iteration,
        stopReason: "interrupted",
        runId: active.state.runId,
      });
    }
    return true;
  }

  /** Mark all loops interrupted on session shutdown (loop dies with pi). */
  shutdown(): void {
    for (const active of this.loops.values()) {
      active.aborted = true;
      active.active = false;
      try {
        registryStop(active.loop, active.state.iteration, "interrupted");
      } catch {
        /* best-effort */
      }
    }
    this.loops.clear();
    this.emit({ type: "runs_changed" });
  }

  // -- Internals --

  /** Session message count, tracked from context/agent_end events. */
  private sessionLength = 0;

  private byLoop(loop: LoopContext): ActiveLoop | undefined {
    for (const l of this.loops.values()) {
      if (l.state.runId === loop.runtime.runId) return l;
    }
    return undefined;
  }

  private finalize(active: ActiveLoop, summary: RunSummary): void {
    if (!this.loops.has(active.state.runId)) return; // already finalized
    active.active = false;
    active.state.phase = "idle";
    active.state.iteration = summary.iterations;

    // For a user-initiated stop with no turn in flight (stop() -> finalize()
    // directly), no terminal marker has been written yet: land the registry in a
    // terminal status and write the journal loop.stop event. completeLoop /
    // stopMaxIterations already wrote their own terminals (terminalWritten set).
    if (summary.stopReason.startsWith("interrupted") || summary.stopReason.startsWith("error")) {
      this.writeInterruptedTerminal(active, summary.iterations);
    }

    // Capture the display info from the RunSummary + loop limits BEFORE deleting the
    // loop, so the run_ended consumer renders authoritative numbers (the in-memory
    // LoopState is not a reliable source for the completion string).
    const info = {
      preset: active.state.preset,
      iterations: summary.iterations,
      maxIterations: active.loop.limits.maxIterations,
      stopReason: summary.stopReason,
      startedAt: active.state.startedAt,
    };
    this.loops.delete(active.state.runId);
    this.emit({ type: "run_ended", runId: active.state.runId, info });
    this.emit({ type: "runs_changed" });
  }

  private stopMaxIterations(
    active: ActiveLoop,
    loop: LoopContext,
    iteration: number,
  ): RunSummary {
    const completed = iteration <= 1 ? 0 : iteration - 1;
    try {
      // Write the terminal loop.stop journal event BEFORE registryStop, mirroring
      // the harness stopMaxIterations so the journal and registry agree (no run
      // trailing off without a terminal event).
      appendEvent(
        loop.paths.journalFile,
        loop.runtime.runId,
        "",
        "loop.stop",
        jsonField("reason", "max_iterations") +
          ", " +
          jsonField("completed_iterations", String(completed)) +
          ", " +
          jsonField("stopped_before_iteration", String(iteration)) +
          ", " +
          jsonField("max_iterations", String(loop.limits.maxIterations)),
      );
      registryStop(loop, completed, "max_iterations");
      active.terminalWritten = true;
    } catch {
      /* best-effort */
    }
    return { iterations: completed, stopReason: "max_iterations", runId: active.state.runId };
  }

  /**
   * Write the terminal pair for an interrupted (user-stopped) run: a loop.stop
   * journal event + registryStop, mirroring the harness stop path so the registry
   * lands in a terminal status and the journal has a terminal marker. Idempotent-ish:
   * only called once per run (from onAgentEnd's abort path or finalize()).
   */
  private writeInterruptedTerminal(active: ActiveLoop, completed: number): void {
    if (active.terminalWritten) return;
    active.terminalWritten = true;
    const loop = active.loop;
    try {
      appendEvent(
        loop.paths.journalFile,
        loop.runtime.runId,
        "",
        "loop.stop",
        jsonField("reason", "interrupted") +
          ", " +
          jsonField("completed_iterations", String(completed)),
      );
      registryStop(loop, completed, "interrupted");
    } catch {
      /* best-effort */
    }
  }

  /**
   * Extract the assistant text produced in this iteration (messages after the
   * watermark). finishIteration uses this only for the completion-promise check;
   * routing is journal-driven (via loop_emit).
   */
  private collectAssistantOutput(messages: AgentMessage[], watermark: number): string {
    const parts: string[] = [];
    for (let i = Math.max(0, watermark); i < messages.length; i++) {
      const m = messages[i] as any;
      if (m?.role !== "assistant") continue;
      const content = m.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
      }
    }
    return parts.join("\n");
  }

  /**
   * Mirror runtimeEnvLines: set the process env the native loop_* tools read so
   * emit/memory/task file effects are byte-identical to `autoloop emit` etc.
   */
  private applyRuntimeEnv(loop: LoopContext, iter: IterationContext): void {
    const csv = (xs: string[]) => xs.join(",");
    process.env.AUTOLOOP_RUN_ID = loop.runtime.runId;
    process.env.AUTOLOOP_ITERATION = String(iter.iteration);
    process.env.AUTOLOOP_LOG_LEVEL = loop.runtime.logLevel;
    process.env.AUTOLOOP_COMPLETION_PROMISE = loop.completion.promise;
    process.env.AUTOLOOP_COMPLETION_EVENT = loop.completion.event;
    process.env.AUTOLOOP_STATE_DIR = loop.paths.stateDir;
    process.env.AUTOLOOP_PROJECT_DIR = loop.paths.projectDir;
    process.env.AUTOLOOP_JOURNAL_FILE = loop.paths.journalFile;
    process.env.AUTOLOOP_EVENTS_FILE = loop.paths.journalFile;
    process.env.AUTOLOOP_MEMORY_FILE = loop.paths.memoryFile;
    process.env.AUTOLOOP_TASKS_FILE = loop.paths.tasksFile;
    process.env.AUTOLOOP_REQUIRED_EVENTS = csv(loop.completion.requiredEvents);
    process.env.AUTOLOOP_RECENT_EVENT = iter.recentEvent;
    process.env.AUTOLOOP_ALLOWED_ROLES = csv(iter.allowedRoles);
    process.env.AUTOLOOP_ALLOWED_EVENTS = csv(iter.allowedEvents);
    process.env.AUTOLOOP_BIN = loop.paths.toolPath;
  }

  /**
   * Static harness block appended to pi's system prompt while a loop is active.
   * Preset-agnostic in v1: redirects the presets' `{{TOOL_PATH}} emit …`
   * instructions to the native loop_emit / loop_memory / loop_task tools.
   */
  private harnessSystemBlock(loop: LoopContext): string {
    const inst = loop.harness?.instructions?.trim();
    return (
      "\n\n## AUTOLOOP HARNESS\n" +
      "You are the worker inside an autonomous autoloop. Each turn is ONE iteration " +
      "of ONE role. Do the role's work for this iteration, then signal progress.\n\n" +
      "IMPORTANT — native tools replace the CLI tool path:\n" +
      "- Wherever the role instructions say to run a shell command like " +
      "`{{TOOL_PATH}} emit <topic> <payload>` (or `autoloop emit …`), instead call " +
      "the `loop_emit` tool with { topic, payload }.\n" +
      "- Wherever they say to record a learning/memory, call `loop_memory`.\n" +
      "- Wherever they say to add or complete a task, call `loop_task`.\n" +
      "These native tools write the exact same journal/memory/task files, so routing " +
      "and completion work unchanged. Emit the routing event for your role every " +
      "iteration; the loop advances only when you do.\n" +
      (inst ? `\n${inst}\n` : "")
    );
  }
}
