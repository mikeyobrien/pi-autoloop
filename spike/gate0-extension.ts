// Gate 0 spike for pi-autoloop native-loop redesign — THROWAWAY.
//
// Proves the 4 Gate 0 claims about pi's `context` event and `before_agent_start`:
//   (1) The `context` handler can return a replacement messages[] that omits prior
//       turns, and the model demonstrably only sees the fresh seed.
//   (2) Within an iteration, tool rounds still work (tool-call/result pairing
//       survives the swap) — because we only swap when we haven't already emitted
//       this iteration's tool rounds (idempotent per iteration).
//   (3) Swapped-out history still renders in TUI scrollback (model sees fresh).
//   (4) before_agent_start systemPrompt append composes with the above.
//
// HOW TO OBSERVE FROM OUTSIDE:
//   - This extension writes a JSONL log to $GATE0_LOG (default ./spike/gate0.log)
//     recording, for every `context` call, the messages[] it RECEIVED (roles + a
//     hash/preview) and the messages[] it RETURNED. If the swap works, the model's
//     provider request is built from the RETURNED array (see agent-loop.js:174-179).
//   - We ALSO log the RECEIVED array so you can see pi's session-canonical list keeps
//     growing across turns even though we hand the model a 1-message seed. That is the
//     model-vs-TUI split, observable in one file.
//   - The seed embeds a SECRET TOKEN and instructs the model to echo it, plus asks the
//     model to report how many prior user turns it can see. Turn 2's transcript should
//     show the model unable to see turn 1 (fresh context), while the log's RECEIVED
//     array for turn 2 contains turn 1 (TUI/session intact).
//
// Import from @mariozechner/* to match the repo's existing specifiers; pi's extension
// loader aliases @mariozechner/* and @earendil-works/* to the same bundled modules
// (verified in dist/core/extensions/loader.js:45-50).

import { Type } from "@sinclair/typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ContextEvent,
  ContextEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  AgentEndEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-ai";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const LOG_PATH = process.env.GATE0_LOG || "./spike/gate0.log";
const SECRET = "GATE0-SEED-TOKEN-7Q";

function log(entry: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    /* best-effort */
  }
}

function hashOf(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

// Cheap structural preview of an AgentMessage[] so the log is readable AND we can
// tell whether tool-call/tool-result pairs survived a swap.
function preview(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const anyM = m as any;
    let text = "";
    if (typeof anyM.content === "string") text = anyM.content;
    else if (Array.isArray(anyM.content)) {
      text = anyM.content
        .map((c: any) => (c?.type === "text" ? c.text : `<${c?.type}>`))
        .join(" ");
    }
    return {
      role: anyM.role,
      customType: anyM.customType,
      // surface tool linkage so claim (2) is inspectable
      toolCalls: Array.isArray(anyM.toolCalls)
        ? anyM.toolCalls.map((t: any) => ({ id: t.id, name: t.name }))
        : undefined,
      toolCallId: anyM.toolCallId,
      len: text.length,
      head: text.slice(0, 80),
      hash: hashOf(text),
    };
  });
}

// The freshly-assembled seed the model should see EACH iteration. In the real driver
// this is buildIterationContext(loop, i).prompt. Here it is a static probe.
function buildSeed(iteration: number): string {
  return [
    `[GATE0 SEED — iteration ${iteration}]`,
    `Secret token: ${SECRET}`,
    ``,
    `You are in a fresh-context probe. Do the following IN ORDER, briefly:`,
    `1. Echo the secret token exactly.`,
    `2. State how many DISTINCT earlier user messages you can see in this`,
    `   conversation BEFORE this one. If you see none, say "PRIOR_TURNS=0".`,
    `3. Call the tool "gate0_probe" once with note="tool round ${iteration}"`,
    `   to prove a tool round works, then report the tool's reply verbatim.`,
  ].join("\n");
}

// Iteration counter, bumped on agent_end. Starts at 1 (matches repo's 1-indexed runs).
let iteration = 1;

export default function gate0(pi: ExtensionAPI) {
  log({ event: "loaded", pid: process.pid, logPath: LOG_PATH });

  // (4) Append a stable marker to the system prompt (prompt-cache friendly).
  pi.on(
    "before_agent_start",
    (event: BeforeAgentStartEvent, _ctx: ExtensionContext): BeforeAgentStartEventResult => {
      const marker =
        "\n\n## GATE0 HARNESS\n" +
        `You are the worker in an autonomous loop (gate0 probe). Marker: ${SECRET}-SYS.`;
      log({
        event: "before_agent_start",
        incomingSystemPromptLen: event.systemPrompt.length,
        incomingPrompt: event.prompt?.slice(0, 120),
      });
      // APPEND: read + concatenate (no dedicated append field; chained across exts).
      return { systemPrompt: event.systemPrompt + marker };
    },
  );

  // (1)+(2)+(3) The heart of the spike: replace the model-facing messages[] with a
  // single fresh seed that OMITS all prior turns.
  //
  // KEY SUBTLETY for claim (2): `context` fires before EVERY LLM call within a turn,
  // including the follow-up call after a tool result. If we blindly returned only the
  // seed on the follow-up call, we would ERASE the in-progress tool-call/tool-result
  // pair and the provider would reject (dangling toolResult / lost toolCall). So we
  // detect whether the RECEIVED array already contains this turn's assistant tool
  // round; if it does, we PASS THROUGH (return nothing) so the tool loop completes.
  //
  // Detection: the received array (event.messages) is the session-canonical list.
  // The last message being an assistant with toolCalls, or a trailing toolResult,
  // means we are mid-tool-round — do not swap.
  pi.on(
    "context",
    (event: ContextEvent, _ctx: ExtensionContext): ContextEventResult | void => {
      const msgs = event.messages;
      const last = msgs[msgs.length - 1] as any;
      const midToolRound =
        last &&
        ((last.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length > 0) ||
          last.role === "toolResult" ||
          last.toolCallId != null);

      if (midToolRound) {
        // PASS THROUGH — let the tool-call/result pair survive so the model can
        // consume the tool output within this iteration. (claim 2)
        log({
          event: "context.passthrough",
          iteration,
          reason: "mid-tool-round",
          receivedRoles: msgs.map((m: any) => m.role),
          received: preview(msgs),
        });
        return; // undefined => original messages used (agent-loop.js:176 fallback)
      }

      // FRESH SWAP — drop all prior turns, hand the model one seed user message.
      const seedText = buildSeed(iteration);
      const seed: AgentMessage[] = [
        { role: "user", content: seedText, timestamp: Date.now() } as AgentMessage,
      ];
      log({
        event: "context.swap",
        iteration,
        // RECEIVED = session-canonical list (grows every turn => TUI intact, claim 3)
        receivedCount: msgs.length,
        receivedRoles: msgs.map((m: any) => m.role),
        received: preview(msgs),
        // RETURNED = what the model actually sees this call (claim 1)
        returnedCount: seed.length,
        returned: preview(seed),
        seedHash: hashOf(seedText),
      });
      return { messages: seed };
    },
  );

  // Minimal tool so claim (2) has a real tool round to exercise.
  pi.registerTool({
    name: "gate0_probe",
    label: "Gate0 Probe",
    description: "Gate 0 spike probe tool. Returns a fixed acknowledgement.",
    parameters: Type.Object({ note: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const reply = `GATE0_TOOL_OK note=${(params as any).note} token=${SECRET}`;
      log({ event: "tool.execute", iteration, note: (params as any).note });
      return { content: [{ type: "text", text: reply }] };
    },
  });

  // Iteration boundary: bump the counter so the NEXT turn's seed changes. We do NOT
  // self-drive here (the operator sends the 2 prompts manually) to keep the spike
  // observable; the real driver would sendUserMessage here.
  pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
    const usage = ctx.getContextUsage();
    log({
      event: "agent_end",
      iterationCompleted: iteration,
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
    });
    iteration += 1;
  });
}
