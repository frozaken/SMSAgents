#!/usr/bin/env bash
# Two-session SMSAgents handshake experiment for Claude Code.
#
# Demonstrates, with two real `claude -p` sessions sharing one SQLite mailbox:
#   1. Stable agent identity across resume (session B keeps its agent_id).
#   2. Hook-driven message injection at session resume (B receives A's question
#      without calling check_inbox itself).
#   3. Stop-hook wake-up: A ends its turn after asking, its Stop hook holds the
#      session open, and B's reply un-blocks A without any model polling.
#
# Requires: claude (logged in), node >= 22.5, sqlite3. Run from anywhere.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/smsagents"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/smsagents-exp.XXXXXX")"
KEEP_ARTIFACTS=0
cleanup() {
  if [ "$KEEP_ARTIFACTS" = 1 ]; then
    echo "Artifacts preserved in $WORK_DIR"
    for f in "$WORK_DIR"/*.err; do [ -s "$f" ] && { echo "--- $f"; tail -5 "$f"; }; done
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

export SMSAGENTS_DB_PATH="$WORK_DIR/mailbox.sqlite"
export SMSAGENTS_TOPICS="exp:handshake"
export SMSAGENTS_LISTEN_SECONDS="${SMSAGENTS_LISTEN_SECONDS:-120}"

TOOLS="mcp__plugin_smsagents_smsagents__register_agent,mcp__plugin_smsagents_smsagents__join_topic,mcp__plugin_smsagents_smsagents__send_message,mcp__plugin_smsagents_smsagents__check_inbox,mcp__plugin_smsagents_smsagents__ack_messages,mcp__plugin_smsagents_smsagents__topic_status"
MODEL_ARGS=()
[ -n "${SMS_EXP_MODEL:-}" ] && MODEL_ARGS=(--model "$SMS_EXP_MODEL")

run_claude() { # run_claude <output-file> [extra args...] <prompt>
  local out="$1"; shift
  local prompt="${@: -1}"
  set -- "${@:1:$#-1}"
  (cd "$WORK_DIR" && claude -p "$prompt" --plugin-dir "$PLUGIN_DIR" \
    --allowedTools "$TOOLS" --output-format json "${MODEL_ARGS[@]}" "$@" > "$out" 2> "$out.err")
}

json_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ''))" "$1" "$2"; }

echo "== Step 1: prime session B (registers + auto-subscribes via hooks, then idles)"
run_claude "$WORK_DIR/b1.json" "You are session B in an SMSAgents two-session experiment. Your lifecycle hooks already registered you and subscribed you to topic exp:handshake. Do not call any tools. Reply with exactly: WAITING"
SESSION_B="$(json_field "$WORK_DIR/b1.json" session_id)"
echo "   session B = $SESSION_B"

echo "== Step 2: launch session A in the background (asks a question, then stops)"
run_claude "$WORK_DIR/a.json" "You are session A in an SMSAgents two-session experiment. Your lifecycle hooks already registered you and subscribed you to topic exp:handshake; your agent_id is in your session context. Call send_message once with topic 'exp:handshake', kind 'question', body 'What is the handshake code?'. Then end your turn immediately without waiting or calling further tools. Later, when an answer is delivered to you, acknowledge it with ack_messages and finish with a sentence that contains the handshake code verbatim." &
A_PID=$!

echo "== Step 3: wait for A's question to reach the mailbox"
for _ in $(seq 1 60); do
  COUNT="$(sqlite3 "$SMSAGENTS_DB_PATH" "SELECT count(*) FROM messages WHERE topic='exp:handshake' AND kind='question';" 2>/dev/null || echo 0)"
  [ "$COUNT" -ge 1 ] && break
  sleep 2
done
[ "${COUNT:-0}" -ge 1 ] || { echo "FAIL: session A never published its question"; KEEP_ARTIFACTS=1; kill "$A_PID" 2>/dev/null || true; exit 1; }
echo "   question published"

echo "== Step 4: resume session B; hooks inject the pending question, B answers"
run_claude "$WORK_DIR/b2.json" --resume "$SESSION_B" "Check the SMSAgents context injected into this session. If a question was delivered, answer it: call send_message with topic 'exp:handshake', kind 'answer', reply_to set to the question's message id, body 'The handshake code is OCTOPUS-42.'. Then call ack_messages for the question and stop."

echo "== Step 5: wait for session A to wake up and finish"
wait "$A_PID" || true

A_RESULT="$(json_field "$WORK_DIR/a.json" result)"
ANSWERS="$(sqlite3 "$SMSAGENTS_DB_PATH" "SELECT count(*) FROM messages a JOIN messages q ON a.reply_to=q.id WHERE a.kind='answer' AND q.kind='question';")"
UNACKED="$(sqlite3 "$SMSAGENTS_DB_PATH" "SELECT count(*) FROM deliveries WHERE acked_at IS NULL;")"

echo
echo "== Results"
echo "   answers linked to the question: $ANSWERS"
echo "   unacknowledged deliveries:      $UNACKED"
echo "   session A final message:        $A_RESULT"

PASS=1
[ "$ANSWERS" -ge 1 ] || { echo "FAIL: no answer linked to the question"; PASS=0; }
case "$A_RESULT" in *OCTOPUS-42*) ;; *) echo "FAIL: session A did not surface the handshake code"; PASS=0;; esac
if [ "$PASS" -eq 1 ]; then
  echo "PASS: stop-hook wake-up delivered B's answer into A's turn."
else
  KEEP_ARTIFACTS=1
  exit 1
fi
