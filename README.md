# pi-autoloop

A [pi](https://github.com/badlogic/pi-mono) extension that integrates [autoloop](https://github.com/mikeyobrien/autoloop) — an autonomous LLM loop harness — as a first-class tool with rich TUI rendering, live status widgets, and completion notifications.

## Features

- **In-session loops (default)** — `/loop:run autocode <objective>` runs the preset inside your pi session. The current agent is the worker; each iteration starts with a fresh model context holding only the active role prompt and iteration prompt, while the transcript keeps every iteration visible.
- **Live steering** — type mid-iteration to steer it; Esc pauses the loop; `/loop:continue`, `/loop:guide`, `/loop:stop`, and `/loop:resume` control it.
- **`autoloop_emit` tool** — the worker reports its routing event; the harness validates it against the iteration's allowed events and returns the reason on rejection.
- **Detached runs** — `/loop:run --detached` spawns the autoloop CLI in the background with the preset's own backend.
- **Dock and transcript cards** — a dock line shows run id, iteration, role, phase, and cost; collapsible iteration and end cards in the transcript.
- **Slash commands and tool** — the LLM and the user share one verb set, with tab completion for run ids and artifacts.

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) (the coding agent)
- [autoloop](https://github.com/mikeyobrien/autoloop) harness `>= 0.12.0` (installed as a dependency; in-session loops need its host worker API)
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

### In-session loop

```
/loop:run autocode Add rate limiting to the /api/upload endpoint
```

What happens:

1. The harness builds the run and asks the session for iteration 1. An `autoloop-iteration` card appears (expand it to read the role and iteration prompt) and the agent starts working.
2. The model's context for the iteration starts at that card. Earlier chat and earlier iterations stay in the transcript but leave the context.
3. The agent calls `autoloop_emit({ topic, payload })` and ends its reply. The harness routes the event, applies its guards, and the next iteration card is appended in the same agent run.
4. When the run completes or stops, an `autoloop-end` card summarises it. From then on the model sees the pre-loop chat plus that summary.

Controls while a loop is live:

| Input | Effect |
|-------|--------|
| Typing mid-iteration | Steers the current iteration |
| Typing between iterations | Lands in the next iteration |
| Esc | Pauses; the iteration stays open. Type to steer it, or `/loop:continue` |
| `/loop:guide <text>` | Durable operator guidance, injected into the next iteration prompt |
| `/loop:stop` | Stops the loop; the open iteration ends as interrupted |
| `/loop:resume <runId>` | Resumes an interrupted run in this session |

One loop runs per session. Pi compaction is held off while a loop is live. If pi exits mid-loop, the next session start closes the orphaned segment and suggests `/loop:resume <runId>`.

### Tool (LLM-callable)

```
autoloop({ action: "run", preset: "autocode", prompt: "Implement feature X" })                  # in-session
autoloop({ action: "run", preset: "autofix", prompt: "Flaky auth test", mode: "detached" })    # background CLI
autoloop({ action: "list" })
autoloop({ action: "status", runId: "clean-drift" })
autoloop({ action: "stop" })                                                                     # in-session loop
autoloop({ action: "stop", runId: "clean-drift" })                                               # detached run
autoloop({ action: "inspect", runId: "clean-drift", artifact: "scratchpad" })
autoloop({ action: "presets" })
autoloop_emit({ topic: "tasks.ready", payload: "3 tasks queued: …" })                           # inside an iteration
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/loop:run [--detached] <preset> <objective>` | Start a run (in-session by default) |
| `/loop:continue` | Continue a paused iteration |
| `/loop:guide <text>` | Queue guidance for the next iteration |
| `/loop:stop [runId]` | Stop the in-session loop, or a detached run by id |
| `/loop:resume <runId>` | Resume an interrupted run in this session |
| `/loop:list` | List all runs from the registry |
| `/loop:status [runId]` | Show run details (defaults to the live loop) |
| `/loop:inspect <runId> <artifact>` | Read scratchpad, journal, metrics, or memory |
| `/loop:presets` | List available presets |

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

The autoloop harness owns the loop: routing, guards, completion, journal, registry, and resume. pi-autoloop plugs in as its `host` worker, so each iteration is one stretch of the current pi agent run instead of a spawned backend process.

| File | Purpose |
|------|---------|
| `index.ts` | Wiring: pi hooks, tools, commands, dock |
| `session-loop.ts` | `SessionLoop`: the host worker and phase machine (`idle`, `working`, `paused`, `deciding`) behind the pi boundary hooks |
| `context-floor.ts` | Pure `projectLoopContext`: the per-iteration context reset, derived from marker messages alone |
| `markers.ts` | Iteration and end marker messages and their renderers |
| `emit-tool.ts` | The `autoloop_emit` tool |
| `restore.ts` | Closes loop segments orphaned by a dead session |
| `harness-adapter.ts` | The real harness port: preset resolution, `run`, `resume`, operator guidance |
| `host-types.ts` | Mirror of the harness host contract |
| `detached.ts` | Detached mode: spawns and tracks autoloop CLI processes |
| `tool.ts`, `render.ts`, `dock.ts`, `completions.ts`, `registry.ts`, `types.ts` | Tool schema, TUI rendering, dock widget, completion, registry reader, shared types |

An iteration ends at pi's `agent_before_settle` boundary once the model stops and no steering is queued, and only when the armed iteration's marker is in the settled context. The handler hands the result to the harness, waits for its decision, and appends the next marker with `continue: true` (or the end marker without it).

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:coverage
```

## License

MIT
