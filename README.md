# pi-autoloop

A [pi](https://github.com/badlogic/pi-mono) extension that runs [autoloop](https://github.com/mikeyobrien/autoloop) — an autonomous, role-routed LLM loop harness — **natively inside your pi session**. The autoloop engine is reused as a library; your pi session's own model, tools, and context window do the work, one iteration per turn.

## Features

- **Native in-session loop** — starting a run puts *this* pi session into loop mode; each turn is one iteration of one role (planner → builder → critic → finalizer), routed by the autoloop engine
- **Fresh context every iteration** — the model-facing transcript is reset to a freshly-assembled seed each iteration (via pi's `context` event) while your TUI scrollback stays continuous
- **Native `loop_*` tools** — `loop_emit` / `loop_memory` / `loop_task` write the exact same journal/memory/task files as the `autoloop` CLI, so the engine's routing and completion logic are unchanged
- **Tool integration** — the LLM can start, monitor, stop, and inspect autoloop runs
- **Status widget** — themed single-line bar showing the active run with iteration progress, active role, latest event, and elapsed time
- **Completion notifications** — colored ✓/✗ messages when a run finishes
- **Rich rendering** — structured tool call/result display via ToolCallHeader/ToolBody (when [@aliou/pi-processes](https://github.com/aliou/pi-processes) is installed)
- **Slash commands** — `/loop:run`, `/loop:list`, `/loop:status`, `/loop:stop`, `/loop:inspect`, `/loop:presets` with tab completion

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) (the coding agent)
- The `@mobrienv/autoloop*` packages (declared as dependencies; installed automatically). The `autoloop` CLI is still used for `inspect`/`presets` — it resolves from the bundled dependency, or set `PI_AUTOLOOP_BIN` to override
- (Optional) [@aliou/pi-processes](https://github.com/aliou/pi-processes) for rich ToolCallHeader/ToolBody rendering — falls back to plain text without it

## Installation

```bash
npm install -g pi-autoloop
```

Or install from source:

```bash
git clone https://github.com/mikeyobrien/pi-autoloop
cd pi-autoloop
npm install
```

Then load it:

```bash
# One-off
pi -e /path/to/pi-autoloop

# Permanent — add to ~/.pi/agent/settings.json
{
  "packages": ["pi-autoloop"]
}
```

## Usage

### Tool (LLM-callable)

```
autoloop({ action: "run", preset: "autocode", prompt: "Implement feature X" })
autoloop({ action: "list" })
autoloop({ action: "status", runId: "clean-drift" })
autoloop({ action: "stop", runId: "clean-drift" })
autoloop({ action: "inspect", runId: "clean-drift", artifact: "scratchpad" })
autoloop({ action: "presets" })
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/loop:run <preset> <prompt>` | Start a run |
| `/loop:list` | List all runs from the registry |
| `/loop:status <runId>` | Show run details |
| `/loop:stop <runId>` | Stop a running loop |
| `/loop:inspect <runId> <artifact>` | Read scratchpad, journal, metrics, or memory |
| `/loop:presets` | List available presets |

Tab completion is available for run IDs and artifact names.

### Common Presets

| Preset | Use when… |
|--------|-----------|
| `autocode` | Implementing features, refactoring code |
| `autoqa` | Validating a codebase hands-on |
| `autotest` | Creating or tightening test suites |
| `autofix` | Diagnosing and repairing bugs |
| `autoreview` | Automated code review |
| `autosec` | Security audit |
| `autospec` | Turning rough ideas into RFCs |

## Architecture

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: registers tool, `loop_*` tools, commands, widget, and wires pi session events to the driver |
| `driver.ts` | Native loop driver — pi's session is the worker. Owns the iteration state machine, the per-iteration `context` swap, and the `before_agent_start` system-prompt split; drives the autoloop engine as a library |
| `tools-loop.ts` | Native `loop_emit` / `loop_memory` / `loop_task` tools wrapping the autoloop library functions (byte-identical file effects to the CLI) |
| `tool.ts` | The `autoloop` tool definition (run/list/status/stop/inspect/presets) with TypeBox schema |
| `render.ts` | TUI rendering: tool calls, results, and the completion message renderer |
| `dock.ts` | Live single-line status widget driven by in-process driver events |
| `completions.ts` | Tab completion for slash commands |
| `registry.ts` | Reads `.autoloop/registry.jsonl` (legacy runs from the old child-process version stay readable) |
| `types.ts` | Shared TypeScript interfaces and constants |

### How it works

The extension **is** the orchestrator; your pi session is the worker. On `run`, the driver builds an autoloop `LoopContext`, then seeds pi's session with the first iteration's prompt. At each iteration boundary (`agent_end`), the engine's `finishIteration` reads the journal — populated by the `loop_*` tools — computes routing/completion, and either seeds the next iteration or stops.

Each iteration gets a **fresh model context**: the `context` handler replaces the model-facing `messages[]` with just that iteration's seed plus its own in-progress tool rounds (`messages.slice(seedIndex)`), so prior iterations never leak to the model while your TUI scrollback stays intact.

**Passenger model (v1):** one loop per pi session; the loop monopolizes the session and **dies with pi** (no independent-process survival — a deliberate trade for "the loop *is* the session"). Stopping marks the run `interrupted` at the next boundary with all artifacts intact.

## Development

```bash
npm test
npm run typecheck
npm run smoke:native
```

`smoke:native` requires tmux and an authenticated Pi provider. It drives the real Pi TUI against a disposable git fixture, verifies the native planner → builder → critic → finalizer flow, checks fresh-context boundaries and terminal registry state, and writes an artifact bundle under the system temporary directory. Override the live provider with `PI_AUTOLOOP_SMOKE_PROVIDER`, `PI_AUTOLOOP_SMOKE_MODEL`, and `PI_AUTOLOOP_SMOKE_THINKING`.

## License

MIT
