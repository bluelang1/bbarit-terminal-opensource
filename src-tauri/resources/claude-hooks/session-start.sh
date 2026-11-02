#!/bin/sh
# BBARIT Terminal: Claude Code SessionStart hook (docs/CLAUDE_SESSION_HOOK.md).
# Loaded only through `claude --settings <bundled bbarit-session.json>` in app tabs.
# Reads the hook JSON on stdin and reports this tab's session id to the local
# bridge so the next launch can `--resume <id>`. POSIX sh + sed + curl only.
# Never blocks Claude: every failure path exits 0, and nothing goes to stdout
# (SessionStart stdout would be added to the conversation context).

[ -n "$BBARIT_BRIDGE_PORT" ] || exit 0
[ -n "$BBARIT_TERMINAL_ID" ] || exit 0

# Join stdin into one line so each key can be matched with a single sed pass.
input=$(sed -n '1h;1!H;${x;s/[[:cntrl:]]/ /g;p;}' 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

# Subagent sessions carry agent_id; only the tab's own session is reported.
case "$input" in
  *'"agent_id"'*) exit 0 ;;
esac

json_str() {
  # JSON string body with escapes kept verbatim (\" and \\ stay escaped), so the
  # value can be embedded in the outgoing JSON as-is. Pure BRE for BSD sed.
  printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\(\\\\.[^\"\\\\]*\)*\)\".*/\1/p" 2>/dev/null
}

sid=$(json_str session_id)
[ -n "$sid" ] || exit 0
tp=$(json_str transcript_path)
src=$(json_str source)

curl -s -m 2 --noproxy '*' -o /dev/null -X POST "http://127.0.0.1:${BBARIT_BRIDGE_PORT}/api/claude-session" \
  -H 'Content-Type: application/json' \
  -d "{\"terminalId\":\"$BBARIT_TERMINAL_ID\",\"sessionId\":\"$sid\",\"transcriptPath\":\"$tp\",\"source\":\"$src\"}" \
  >/dev/null 2>&1
exit 0
