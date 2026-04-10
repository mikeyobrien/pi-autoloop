# pi-autoloop

Use the `autoloop` tool to run autonomous LLM loops for complex, multi-step tasks that benefit from iterative execution with role-based workflows.

## When to use autoloop

- Multi-file refactors, feature implementations, or code generation that need iterative build-test-fix cycles
- Research tasks requiring exploration across multiple approaches
- Quality audits, security reviews, or test generation across a codebase
- Any task where you'd normally need many sequential tool calls with verification

## When NOT to use autoloop

- Simple single-file edits — use `edit` or `write` directly
- Quick questions or lookups — answer directly
- Tasks that need real-time user interaction — autoloop runs autonomously

## Actions

| Action | Required Params | Description |
|--------|----------------|-------------|
| `run` | `preset`, `prompt` | Start an autoloop. Optional: `backend`, `worktree`, `verbose` |
| `presets` | — | List available presets |
| `list` | — | Show active and recent runs |
| `status` | `runId` | Get run progress (iteration, status, latest event) |
| `stop` | `runId` | Stop a running autoloop (SIGINT, then SIGKILL) |
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

Then check progress with `status` or wait for the completion notification.
