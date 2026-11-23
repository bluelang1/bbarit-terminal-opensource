#!/bin/sh
# BBARIT Terminal: Claude Code StopFailure hook (docs/MODEL_LIMIT_FALLBACK.md).
# Loaded only through `claude --settings <bundled bbarit-session.json>` in app tabs.
# When a turn ends on a rate limit (`"error":"rate_limit"`), reports it with the limit
# message to the local bridge so the app can switch this tab to the fallback model.
# POSIX sh + sed + curl only. Every failure path exits 0 and nothing goes to stdout.

[ -n "$BBARIT_BRIDGE_PORT" ] || exit 0
[ -n "$BBARIT_TERMINAL_ID" ] || exit 0

input=$(sed -n '1h;1!H;${x;s/[[:cntrl:]]/ /g;p;}' 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

# Subagent turns carry agent_id; only the tab's own session counts.
case "$input" in
  *'"agent_id"'*) exit 0 ;;
esac

json_str() {
  printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\(\\\\.[^\"\\\\]*\)*\)\".*/\1/p" 2>/dev/null
}

err=$(json_str error)
[ "$err" = "rate_limit" ] || exit 0
sid=$(json_str session_id)
msg=$(json_str last_assistant_message)

curl -s -m 2 --noproxy '*' -o /dev/null -X POST "http://127.0.0.1:${BBARIT_BRIDGE_PORT}/api/claude-limit" \
  -H 'Content-Type: application/json' \
  -d "{\"terminalId\":\"$BBARIT_TERMINAL_ID\",\"sessionId\":\"$sid\",\"error\":\"$err\",\"message\":\"$msg\"}" \
  >/dev/null 2>&1
exit 0
