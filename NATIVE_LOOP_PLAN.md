# pi-autoloop → Native In-Pi Loop: Design & Plan

> Status: **Gate 0 PASSED + v1 implementation and live smoke COMPLETE (2026-07-13).**
> The native driver, `loop_*` tools, system-prompt split, re-pointed tool/command surface,
> and event-driven dock/renderer are all built and verified: strict typecheck against
> installed `@mobrienv/autoloop*@0.8.0`, headless exercise of the full engine lifecycle
> (`buildLoopContext`→`buildIterationContext`→`emit`→journal/registry), and a live
> extension-load smoke test under pi's RPC loader (all `/loop:*` commands + tools register).
> A real tmux/Pi run now exercises planner → builder → critic → finalizer, fresh context
> across tool rounds, native backend metadata, terminal registry state, status rendering,
> and clean teardown. Re-run it with `npm run smoke:native`; artifacts are written under
> the system temporary directory. `/loop:pause` remains descoped (see §5).
> See "Gate 0 — RESULT" below for what the live spike proved and the one refinement it forced.

> Status (original): agreed design, pre-spike. Build is gated behind the Gate 0 spike below.
> Goal: make pi-autoloop drive autonomous loops **inside pi's own session** — pi's
> model/tools/context do the work — instead of spawning the `autoloop` CLI as an
> independent child process.

## 1. The shift

**Today:** `autoloop` is the orchestrator; pi is one of its *backends*. The extension
spawns `autoloop run …` as an independent child process, parses its stdout `[progress]`
lines, and polls `.autoloop/registry.jsonl`. The loop lives entirely outside pi; pi never
sees it. (`autoloop pi-adapter` even runs pi headless in a `pi-stream`/`pi-review` print
mode, one prompt per iteration.)

**Target:** the extension *is* the orchestrator and **pi's interactive session is the
worker**. Iteration counting, context resets, role routing, and completion all execute
from within pi. The `autoloop` engine is reused as a **library**, not a subprocess.

## 2. Decisions (the design tree)

### Architecture
1. **Native driver, pi's session is the worker.** Not the embedded-SDK-with-separate-backend
   option — pi's own model, tools, and context window do the actual work.
2. **Passenger model.** A running loop monopolizes the single pi session. The user can
   **watch / stop / steer**, one loop per pi instance, and the **loop dies with pi**
   (no independent-process survival). This is a deliberate regression from today's
   "runs survive pi shutdown," inherent to "the loop *is* the session."
3. **Reuse autoloop's engine as a library** (`@mobrienv/autoloop` `^0.8.0`). Drop the
   spawn / stdout-parse / registry-poll path. Keep the `autoloop` CLI only for operator
   surfaces it already nails (`inspect`, `dashboard`, `kanban`). **We own only** the pi
   `iterate` executor + the `context`-event integration.

   Reused library seams (confirmed on 0.7.4, re-verify on 0.8.0 in the spike):
   - `runIteration(loop, iteration, iterate)` — the executor is an **injected callback**.
   - `buildIterationContext(loop, iteration)` / `renderIterationPromptText` /
     `renderReviewPromptText` (`@mobrienv/autoloop-harness/prompt`) — per-iteration context
     assembly with separate `memoryText` / `scratchpadText` / `roleAgent` fields.
   - `emit(projectDir, topic, payload)` (`autoloop-harness/emit`),
     `memory.addLearning` / `addRunLearning`, `tasks.addTask` / `completeTask`
     (`autoloop-core/{memory,tasks}`) — pure file ops the engine reads back.
   - `journal`, `scratchpad`, `metrics`, `registry`, `config`/`loadProjectConfig`.

### Loop body
4. **Iteration = one role's turn.** Autoloop is a multi-role topology
   (planner → builder → critic → finalizer), engine-routed. `agent_end` is the iteration
   boundary; the engine's `finishIteration` reads emitted events and computes
   routing/outcome/completion.
5. **Fresh context every iteration** (autoloop's defining behavior — not threshold-based).
   - **Mechanism (b), chosen:** swap the *model-facing* `messages[]` via pi's `context`
     event. At each iteration boundary, everything before the current iteration is replaced
     by the freshly-assembled seed; the in-progress iteration's own messages (prompt + tool
     rounds) pass through. **Model sees fresh context; user keeps continuous TUI scrollback.**
   - **Fallback (a):** `newSession`-per-iteration (accepts scrollback clearing + session-file
     churn) — only if the spike shows (b) is infeasible.
   - "Context management" here = per-iteration **context assembly/budgeting** from artifacts
     (`memory.prompt_budget_chars`, etc.), not pi's summarizer.
6. **Native `loop_*` tools wrapping the library functions.** Register `loop_emit` /
   `loop_memory` / `loop_task` pi tools whose `execute` calls `emit` / `memory.add*` /
   `tasks.*` in-process. File side-effects are byte-identical to `autoloop emit …`, so the
   engine's routing/completion stays 100% intact — **native tools without forking the
   protocol.** Presets' `{{TOOL_PATH}} emit X` instructions are redirected to the native
   tools via a **central preamble override** (one preset-agnostic block) in v1; the proper
   fix is a first-class **`tool_mode="native"`** rendering path upstream in autoloop
   (we maintain autoloop, so this is in-bounds).
7. **System-prompt split.** Static harness rules + role boundaries + tool preamble are
   appended to pi's base system prompt via `before_agent_start` (stable → prompt-cache
   friendly). Only the dynamic per-iteration context (active role + objective + budgeted
   memory + tasks + scratchpad + recent routing events) goes in the swapped seed. Use
   `buildIterationContext`'s separate fields to control the split.

### Driver & UX
8. **Event-driven state machine.** Mechanism (b) needs no `newSession`, so the driver needs
   no command context. On `agent_end` → `finishIteration` → if continue, `sendUserMessage`
   the next seed; if `task.complete` + required events satisfied, stop. Startable from the
   LLM `autoloop` tool **or** `/loop:run`. **LLM self-takeover allowed** (idle-guarded;
   the starting tool call returns immediately with a "now in loop mode" notice;
   `/loop:stop` always reclaims control). A "loop active / awaiting-iteration" flag
   distinguishes loop-driven turns from the user's own input.
9. **Steering via pi-native input/queue.** No autoloop `drainGuidance`. The passenger types
   in pi's normal input; pi's `deliverAs: "steer"` (mid-turn) and follow-up queue handle
   delivery; the driver **yields to / merges** pending user input at the iteration boundary.
10. **Lifecycle:** v1 **stops cleanly** — mark the run `interrupted` on `session_shutdown`,
    artifacts intact, re-runnable. `/loop:resume` is designed-for but **deferred** (the
    journal already persists everything needed; don't introduce non-reconstructable
    in-memory state).
11. **No worktree.** Native loops run in the session's cwd; isolation, if wanted, is the
    user launching pi inside a worktree. git + the harness's per-slice commits + `/loop:stop`
    are the safety net.
12. **Surface:** `run` / `stop` / `status` / `list` / `inspect` / `presets` on both the LLM
    `autoloop` tool and `/loop:*`, re-pointed from registry-polling to the in-process engine
    (CLI still fine for `inspect`/`dashboard`). Old child-process registry entries stay
    readable. Dock + completion renderer driven by in-process state-machine events (reuse
    `dock.ts`/`render.ts`, swap the data source); show iteration n/max + active role + last
    event + elapsed; per-iteration markers in scrollback. Session model used for all roles.

## 3. Gate 0 — Spike (build nothing else until this passes)

A throwaway extension proving, against autoloop `^0.8.0`:
1. The `context` handler can return a replacement `messages[]` that omits prior turns, and
   the model demonstrably only sees the fresh seed.
2. Within an iteration, tool rounds still work (tool-call/result pairing survives the swap).
3. Swapped-out history still renders in TUI scrollback (user sees continuity; model sees fresh).
4. `before_agent_start` system-prompt append composes with the above.
5. Re-verify library seams on 0.8.0: `runIteration`, `buildIterationContext`,
   `emit` / `memory` / `tasks`.

If (1)–(3) fail → fall back to mechanism (a) `newSession`-per-iteration before proceeding.

## 3a. Gate 0 — RESULT (2026-06-30, PASSED)

Ran a throwaway spike (`spike/gate0-extension.ts` + `spike/drive.sh`) live on
**openai-codex/gpt-5.5** (pi = `@earendil-works/pi-coding-agent@0.80.2`, the
`@mariozechner/*` import specifier is a loader alias). Decisive log evidence:

| Call | session-canonical (RECEIVED = TUI/scrollback) | sent to model (RETURNED) |
|---|---|---|
| Turn 2, first LLM call | 5 messages (all of turn 1 + turn 2 prompt) | **1 — the seed only** |

- **Claim 1 & 3 (fresh model context + continuous scrollback): PROVEN.** The `context`
  handler's returned `{messages}` replaces the *provider-facing* transcript only;
  `context.messages` (what the TUI/session render from) is never reassigned
  (`agent-harness.js:339-341`, `agent-loop.js:174-201`). Model sees the seed; scrollback grows.
- **Claim 4 (before_agent_start systemPrompt append): PROVEN** (composed both turns).
- **Claim 2 (tool rounds survive): PROVEN with a required refinement.**

**Refinement the live run forced (was invisible to type-reading):** `context` fires
before *every* LLM call in a turn. A naive "pass through the original array when
mid-tool-round" leaks the *entire prior history* back to the model (turn 2's model
briefly saw turn 1). **Fix, now canonical for v1:** the handler returns
`messages.slice(watermark)` where `watermark` = the session index of *this* iteration's
seed user message. First LLM call → `[seed]`; mid-tool-round → `[seed, assistant+toolCall,
toolResult]` (valid pairing preserved, prior iterations dropped). Never fall back to the
full array.

**Library drift corrected against installed 0.8.0** (all three packages published & installed):
- `runIteration` is **not** an injectable executor — it hardcodes a subprocess worker.
  Driver composes `buildIterationContext(loop,i)` → drive pi → `finishIteration(loop,iter,output,iterate)`
  with its own recursive `iterate`. `finishIteration`/`resolveOutcome` are clean exports.
- Seams live across `@mobrienv/autoloop` + `-harness` + `-core` (subpath exports):
  `config-helpers.buildLoopContext`/`initStore`/`installRuntimeTools`,
  `iteration.finishIteration`, `prompt.buildIterationContext`,
  `parallel.append{LoopStart,IterationStart,BackendStart,BackendFinish,IterationFinish}`
  (byte-identical journal), `registry-bridge.registryStart`, `emit.emit`,
  `core/memory.{addLearning,addRunLearning}`, `core/tasks.{addTask,completeTask}`.
- 0.8.0 adds a `control/` supervisor subsystem (`control/adapter`, `control/pi-adapter`,
  dispatch/queue/capabilities) — a backend-neutral stop/steer seam; useful later, deferred for v1.
- Seed mechanism refined: `sendUserMessage(iter.prompt)` starts each iteration (real user
  message → scrollback boundary); watermark set at its index. No synthetic seed messages.

## 4. v1 scope (after Gate 0)

- Native event-state-machine driver; engine-as-library; `iterate` drives pi's session via
  the proven mechanism.
- Native `loop_emit` / `loop_memory` / `loop_task` tools + central-preamble override.
- System-prompt split via `before_agent_start`.
- **`autocode` preset end-to-end first**, then fan out the rest (they're just config).
- Re-pointed `run`/`stop`/`status`/`list`/`inspect`/`presets` on tool + `/loop:*`;
  self-takeover start; `/loop:stop`, `/loop:pause`.
- Dock + completion renderer on in-process events.
- Session model for all roles.

## 5. Deferred (designed-for, not built)

`/loop:resume` · `/loop:pause` (descoped from §4: under the passenger model "the loop
*is* the session," so pause ≈ stop-without-teardown — deferred until a concrete need
distinguishes it from `/loop:stop`) · per-role tool/model gating · worktree isolation ·
upstream `tool_mode="native"` in autoloop · native pretty-wrapper tools beyond the three.

## 6. Relevant pi `ExtensionAPI` facts

- Drive turns: `pi.sendUserMessage(content, {deliverAs})`, `pi.sendMessage({…}, {triggerTurn})`.
- Boundaries/idle: `agent_end`, `turn_end` events; `ctx.isIdle()`; `waitForIdle()` (command ctx).
- Context: `context` event (**replace `messages[]`**); `ctx.getContextUsage()`; `ctx.compact()`.
- Session control (command context only): `newSession`, `fork`, `navigateTree({summarize})`.
- Prompt/tools/model: `before_agent_start` (**replace/append systemPrompt**); `setActiveTools`;
  `setModel`; `setThinkingLevel`.
