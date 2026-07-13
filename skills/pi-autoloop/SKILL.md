---
description: Run autonomous LLM loops for complex, multi-step tasks with iterative role-based workflows using the autoloop tool.
---

# pi-autoloop

Use the `autoloop` tool to run autonomous LLM loops for complex, multi-step tasks that benefit from iterative execution with role-based workflows. The loop runs **natively inside this pi session** — starting one puts this session into loop mode, and your subsequent turns *are* the loop's iterations.

## When to use autoloop

- Multi-file refactors, feature implementations, or code generation that need iterative build-test-fix cycles
- Research tasks requiring exploration across multiple approaches
- Quality audits, security reviews, or test generation across a codebase
- Any task where you'd normally need many sequential tool calls with verification

## When NOT to use autoloop

- Simple single-file edits — use `edit` or `write` directly
- Quick questions or lookups — answer directly

## How it runs (important)

`run` starts the loop **in this session** and returns immediately. From then on, each turn is one iteration of one role (planner → builder → critic → finalizer). Do the current role's work, then signal progress by calling the native tools:

- **`loop_emit`** — emit the routing event for your role (replaces any `autoloop emit <topic>` instruction). The loop only advances when you emit.
- **`loop_memory`** — record a learning (replaces `autoloop memory add`).
- **`loop_task`** — add or complete a task (replaces `autoloop task …`).

The system prompt injected while a loop is active tells you which events to emit. `/loop:stop` (or `autoloop({action:"stop"})`) always reclaims control; the run ends cleanly at the next boundary with artifacts intact.

## Actions

| Action | Required Params | Description |
|--------|----------------|-------------|
| `run` | `preset`, `prompt` | Start an autoloop in this session. Optional: `verbose`. (`backend`/`worktree` are ignored — the session's own model does all roles, no worktree in v1) |
| `presets` | — | List available presets |
| `list` | — | Show active and recent runs |
| `status` | `runId` | Get run progress (iteration, role, latest event); returns the journal path you can read with your own file tools |
| `stop` | `runId` (optional) | Stop the running autoloop; terminates at the next iteration boundary |
| `inspect` | `runId`, `artifact` | Read run artifacts: `scratchpad`, `journal`, `metrics`, `memory` |

## Common presets

- `autocode` — implement features, refactor code
- `autoqa` — validate a codebase without custom test harnesses
- `autotest` — create or tighten test suites
- `autofix` — diagnose and repair bugs
- `autoreview` — automated code review
- `autosec` — security audit

## Example

```
autoloop({ action: "run", preset: "autocode", prompt: "Add input validation to the user registration endpoint" })
```

This session is now the loop worker. Do the current role's work each turn and emit the routing event with `loop_emit`. Check progress any time with `status`, or wait for the completion notification.
