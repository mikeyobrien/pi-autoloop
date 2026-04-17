import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "./registry.ts";
import type {
  AutoloopEvent,
  AutoloopRunState,
  ProgressLine,
  RunRecord,
} from "./types.ts";

export class AutoloopManager {
  private runs = new Map<string, AutoloopRunState>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private logDir: string;
  private events = new EventEmitter();

  constructor() {
    this.logDir = join(tmpdir(), `pi-autoloop-${Date.now()}`);
    mkdirSync(this.logDir, { recursive: true });
  }

  onEvent(listener: (event: AutoloopEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private emit(event: AutoloopEvent): void {
    this.events.emit("event", event);
  }

  startRun(
    preset: string,
    prompt: string,
    cwd: string,
    opts?: { backend?: string; worktree?: boolean; verbose?: boolean },
  ): AutoloopRunState {
    const args = ["run", preset, prompt];
    if (opts?.backend) args.push("-b", opts.backend);
    if (opts?.worktree) args.push("--worktree");
    if (opts?.verbose) args.push("-v");

    const stdoutLogFile = join(this.logDir, `run-${Date.now()}.log`);
    appendFileSync(stdoutLogFile, "");

    const child = spawn("autoloop", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      try {
        appendFileSync(stdoutLogFile, data);
      } catch {
        // ignore
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      try {
        appendFileSync(stdoutLogFile, data);
      } catch {
        // ignore
      }
    });

    // Discover run_id from first progress line
    const state: AutoloopRunState = {
      runId: "",
      preset,
      prompt,
      cwd,
      process: child,
      stdoutLogFile,
      startedAt: Date.now(),
    };

    child.on("close", () => {
      this.handleProcessExit(state);
    });

    child.on("error", () => {
      this.handleProcessExit(state);
    });

    // Use a temp key until we discover the real run_id
    const tempKey = `pending-${Date.now()}`;
    this.runs.set(tempKey, state);
    this.emit({ type: "runs_changed" });

    // Poll to discover run_id from progress lines or registry
    const discoveryPoll = setInterval(() => {
      // Try progress lines first
      const progress = this.parseProgressLines(stdoutLogFile);
      const firstWithId = progress.find((p) => p.run_id);
      if (firstWithId) {
        clearInterval(discoveryPoll);
        state.runId = firstWithId.run_id;
        this.runs.delete(tempKey);
        this.runs.set(state.runId, state);
        this.emit({ type: "run_started", runId: state.runId, preset });
        this.emit({ type: "runs_changed" });
        return;
      }
      // Fallback: check registry for a new running record matching our preset
      const records = readRegistry(state.cwd);
      const candidate = records
        .filter((r) => r.status === "running" && r.preset === preset && r.pid === state.process.pid)
        .pop();
      if (candidate) {
        clearInterval(discoveryPoll);
        state.runId = candidate.run_id;
        this.runs.delete(tempKey);
        this.runs.set(state.runId, state);
        this.emit({ type: "run_started", runId: state.runId, preset });
        this.emit({ type: "runs_changed" });
      }
    }, 500);

    // Stop discovery after 30s
    setTimeout(() => clearInterval(discoveryPoll), 30_000);

    this.ensurePoller();
    return state;
  }

  async stopRun(runId: string): Promise<boolean> {
    const state = this.runs.get(runId);
    if (!state) return false;

    try {
      state.process.kill("SIGINT");
    } catch {
      return false;
    }

    // Escalate to SIGKILL after 10s
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          state.process.kill("SIGKILL");
        } catch {
          // already dead
        }
        resolve(true);
      }, 10_000);

      state.process.on("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  getRuns(): AutoloopRunState[] {
    return Array.from(this.runs.values());
  }

  getProgress(runId: string): ProgressLine[] {
    const state = this.runs.get(runId);
    if (!state) return [];
    return this.parseProgressLines(state.stdoutLogFile);
  }

  cleanup(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    // Don't kill processes — they're independent
    this.runs.clear();
    this.emit({ type: "runs_changed" });
  }

  private ensurePoller(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.pollRegistry(), 2000);
  }

  private pollRegistry(): void {
    for (const state of this.runs.values()) {
      if (!state.runId) continue;
      const records = readRegistry(state.cwd);
      let latest: RunRecord | undefined;
      for (const r of records) {
        if (r.run_id === state.runId) latest = r;
      }
      if (latest && latest.status !== "running") {
        this.runs.delete(state.runId);
        this.emit({ type: "run_ended", runId: state.runId, record: latest });
        this.emit({ type: "runs_changed" });
      }
    }
    // Stop polling if no active runs
    if (this.runs.size === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private handleProcessExit(state: AutoloopRunState): void {
    if (!state.runId) return;
    // Read final registry state
    const records = readRegistry(state.cwd);
    let latest: RunRecord | undefined;
    for (const r of records) {
      if (r.run_id === state.runId) latest = r;
    }
    this.runs.delete(state.runId);
    this.emit({ type: "run_ended", runId: state.runId, record: latest });
    this.emit({ type: "runs_changed" });
  }

  private parseProgressLines(logFile: string): ProgressLine[] {
    let content: string;
    try {
      content = readFileSync(logFile, "utf-8");
    } catch {
      return [];
    }
    const lines: ProgressLine[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("[progress]")) continue;
      const parsed = this.parseProgressLine(line);
      if (parsed) lines.push(parsed);
    }
    return lines;
  }

  private parseProgressLine(line: string): ProgressLine | null {
    // Format: [progress] ts=<iso> run_id=<id> iter=<n> role=<role> recent=<event> emitted=<topic> outcome=<outcome>
    const pairs: Record<string, string> = {};
    const body = line.slice("[progress]".length).trim();
    for (const match of body.matchAll(/(\w+)=(\S+)/g)) {
      pairs[match[1]] = match[2];
    }
    if (!pairs.run_id) return null;
    return {
      ts: pairs.ts ?? "",
      run_id: pairs.run_id,
      iter: Number.parseInt(pairs.iter ?? "0", 10),
      role: pairs.role ?? "",
      recent: pairs.recent ?? "",
      emitted: pairs.emitted ?? "",
      outcome: pairs.outcome ?? "",
    };
  }
}
