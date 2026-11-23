# Model limit fallback (Fable → Opus and back)

Setting: Settings → Agent → Claude Code → "Switch to Opus when the Fable limit is hit"
(`agent.claudeLimitFallback`, off by default). Fields: primary model
(`claudeLimitPrimaryModel`, default `claude-fable-5-2`), fallback model
(`claudeLimitFallbackModel`, default `opus`), usage file (`claudeLimitUsageFile`, default
`~/.claude/logs/model-usage.json`, empty = not used).

Code: `src/terminal/modelLimitFallback.ts` (parsing, reset time, launch decision, state machine;
unit-tested), `src/terminal/modelLimitRuntime.ts` (wiring), `src-tauri/resources/claude-hooks/stop-failure.sh`,
`POST /api/claude-limit` in `src-tauri/src/browser_bridge.rs`.

## What Claude Code does on the limit (measured, Claude Code 2.1.325)

1. OSC 7501 `state=error:app=claude-code:msg=<base64>`; msg = `You've hit your Fable limit · resets Nov 21 at 12pm (Asia/Seoul)`.
2. `state=working`, then `state=blocked:…:msg=<"dialog open">`: Claude Code runs `/rate-limit-options`
   ("1. Stop and wait for limit to reset / 2. Wait here, then continue automatically / 3. Ask your admin").
3. The `StopFailure` hook gets `{"session_id", "transcript_path", "hook_event_name":"StopFailure",
   "error":"rate_limit", "last_assistant_message":"You've hit your Fable limit · resets …"}`.
4. The transcript keeps the refused prompt followed by an `isApiErrorMessage` entry, so a short
   "continue" after `/model` answers the refused prompt.
5. Esc closes the dialog and returns to the prompt; Claude Code then repeats the same `state=error`
   report (no `idle`). `--fallback-model` does not help for usage limits.
6. `/model opus` typed as a bracketed paste and submitted with the tab's submit key (two presses when
   the submit key also dismisses autocomplete) prints `Set model to Opus 5.5 and saved as your
   default for new sessions`. No 7501 report follows `/model`.

Point 6 is Claude Code's own behaviour: `/model` also changes the default model for new sessions
in `~/.claude/settings.json`. The app never writes that file; it only types `/model`, so while a tab
is switched, other new Claude sessions start on the fallback too, and the return `/model <primary>`
sets the default back.

## Flow

**Detect.** A registered Claude tab (cliType `claude`, mounted) counts as limited when either
- the OSC 7501 `state=error` msg is the primary model's limit text (`You've hit your <Name> limit`
  with optional `· resets <…>`; `<Name>` is derived from the primary id: `claude-fable-5-2` → `Fable`;
  quote style and separator are tolerant; a message without a model name, or with another model's
  name, is ignored), or
- the bundled StopFailure hook reports `error: "rate_limit"` for this tab (`BBARIT_TERMINAL_ID`, and
  the tab's known session id when both are present) with the primary's limit text. Only an empty
  message counts without the name; a session limit (`You've hit your limit`), a weekly limit or any
  other text never switches, since the fallback is limited too.

Events are de-duplicated per tab (one switch in progress, 2-minute window, and no detection while the
tab is already marked). Never while `replayingOutput` is set, never from screen text (a pasted copy
of the sentence is input, not a 7501 report or hook), never in non-Claude tabs.

**Leave alone.** No switch when a person chose the model: `modelId` from settings, `--model` in the
tab/project flags, or a human slash command starting with `/mo` committed in the tab (seen through
`lastCommand`'s commit listener, which only gets human input and clicked buttons; an autocomplete
pick may commit as a prefix). A human `/model` also drops the mark. The
human `/model` exclusion lasts for the app run; the persisted mark is the only state across restarts.

**Switch** (input goes through the input gate, source `model-fallback`). The switch stops as soon as
the person takes over: a human key in the tab after the limit event, a dialog option picked by them,
or a `/mo…` command; this is re-checked after every wait, and always before the continue message.
Nothing is typed while `lastCommand` holds a half-typed human prompt (`hasPendingInput`): the switch
waits up to 30 s for it, the continue message is skipped, and the return waits for the next tick.
1. If the tab goes `blocked` within 5 s, send a lone Esc with `closeLimitDialog: true, submit: false`.
   This is the gate's only exception to the blocked refusal (docs/AGENT_INPUT_GATE.md); any other text
   with that flag is still refused, and the Esc itself is refused (`not-blocked`) when the tab is no
   longer blocked at write time. Wait until the tab is no longer blocked.
2. Send `/model <fallback>` and wait up to 8 s for one more `Set model to <Name>` on the last screen
   rows (screen text is used only to confirm our own command, never to detect the limit). Sent but
   not confirmed → the tab may be switched: it is marked with `unconfirmed: true` so it can return,
   no continue message, failure toast. A new limit event retries only after 30 minutes, and the app
   gives up after 3 tries (never re-types `/model` every few minutes).
3. Mark the tab (`TerminalInstance.modelFallback = { model, primary, resetAt, switchedAt }`, saved with
   the projects so it survives a restart) and toast "Fable limit → switched to Opus (reset: <local time>)".
4. Send the continue message ("이어서 진행해줘" for the Korean UI, "Continue" otherwise).

**Reset time.** The usage file's `resets_at` for the entry whose `name` matches the primary's display
name, when it is in the future; else the message's time (`Nov 21 at 12pm (Asia/Seoul)`, `3pm (UTC)`,
time zone honoured, local zone when none); else unknown (`resetAt: null`), and the return check then
waits until the usage file shows the primary below 100 %.

**Return.** One module-level 30 s timer runs only while some mounted tab is marked. For a marked tab
whose reset has passed, at least 15 minutes after the switch, when the tab is `idle`/`done` (never
working, blocked or replaying), and the usage file does not show a later reset: send
`/model <primary>`, confirm as above, clear the mark, toast "Fable limit reset → back to Fable".
Not confirmed → retry after 30 minutes; after 3 tries the mark is dropped and a toast asks the person
to run `/model <primary>`.

**Claude Code's saved default.** Every `/model <fallback>` the app sends (confirmed or not) sets an
app-wide "default changed by us" flag (browser storage of the window). A successful return clears it.
When it is still set after the reset and no mounted tab is marked (the marked tab was closed, or it
relaunched with `--model <primary>`, which does not change the saved default), the app types
`/model <primary>` once into an idle Claude tab nobody chose a model for, with no half-typed prompt;
with no such tab it shows one toast asking the person to run it.

**Re-hit.** If the first answer after returning hits the limit again, the tab switches again. A new
reset time is stored only when it is later than the one the tab returned on; otherwise the tab waits
30 minutes before the next return, so it never flips back and forth on the same reset time.

**New tabs / relaunch** (only tabs with no model from settings or flags). The decision is pure; the
mark is set or cleared only in the branch that types a new startup command, never on a remount, a
reused terminal or a PTY holder reattach (where Claude keeps running on whatever model it had):
- Marked tab: before the reset, launch with `--model <fallback>`; after it, launch with
  `--model <primary>` and clear the mark.
- Unmarked tab: if the usage file says the primary is at 100 % with a future `resets_at`, launch with
  `--model <fallback>` and mark it. Otherwise the launch command is unchanged: no `--model` is added
  that was not there before.

**Visible state.** Every Claude tab has an icon next to the capture and pop-out buttons (the tab
name stays visible); its tooltip and `aria-label` say the state, with the model names from Settings:
- off (setting off): muted crossed-out arrows, "Auto model switch is off (Settings > Agent)";
- on (watching, tab on the primary): neutral arrows, "Auto switch on: switches to Opus when the Fable limit is hit";
- switched: amber swap icon, "Fable limit → switched to Opus · back after <local time>" ("reset time
  unknown" when there is none; "(unconfirmed)" with a dashed outline when `/model` was not confirmed);
- chosen by a person with a typed `/mo…`: person-with-lock icon, "Model chosen by you (/model): not
  switched automatically · click to return to auto". Clicking it clears only that tab's flag: nothing
  is typed, the current model stays, the next primary limit switches as usual, and a toast says
  "This tab is managed by auto model switch again";
- model set by Settings > Agent (Claude model) or a `--model` flag: same icon, "Model set in Settings >
  Agent or a --model flag: not switched automatically (change it there)"; the click opens Settings
  (the app does not edit flags or settings from the tab).
Clicking any other state opens Settings at the Agent section. Logic: `describeModelSwitch` in
`src/terminal/modelLimitRuntime.ts`.

## StopFailure hook

`bbarit-session.json` (loaded only through `claude --settings` in app tabs; `~/.claude/settings.json`
is never written) runs `stop-failure.sh` from the same folder as `$BBARIT_CLAUDE_HOOK`. The script
exits 0 on every path, prints nothing, skips subagents and non-`rate_limit` errors, and POSTs
`{terminalId, sessionId, error, message}` to `http://127.0.0.1:$BBARIT_BRIDGE_PORT/api/claude-limit`.
The bridge validates (uuid session id, short `error` token, message ≤ 512 chars without control
characters) and emits `claude-limit-reported`; the frontend decides. Verified against real Claude Code
2.1.325 with a local listener: the POST body was
`{"terminalId":"probe-tab","sessionId":"…","error":"rate_limit","message":"You've hit your Fable limit · resets Nov 21 at 12pm (Asia/Seoul)"}`.

## Limits

- The usage file is the user's own status line output; the app only reads it. Without it, new tabs
  never start on the fallback, and an unknown reset time waits for a later detection.
- A tab already on the fallback that hits the fallback's limit is not handled (the message names the
  fallback, not the primary).
- Windows: detection runs where the tab is mounted. Mark changes are broadcast as the Tauri event
  `model-fallback-mark`; only the main window (which persists tabs) stores them on the terminal.
  A projects sync never clears or revives a mark this window changed, so a lagging snapshot or a
  harness window's own copy cannot drop it.
- The usage file is read by the async command `read_usage_file` (local regular file only, `~/`
  expanded, no ssh paths, FIFOs or devices, 64 KB cap), never on the main thread.
