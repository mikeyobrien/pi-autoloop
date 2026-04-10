# pi-autoloop

A [pi](https://github.com/badlogic/pi-mono) extension that integrates [autoloop](https://github.com/mikeyobrien/autoloop) — an autonomous LLM loop harness — as a first-class tool with rich TUI rendering, live status widgets, and completion notifications.

## Features

- **Tool integration** — the LLM can start, monitor, stop, and inspect autoloop runs
- **Status widget** — themed single-line bar showing active/recent runs with iteration progress and elapsed time
- **Completion notifications** — colored ✓/✗ messages when runs finish, with configurable agent turn triggers
- **Rich rendering** — structured tool call/result display via ToolCallHeader/ToolBody (when [@aliou/pi-processes](https://github.com/aliou/pi-processes) is installed)
- **Slash commands** — `/loop:run`, `/loop:list`, `/loop:status`, `/loop:stop`, `/loop:inspect`, `/loop:presets` with tab completion
- **Event-driven** — EventEmitter-based manager keeps the UI reactive without polling from the extension layer

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) (the coding agent)
- [autoloop](https://github.com/mikeyobrien/autoloop) CLI installed and on `$PATH`
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
| `index.ts` | Extension entry: registers tool, events, widget, commands |
| `tool.ts` | Tool definition with TypeBox schema and action dispatch |
| `manager.ts` | Spawns/tracks autoloop child processes via EventEmitter |
| `render.ts` | TUI rendering: tool calls, results, widget, message renderer |
| `completions.ts` | Tab completion for slash commands |
| `registry.ts` | Reads `.autoloop/registry.jsonl` |
| `types.ts` | Shared TypeScript interfaces and constants |

Autoloop uses synchronous execution (`Atomics.wait`), so it runs as a child process to avoid freezing pi's event loop. Runs are independent — they survive pi session shutdown.

## License

MIT
