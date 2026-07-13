#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const timeoutMs = Number(process.env.PI_AUTOLOOP_SMOKE_TIMEOUT_MS ?? 240_000);
const provider = process.env.PI_AUTOLOOP_SMOKE_PROVIDER ?? "openai-codex";
const model = process.env.PI_AUTOLOOP_SMOKE_MODEL ?? "gpt-5.4";
const thinking = process.env.PI_AUTOLOOP_SMOKE_THINKING ?? "low";
const session = `pi-autoloop-native-smoke-${process.pid}`;
const fixtureDir = mkdtempSync(join(tmpdir(), "pi-autoloop-native-smoke."));
const artifactDir = resolve(
  process.env.PI_AUTOLOOP_SMOKE_ARTIFACT_DIR ??
    mkdtempSync(join(tmpdir(), "pi-autoloop-native-smoke-artifacts.")),
);
const driverDebug = join(artifactDir, "driver-debug.jsonl");
const launcherFile = join(artifactDir, "launch.sh");
const registryFile = join(fixtureDir, ".autoloop", "registry.jsonl");
const journalFile = join(fixtureDir, ".autoloop", "journal.jsonl");
const targetFile = join(fixtureDir, "NATIVE_SMOKE.txt");
const readmeText = [
  "# Native Loop Smoke Fixture",
  "",
  "This repository is disposable and exists only to verify pi-autoloop's native in-session loop driver.",
  "",
].join("\n");
const objective = [
  "Create NATIVE_SMOKE.txt containing exactly native-loop-smoke-ok followed by one newline.",
  "Do not modify README.md. Verify the exact content.",
  "Complete the full planner, builder, critic, and finalizer flow.",
  "Emit task.complete only after verification, then finish with LOOP_COMPLETE.",
].join(" ");

mkdirSync(artifactDir, { recursive: true });

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function findExecutable(name) {
  const result = command("which", [name], { allowFailure: true });
  if (result.status !== 0) throw new Error(`${name} is required`);
  return result.stdout.trim();
}

function findPiExecutable() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const result = command("which", ["-a", "pi"], { allowFailure: true });
  const candidates = result.stdout.split("\n").filter(Boolean);
  const external = candidates.find((candidate) => !candidate.includes("/node_modules/.bin/"));
  if (!external && candidates.length === 0) throw new Error("pi is required");
  return external ?? candidates[0];
}

function tmux(args, options = {}) {
  return command("tmux", args, options);
}

function sessionExists() {
  return tmux(["has-session", "-t", session], { allowFailure: true }).status === 0;
}

function capturePane() {
  if (!sessionExists()) return "";
  return tmux(["capture-pane", "-t", session, "-p", "-J", "-S", "-5000"]).stdout;
}

function sendKeys(text) {
  tmux(["send-keys", "-t", session, "-l", text]);
  tmux(["send-keys", "-t", session, "Enter"]);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function processTable() {
  return command("ps", ["-axo", "pid,ppid,pgid,stat,command"]).stdout;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(label, predicate, limitMs = timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const value = predicate();
    if (value) return value;
    if (!sessionExists()) throw new Error(`tmux session exited while waiting for ${label}`);
    await delay(500);
  }
  throw new Error(`timed out after ${limitMs}ms waiting for ${label}`);
}

function assertOrderedTopics(topics, expected) {
  let cursor = -1;
  for (const topic of expected) {
    cursor = topics.indexOf(topic, cursor + 1);
    assert.notEqual(cursor, -1, `missing ordered journal topic: ${topic}`);
  }
}

function latestRun() {
  return readJsonl(registryFile).at(-1);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const summary = {
  name: "pi-autoloop-native-tmux-smoke",
  status: "running",
  session,
  fixtureDir,
  artifactDir,
  provider,
  model,
  thinking,
  timeoutMs,
};

let pane = "";
let piBin = "";
let failure;

try {
  piBin = findPiExecutable();
  findExecutable("tmux");
  const piVersion = command(piBin, ["--version"]).stdout.trim();
  Object.assign(summary, { piBin, piVersion });

  writeFileSync(join(fixtureDir, "README.md"), readmeText);
  command("git", ["init", "-b", "main"], { cwd: fixtureDir });
  command("git", ["add", "README.md"], { cwd: fixtureDir });
  command("git", ["commit", "-m", "chore: initialize native-loop smoke fixture"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-autoloop smoke",
      GIT_AUTHOR_EMAIL: "smoke@localhost",
      GIT_COMMITTER_NAME: "pi-autoloop smoke",
      GIT_COMMITTER_EMAIL: "smoke@localhost",
    },
  });
  const initialCommit = command("git", ["rev-parse", "HEAD"], { cwd: fixtureDir }).stdout.trim();

  const piArgs = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-e",
    join(repoRoot, "index.ts"),
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    thinking,
  ];
  writeFileSync(
    launcherFile,
    [
      "#!/usr/bin/env bash",
      "set +e",
      `export AUTOLOOP_DRIVER_DEBUG=${shellQuote(driverDebug)}`,
      "export PI_OFFLINE=1",
      `${shellQuote(piBin)} ${piArgs.map(shellQuote).join(" ")}`,
      "code=$?",
      "printf '\\n__PI_EXIT__:%s\\n' \"$code\"",
      "sleep 3600",
      "",
    ].join("\n"),
  );
  chmodSync(launcherFile, 0o755);

  tmux([
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "180",
    "-y",
    "60",
    "-c",
    fixtureDir,
    launcherFile,
  ]);

  await waitFor("Pi extension startup", () => {
    const current = capturePane();
    if (current.includes("__PI_EXIT__:")) {
      throw new Error(`Pi exited during startup:\n${current}`);
    }
    return current.includes("pi-autoloop") && current.includes("pi v");
  }, 30_000);
  writeFileSync(join(artifactDir, "process-table-before.txt"), processTable());

  sendKeys(`/loop:run autocode ${objective}`);

  const finalRecord = await waitFor("terminal registry record", () => {
    const record = latestRun();
    return record && record.status !== "running" ? record : null;
  });

  await waitFor("completion rendering", () => capturePane().includes("completion_event"), 30_000);
  const expectedProgress = `${finalRecord.iteration}/${finalRecord.max_iterations}`;
  tmux(["send-keys", "-t", session, "-l", `/loop:status ${finalRecord.run_id}`]);
  for (let attempt = 0; attempt < 30; attempt++) {
    tmux(["send-keys", "-t", session, "Enter"]);
    await delay(1_000);
    if (!sessionExists()) throw new Error("tmux session exited while submitting /loop:status");
    const current = capturePane();
    const statusStart = current.lastIndexOf(`Run: ${finalRecord.run_id}`);
    if (statusStart < 0) continue;
    const statusBlock = current.slice(statusStart);
    if (
      statusBlock.includes("Status: completed") &&
      statusBlock.includes("Backend: native") &&
      statusBlock.includes(`Iteration: ${expectedProgress}`)
    ) {
      pane = current;
      break;
    }
  }
  assert.ok(pane, "timed out waiting for completed /loop:status rendering");

  const journal = readJsonl(journalFile);
  const topics = journal.map((entry) => entry.topic);
  assertOrderedTopics(topics, [
    "tasks.ready",
    "review.ready",
    "review.passed",
    "task.complete",
    "loop.complete",
  ]);

  assert.equal(finalRecord.status, "completed");
  assert.equal(finalRecord.stop_reason, "completion_event");
  assert.equal(finalRecord.latest_event, "loop.complete");
  assert.equal(finalRecord.backend, "native");
  assert.equal(
    readFileSync(targetFile, "utf8"),
    "native-loop-smoke-ok\n",
    "fixture content mismatch",
  );
  assert.equal(readFileSync(join(fixtureDir, "README.md"), "utf8"), readmeText);
  assert.equal(command("git", ["status", "--porcelain"], { cwd: fixtureDir }).stdout, "");
  command("git", ["diff", "--exit-code", `${initialCommit}..HEAD`, "--", "README.md"], {
    cwd: fixtureDir,
  });

  const backendStarts = journal.filter((entry) => entry.topic === "backend.start");
  assert.equal(backendStarts.length, finalRecord.iteration);
  for (const entry of backendStarts) {
    assert.equal(entry.fields.backend_kind, "native");
    assert.equal(entry.fields.command, "native");
    assert.equal(entry.fields.prompt_mode, "session");
  }

  const contexts = readJsonl(driverDebug).filter((entry) => entry.event === "context");
  const firstByIteration = new Map();
  for (const entry of contexts) {
    if (!firstByIteration.has(entry.iteration)) firstByIteration.set(entry.iteration, entry);
    assert.equal(
      entry.returnedCount,
      entry.receivedCount - entry.start,
      `iteration ${entry.iteration} leaked messages before its seed`,
    );
  }
  assert.equal(firstByIteration.size, finalRecord.iteration);
  let previousStart = -1;
  for (const [iteration, entry] of firstByIteration) {
    assert.equal(entry.returnedCount, 1, `iteration ${iteration} did not start from one fresh seed`);
    assert.ok(entry.start > previousStart, `iteration ${iteration} seed did not advance`);
    previousStart = entry.start;
  }

  const lastCommit = command("git", ["rev-parse", "--short", "HEAD"], {
    cwd: fixtureDir,
  }).stdout.trim();
  Object.assign(summary, {
    status: "passed",
    runId: finalRecord.run_id,
    completedIterations: finalRecord.iteration,
    maxIterations: finalRecord.max_iterations,
    stopReason: finalRecord.stop_reason,
    backend: finalRecord.backend,
    contextSeedIndices: [...firstByIteration.values()].map((entry) => entry.start),
    fixtureCommit: lastCommit,
  });
} catch (error) {
  failure = error;
  summary.status = "failed";
  summary.error = error instanceof Error ? error.stack : String(error);
  pane ||= capturePane();
} finally {
  if (pane) writeFileSync(join(artifactDir, "pane.txt"), pane);
  if (sessionExists()) {
    tmux(["send-keys", "-t", session, "C-d"], { allowFailure: true });
    const exitDeadline = Date.now() + 10_000;
    while (
      sessionExists() &&
      !capturePane().includes("__PI_EXIT__:") &&
      Date.now() < exitDeadline
    ) {
      await delay(250);
    }
  }
  if (sessionExists()) tmux(["kill-session", "-t", session], { allowFailure: true });

  const after = processTable();
  writeFileSync(join(artifactDir, "process-table-after.txt"), after);
  const orphaned = after
    .split("\n")
    .filter((line) => line.includes(fixtureDir) && line.includes(piBin || "/pi"));
  summary.tmuxCleaned = !sessionExists();
  summary.orphanedPiProcesses = orphaned;
  if (orphaned.length > 0 && !failure) {
    failure = new Error(`orphaned Pi processes:\n${orphaned.join("\n")}`);
    summary.status = "failed";
    summary.error = failure.stack;
  }
  writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(JSON.stringify(summary, null, 2));
if (failure) process.exitCode = 1;
