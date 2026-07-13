# Gate 0 spike — pi `context`-event fresh-context proof (THROWAWAY)

Proves the four Gate 0 claims from `NATIVE_LOOP_PLAN.md` §3 against the **installed**
pi (`@earendil-works/pi-coding-agent@0.80.2`) before we build the native driver.

## What it proves

1. **Model sees only the fresh seed.** The `context` handler returns a replacement
   `messages[]` containing a single seed user message; all prior turns are dropped.
   Verified model-only in `pi-agent-core/dist/agent-loop.js:174-179` — the transformed
   list feeds `convertToLlm` (→ provider) while `context.messages` (session/TUI) is
   never reassigned.
2. **Tool rounds survive.** `context` fires before *every* LLM call in a turn. The
   handler detects a mid-tool-round (last message is an assistant with `toolCalls`, or
   a trailing `toolResult`) and **passes through** so the tool-call/result pair is not
   erased. Only the iteration-boundary call gets the fresh swap.
3. **TUI scrollback intact.** The handler logs the RECEIVED array (session-canonical,
   grows every turn) next to the RETURNED array (1-message seed). The growing RECEIVED
   array is the proof the TUI/session still has full history.
4. **`before_agent_start` composes.** A stable marker is appended to the system prompt
   and logged; it coexists with the per-turn `messages[]` swap.

## Files

- `gate0-extension.ts` — the spike extension (imports `@mariozechner/*`; pi aliases it
  to the bundled `@earendil-works/*` — see `loader.js:45-50`).
- `drive.sh` — launches pi with the spike, sends 2 prompts in one session, captures
  output. `MODE=rpc ./drive.sh` for a definitive `agent_end`-framed run.
- `gate0.log` — JSONL written by the extension (created on run). The primary artifact.

## Read the result

Two independent observations must both hold:

**A. From `spike/gate0.log`** (what the extension did):
```
# every context call: swap (fresh) or passthrough (mid-tool-round)
grep -o '"event":"context\.[a-z]*"' spike/gate0.log | sort | uniq -c
# turn 2's swap should show receivedCount > 1 (history present) but returnedCount == 1
grep '"event":"context.swap"' spike/gate0.log | tail -1 | python3 -m json.tool
```
- `context.swap` with `returnedCount: 1` and a large `receivedRoles` list on turn 2 =
  claims 1 + 3.
- at least one `context.passthrough reason=mid-tool-round` per turn = claim 2 held the
  tool pair together.
- a `before_agent_start` entry with a nonzero `incomingSystemPromptLen` = claim 4.

**B. From the captured pane / RPC stdout** (what the MODEL said):
- Turn 2 should answer that it can see **no** earlier user turns
  (`PRIOR_TURNS=0`) and should NOT recall Turn 1 content — even though the TUI
  scrollback (and `gate0.log` RECEIVED array) still contains Turn 1.
- Both turns should echo the secret token and report `GATE0_TOOL_OK` from the tool,
  proving the tool round completed after the swap.

## Pass / fail

- **PASS (mechanism b viable):** log shows swap+passthrough as above AND the model in
  turn 2 cannot see turn 1. Proceed with the `context`-event driver.
- **FAIL:** provider rejects the swapped array (malformed), OR turn 2's model still
  recalls turn 1 (swap not applied to provider), OR tool rounds break. Then fall back
  to mechanism (a) `newSession`-per-iteration (command-context driven).
