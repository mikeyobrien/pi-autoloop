import assert from "node:assert/strict";
import test from "node:test";

import {
  formatIterationProgress,
  withNativeBackend,
} from "../native-state.ts";

test("iteration progress preserves authoritative 1-based engine counts", () => {
  assert.equal(formatIterationProgress(1, 100), "1/100");
  assert.equal(formatIterationProgress(4, 100), "4/100");
});

test("native loops replace spawned-backend metadata without mutating preset config", () => {
  const presetLoop = {
    backend: {
      kind: "command",
      provider: "",
      command: "claude",
      args: ["-p", "--dangerously-skip-permissions"],
      promptMode: "file",
      timeoutMs: 3_000_000,
      trustAllTools: true,
      agent: "",
      model: "",
    },
  };

  const nativeLoop = withNativeBackend(presetLoop);

  assert.equal(nativeLoop.backend.command, "native");
  assert.deepEqual(nativeLoop.backend.args, []);
  assert.equal(presetLoop.backend.command, "claude");
  assert.deepEqual(presetLoop.backend.args, ["-p", "--dangerously-skip-permissions"]);
});
