#!/usr/bin/env bash
# Gate 0 spike driver — starts pi with the spike loaded, sends 2 successive prompts
# in ONE session, and captures pane output so we can eyeball whether turn 2's model
# context was reset to the fresh seed (while TUI scrollback keeps turn 1).
#
# Usage:
#   ./spike/drive.sh                       # tmux TUI mode (default; eyeball scrollback)
#   MODE=rpc ./spike/drive.sh              # RPC mode (definitive agent_end signal)
#
# After it runs, inspect BOTH:
#   - the captured pane / rpc stdout (what the MODEL said each turn), and
#   - ./spike/gate0.log (what the extension RECEIVED vs RETURNED each context call).
#
# Provider/model: pass through PI_PROVIDER / PI_MODEL, default to the user's codex.

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SPIKE_DIR/.." && pwd)"
EXT="$SPIKE_DIR/gate0-extension.ts"
LOG="$SPIKE_DIR/gate0.log"
PROVIDER="${PI_PROVIDER:-openai-codex}"
MODEL="${PI_MODEL:-gpt-5.5}"
MODE="${MODE:-tmux}"

export GATE0_LOG="$LOG"
: > "$LOG"   # truncate previous run

PROMPT1='Turn 1. Follow the seed instructions exactly.'
PROMPT2='Turn 2. Follow the seed instructions exactly. Also: do you remember anything I said in Turn 1? Answer YES or NO and explain what you can see.'

if [[ "$MODE" == "rpc" ]]; then
  echo "[gate0] RPC mode, provider=$PROVIDER model=$MODEL" >&2
  python3 - "$EXT" "$PROVIDER" "$MODEL" "$PROMPT1" "$PROMPT2" <<'PY'
import json, subprocess, sys, threading
ext, provider, model, p1, p2 = sys.argv[1:6]
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", "-e", ext, "--provider", provider, "--model", model],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)
def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n"); proc.stdin.flush()

def wait_agent_end(tag):
    for line in proc.stdout:            # split on \n only (LF framing)
        line = line.rstrip("\r")
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except Exception:
            print(f"[{tag} raw] {line}"); continue
        t = e.get("type")
        if t in ("message_end", "message_update"):
            # print assistant text so we can read what the MODEL saw/said
            msgs = e.get("message") or {}
            print(f"[{tag} {t}] {json.dumps(msgs)[:600]}")
        elif t == "agent_end":
            print(f"[{tag} agent_end]"); return

send({"id": "1", "type": "prompt", "message": p1}); wait_agent_end("turn1")
send({"id": "2", "type": "prompt", "message": p2}); wait_agent_end("turn2")
send({"type": "quit"})
try: proc.wait(timeout=5)
except Exception: proc.kill()
PY
  echo "[gate0] done. Inspect $LOG" >&2
  exit 0
fi

# ---- tmux TUI mode ----
SESS="pi_gate0"
tmux kill-session -t "$SESS" 2>/dev/null || true
tmux new-session -d -s "$SESS" -x 220 -y 60 -c "$REPO_DIR"
echo "[gate0] launching pi (provider=$PROVIDER model=$MODEL)…" >&2
tmux send-keys -t "$SESS" "GATE0_LOG='$LOG' pi -e '$EXT' --provider '$PROVIDER' --model '$MODEL'" Enter

# Wait for the TUI to boot: poll for the editor prompt marker instead of a fixed sleep.
for i in $(seq 1 30); do
  sleep 1
  if tmux capture-pane -t "$SESS" -p 2>/dev/null | grep -q '›\|>\|Type'; then break; fi
done
sleep 3

# Turn 1
tmux send-keys -t "$SESS" "$PROMPT1"
tmux send-keys -t "$SESS" Enter
# let it stream + finish the tool round
for i in $(seq 1 40); do
  sleep 1
  grep -q '"event":"agent_end"' "$LOG" && break
done
sleep 2

# Turn 2 (same session — this is the fresh-context test)
tmux send-keys -t "$SESS" "$PROMPT2"
tmux send-keys -t "$SESS" Enter
# wait for the SECOND agent_end
for i in $(seq 1 40); do
  sleep 1
  [[ "$(grep -c '"event":"agent_end"' "$LOG")" -ge 2 ]] && break
done
sleep 2

echo "===== CAPTURED PANE (full scrollback) ====="
tmux capture-pane -t "$SESS" -p -S -4000
echo "===== END PANE ====="
tmux kill-session -t "$SESS" 2>/dev/null || true
echo "[gate0] done. Now inspect $LOG (context.swap vs context.passthrough)." >&2
