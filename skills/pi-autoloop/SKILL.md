---
description: Run autoloop presets (autocode, autofix, autoqa, …) inside this pi session with you as the worker, or detached in the background; covers starting a loop, working an iteration with autoloop_emit, and run inspection.
---

# pi-autoloop

An autoloop preset is a routed team of roles (planner, builder, reviewer, …) driven by the autoloop harness. By default the loop runs **in this session**: you are the worker for every iteration, and the user watches and steers live.

## Start a loop

```
autoloop({ action: "run", preset: "autocode", prompt: "Add input validation to the registration endpoint" })
```

The tool arms the loop and returns. End your reply right away; iteration 1 arrives as the next message.

Use a loop for multi-step work that benefits from role hand-offs and verification: features, refactors, bug hunts, test suites, audits. Handle single edits and quick questions directly.

Common presets: `autocode` (features, refactors), `autofix` (bugs), `autotest` (test suites), `autoqa` (hands-on validation), `autoreview` (code review), `autosec` (security audit). `action: "presets"` lists them all.

## Work an iteration

Each iteration starts with an `autoloop-iteration` message carrying the active role's prompt and the iteration prompt. Your context restarts at that message, so the prompt, the scratchpad, and the files are your whole memory of earlier iterations.

1. Do the work the role prompt asks for, with your normal tools.
2. Call `autoloop_emit({ topic, payload })` with one of the allowed events named in the prompt. `payload` is the hand-off summary for the next role.
3. If the emit fails, read the reason and the allowed events it lists, then emit again with an allowed topic.
4. End your reply. The harness routes the event and the next iteration message follows.

User messages that arrive mid-iteration are steering for the current iteration; fold them into the work.

## Detached runs

`mode: "detached"` spawns the autoloop CLI in the background with the preset's own backend. Use it only when the user asks for a background or parallel run that must survive this session. Detached-only options: `backend`, `worktree`, `verbose`.

## Other actions

| Action | Params | Result |
|--------|--------|--------|
| `list` | — | Runs from `.autoloop/registry.jsonl` |
| `status` | `runId` | Iteration, latest event, and the `journal` / `state_dir` / `work_dir` paths to read with your file tools |
| `stop` | `runId` (omit for the in-session loop) | Stops the run |
| `inspect` | `runId`, `artifact` | `scratchpad`, `journal`, `metrics`, or `memory` |
| `presets` | — | Available presets |
