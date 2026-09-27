import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostWorker } from "../host-types.ts";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  resume: vi.fn(),
  resumeProblem: vi.fn(),
  findRunByPrefix: vi.fn(),
  appendOperatorEvent: vi.fn(),
  resolvePresetSource: vi.fn(),
}));

vi.mock("@mobrienv/autoloop-harness", () => ({ run: mocks.run, resume: mocks.resume, resumeProblem: mocks.resumeProblem }));
vi.mock("@mobrienv/autoloop-core/registry/read", () => ({ findRunByPrefix: mocks.findRunByPrefix }));
vi.mock("@mobrienv/autoloop-core/journal", () => ({ appendOperatorEvent: mocks.appendOperatorEvent }));
vi.mock("@mobrienv/autoloop-core/config", () => ({ resolvePresetSource: mocks.resolvePresetSource }));
vi.mock("../autoloop-bin.ts", () => ({ resolveAutoloopBin: () => "/bin/autoloop" }));

const { harnessAdapter } = await import("../harness-adapter.ts");

const host = {} as HostWorker;
const signal = new AbortController().signal;
const OUTCOME = { runId: "run-1", iterations: 1, stopReason: "completion_event" };

function record(over: Record<string, unknown> = {}) {
  return { run_id: "run-1", work_dir: "/repo", isolation_mode: "shared", journal_file: "/repo/.autoloop/journal.jsonl", ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(OUTCOME);
  mocks.resume.mockResolvedValue(OUTCOME);
  mocks.resumeProblem.mockReturnValue(null);
  mocks.findRunByPrefix.mockReturnValue(record());
});

describe("run", () => {
  it("never moves the run into a worktree and keeps metareview off", async () => {
    mocks.resolvePresetSource.mockReturnValue({ kind: "dir", projectDir: "/presets/autocode" });
    expect(await harnessAdapter.run({ preset: "autocode", objective: "x", cwd: "/repo" }, host, signal)).toBe(OUTCOME);
    const [projectDir, objective, self, options] = mocks.run.mock.calls[0];
    expect([projectDir, objective, self]).toEqual(["/presets/autocode", "x", "'/bin/autoloop'"]);
    expect(options).toMatchObject({ host, signal, workDir: "/repo", noWorktree: true, configOverride: { review: { enabled: false } } });
    expect(options).not.toHaveProperty("presetFile");
  });

  it("passes a file preset through", async () => {
    mocks.resolvePresetSource.mockReturnValue({ kind: "file", projectDir: "/p", file: "/p/preset.toml" });
    await harnessAdapter.run({ preset: "./preset.toml", objective: "x", cwd: "/repo" }, host, signal);
    expect(mocks.run.mock.calls[0][3]).toMatchObject({ presetFile: "/p/preset.toml", noWorktree: true });
  });

  it("rejects an unknown preset", async () => {
    mocks.resolvePresetSource.mockReturnValue(null);
    await expect(harnessAdapter.run({ preset: "nope", objective: "x", cwd: "/repo" }, host, signal)).rejects.toThrow(
      "unknown autoloop preset: nope",
    );
  });
});

describe("resume", () => {
  it("resumes a safe run in the session cwd", async () => {
    expect(await harnessAdapter.resume("run-1", "/repo/", host, signal)).toBe(OUTCOME);
    expect(mocks.findRunByPrefix).toHaveBeenCalledWith("/repo/.autoloop/registry.jsonl", "run-1");
    expect(mocks.resumeProblem).toHaveBeenCalledWith(record());
    expect(mocks.resume).toHaveBeenCalledWith(record(), expect.objectContaining({ baseStateDir: "/repo/.autoloop", host, signal }));
  });

  it("throws the harness's resume problem", async () => {
    mocks.resumeProblem.mockReturnValue("run-1 is still running (pid 42)");
    await expect(harnessAdapter.resume("run-1", "/repo", host, signal)).rejects.toThrow("run-1 is still running (pid 42)");
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("refuses a worktree run", async () => {
    mocks.findRunByPrefix.mockReturnValue(record({ isolation_mode: "worktree" }));
    await expect(harnessAdapter.resume("run-1", "/repo", host, signal)).rejects.toThrow(/runs in a worktree/);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("refuses a run whose work dir is not the session cwd", async () => {
    mocks.findRunByPrefix.mockReturnValue(record({ work_dir: "/elsewhere" }));
    await expect(harnessAdapter.resume("run-1", "/repo", host, signal)).rejects.toThrow(
      "run-1 works in /elsewhere; resume it from a pi session there",
    );
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("reports missing and ambiguous run ids", async () => {
    mocks.findRunByPrefix.mockReturnValue(null);
    await expect(harnessAdapter.resume("zz", "/repo", host, signal)).rejects.toThrow("no autoloop run matching zz");
    mocks.findRunByPrefix.mockReturnValue([record(), record({ run_id: "run-12" })]);
    await expect(harnessAdapter.resume("run-1", "/repo", host, signal)).rejects.toThrow("run-1 is ambiguous: run-1, run-12");
  });
});

describe("guide", () => {
  it("appends operator guidance to the run's journal", () => {
    harnessAdapter.guide("run-1", "/repo", "prefer redis");
    expect(mocks.appendOperatorEvent).toHaveBeenCalledWith("/repo/.autoloop/journal.jsonl", "run-1", "", "operator.guidance", "prefer redis");
  });
});
