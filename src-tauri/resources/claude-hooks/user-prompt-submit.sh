#!/bin/sh
# BBARIT Terminal: Claude Code UserPromptSubmit hook (docs/AGENT_RELAY.md "Lead mode").
# Loaded only through `claude --settings <bundled bbarit-session.json>` in app tabs.
# When the submitted prompt contains the lead phrase (Settings → "Lead agent phrase",
# `agents.leadPhrase`, or the English default "proceed as the lead agent"), prints
# hookSpecificOutput.additionalContext telling Claude to run the request as the lead of a
# BBARIT tab team. The phrases come from the app's local bridge (GET /api/agent-lead), which
# answers nothing while "Agent team in tabs" is off, so a stopped app or a turned-off team adds
# nothing. POSIX sh + sed + tr + curl only. Every path exits 0; the prompt is never written
# anywhere (not to the bridge, not to a log).

[ -n "$BBARIT_BRIDGE_PORT" ] || exit 0

# Join stdin into one line (control characters become spaces).
input=$(sed -n '1h;1!H;${x;s/[[:cntrl:]]/ /g;p;}' 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

# The "prompt" string body, escapes kept verbatim (the phrases are sent JSON-escaped too).
prompt=$(printf '%s' "$input" | sed -n "s/.*\"prompt\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\(\\\\.[^\"\\\\]*\)*\)\".*/\1/p" 2>/dev/null)
[ -n "$prompt" ] || exit 0

# Same normalisation as the bridge (bytes, C locale): escaped backslashes are kept aside, JSON
# whitespace escapes (\n \r \t), tabs, NBSP and U+3000 become spaces, runs of spaces become one,
# ASCII letters are lower-cased (Korean text is left as it is).
bs=$(printf '\001')
nbsp=$(printf '\302\240')
ideo=$(printf '\343\200\200')
norm=$(printf ' %s ' "$prompt" | LC_ALL=C sed -e "s/\\\\\\\\/$bs/g" -e 's/\\[nrt]/ /g' -e "s/$bs/\\\\\\\\/g" -e "s/$nbsp/ /g" -e "s/$ideo/ /g" 2>/dev/null \
  | LC_ALL=C tr '\t' ' ' 2>/dev/null | LC_ALL=C tr -s ' ' 2>/dev/null \
  | LC_ALL=C tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz' 2>/dev/null)
[ -n "$norm" ] || exit 0

# Text the relay types into tabs (child briefs, <bbarit from=… state=…> notes, agent send
# messages from another tab) always starts with "<bbarit": never a lead request.
case "$norm" in
  ' <bbarit'*) exit 0 ;;
esac

phrases=$(curl -s -f --connect-timeout 0.3 -m 0.7 --noproxy '*' "http://127.0.0.1:${BBARIT_BRIDGE_PORT}/api/agent-lead" 2>/dev/null) || exit 0
[ -n "$phrases" ] || exit 0

match=
while IFS= read -r phrase; do
  [ -n "$phrase" ] || continue
  case "$norm" in
    *"$phrase"*) match=1; break ;;
  esac
done <<PHRASES
$phrases
PHRASES
[ -n "$match" ] || exit 0

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"BBARIT lead mode: for this request this tab is the lead of a BBARIT tab team (the user typed the lead phrase). Load the bbarit-agents skill and follow its \"Lead mode\" section: plan the work as team tasks, start a few child agents in their own tabs with node \"$BBARIT_CTL\" agent run, run and gate them until the goal is met (pull model: you add tasks with a role label and start one child per role; the children claim tasks with agent task claim --next --label <role>, record results and submit them for your approve or reject), then report what was done, the evidence (test output) and what is left. Rules: never push, open pull requests or merge to main unless the user asked for it in this request. When a child asks for a permission or a login, ask the user instead of approving it yourself. Stay within the agent limits of the app; when agent run refuses a limit, close finished children or do the work yourself, never work around it. If an agent command fails with agents_disabled (agent team is turned off), do the work in this tab (your own subagents are fine). Do not ask the user for further direction unless something is truly ambiguous or needs approval from the user."}}'
exit 0
