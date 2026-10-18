use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use serde_json::{Value, json};

use crate::commands::handle_input;
use crate::config::AppConfig;
use crate::providers::{Model, Registry, ThinkingLevel};
use crate::session::{CURRENT_SESSION_VERSION, Message, Role, SessionStore};

pub fn run_rpc_mode(
    store: &mut SessionStore,
    registry: &Registry,
    config: &AppConfig,
) -> Result<()> {
    let mut state = RpcState::default();
    // A /goal is scoped to its session; a fresh agent process starts a new
    // session, so drop any goal left over from a previous one before the first turn.
    crate::commands::reset_goal_for_new_session(config);
    emit(json!({
        "type": "session",
        "version": CURRENT_SESSION_VERSION,
        "id": store.session().id,
        "timestamp": store.session().created_at,
        "cwd": store.session().cwd.display().to_string(),
    }))?;

    // Read stdin on a dedicated thread so `abort` frames work WHILE a prompt is
    // running (the main loop is busy inside run_prompt). Cancellation is a
    // global flag, so the reader thread can flip it directly; every other frame
    // is queued for the main loop.
    let (frames_tx, frames_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    // stdin closed = the host app (panel/parent process) is gone.
                    // Cancel any in-flight agent loop so this process exits instead
                    // of running up to MAX_AGENT_TOOL_TURNS as an orphan.
                    crate::commands::request_cancel();
                    break;
                }
                Ok(_) => {}
            }
            let frame = line.trim().trim_start_matches('\u{feff}').to_string();
            if frame.is_empty() {
                continue;
            }
            let frame_type = serde_json::from_str::<Value>(&frame)
                .ok()
                .and_then(|value| {
                    value
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            if matches!(frame_type.as_str(), "abort" | "abort_bash" | "abort_retry") {
                crate::commands::request_cancel();
                // Acknowledge from THIS thread — the abort frame never reaches
                // the main loop (it's intercepted here so it can cancel an
                // in-flight turn), so without this a client awaiting an ack for
                // abort would hang. emit() locks stdout, so the line can't
                // interleave with the streaming turn's output.
                let id = serde_json::from_str::<Value>(&frame)
                    .ok()
                    .and_then(|v| v.get("id").cloned());
                let _ = emit(response(id.as_ref(), &frame_type, true, None, None));
                continue;
            }
            if frames_tx.send(frame).is_err() {
                break;
            }
        }
    });

    for frame in frames_rx {
        let frame = frame.as_str();
        let command = match serde_json::from_str::<Value>(frame) {
            Ok(command) => command,
            Err(error) => {
                emit(response(
                    None,
                    "parse",
                    false,
                    None,
                    Some(error.to_string()),
                ))?;
                continue;
            }
        };
        let id = command.get("id").cloned();
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        let result = handle_rpc_command(store, registry, config, &mut state, &command);
        if command_type == "prompt" && result.is_ok() {
            continue;
        }
        match result {
            Ok(Some(data)) => emit(response(id.as_ref(), &command_type, true, Some(data), None))?,
            Ok(None) => emit(response(id.as_ref(), &command_type, true, None, None))?,
            Err(error) => emit(response(
                id.as_ref(),
                &command_type,
                false,
                None,
                Some(format!("{error:#}")),
            ))?,
        }
    }
    Ok(())
}

#[derive(Default)]
struct RpcState {
    steering: Vec<String>,
    follow_up: Vec<String>,
    steering_mode: QueueMode,
    follow_up_mode: QueueMode,
    auto_compaction_enabled: bool,
    auto_retry_enabled: bool,
}

#[derive(Clone, Copy, Default)]
enum QueueMode {
    All,
    #[default]
    OneAtATime,
}

impl QueueMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "all" => Ok(Self::All),
            "one-at-a-time" => Ok(Self::OneAtATime),
            other => bail!("invalid queue mode '{other}', expected all or one-at-a-time"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::OneAtATime => "one-at-a-time",
        }
    }
}

fn handle_rpc_command(
    store: &mut SessionStore,
    registry: &Registry,
    config: &AppConfig,
    state: &mut RpcState,
    command: &Value,
) -> Result<Option<Value>> {
    match command.get("type").and_then(Value::as_str).unwrap_or("") {
        "prompt" => {
            let message = string_field(command, "message")?;
            emit(response(command.get("id"), "prompt", true, None, None))?;
            // A previous abort must not cancel this fresh turn.
            crate::commands::reset_cancel();
            let _ = run_prompt(store, registry, config, message, command.get("id").cloned());
            // Drain any steering/follow-up queued WHILE this turn ran. Without
            // this they were acked and shown as pending but never delivered.
            // (Ideal steering injects mid-turn; this at least runs them as
            // follow-up turns instead of silently dropping user intent.)
            while !crate::commands::cancel_requested() {
                let batch = drain_queued(state);
                if batch.is_empty() {
                    break;
                }
                emit_queue_update(state)?;
                let _ = run_prompt(store, registry, config, &batch.join("\n\n"), None);
            }
            Ok(None)
        }
        "steer" => {
            state
                .steering
                .push(string_field(command, "message")?.to_string());
            emit_queue_update(state)?;
            Ok(None)
        }
        "follow_up" => {
            state
                .follow_up
                .push(string_field(command, "message")?.to_string());
            emit_queue_update(state)?;
            Ok(None)
        }
        "abort" | "abort_bash" | "abort_retry" => Ok(None),
        "new_session" => {
            *store = SessionStore::create_new(config)?;
            crate::commands::reset_goal_for_new_session(config);
            crate::commands::set_current_todo(Vec::new());
            Ok(Some(json!({ "cancelled": false })))
        }
        "get_state" => Ok(Some(session_state(store, registry, config, state))),
        "get_messages" => Ok(Some(json!({ "messages": store.messages() }))),
        "set_model" => {
            let provider = string_field(command, "provider")?;
            let model_id = string_field(command, "modelId")?;
            let model = registry
                .resolve_model_with_thinking(provider, Some(model_id))
                .ok_or_else(|| anyhow!("model not found: {provider}/{model_id}"))?;
            let thinking = select_thinking(&model.model, model.thinking.or(config.thinking_level));
            store.set_model_with_thinking(&model.model, Some(thinking))?;
            Ok(Some(model_json(&model.model)))
        }
        "cycle_model" => {
            let output = handle_input(store, registry, config, "/cycle")?;
            if output.starts_with("Model set:")
                && let Some(model) = current_model(store, registry, config)
            {
                return Ok(Some(json!({
                    "model": model_json(&model.0),
                    "thinkingLevel": model.1.as_str(),
                    "isScoped": !config.favorites.is_empty(),
                })));
            }
            Ok(Some(Value::Null))
        }
        "get_available_models" => {
            // Providers with a stored key / login (ollama is always local-ready):
            // the client floats their models to the top and badges them.
            let ready: Vec<String> = registry
                .providers()
                .filter(|provider| {
                    provider.id == "ollama"
                        || matches!(
                            crate::auth::stored_api_key(config, &provider.id),
                            Ok(Some(_))
                        )
                })
                .map(|provider| provider.id.clone())
                .collect();
            Ok(Some(json!({
                "models": registry
                    .search_models("")
                    .into_iter()
                    .map(model_json)
                    .collect::<Vec<_>>(),
                "readyProviders": ready,
            })))
        }
        "set_thinking_level" => {
            let level = ThinkingLevel::parse(string_field(command, "level")?)?;
            let _ = handle_input(
                store,
                registry,
                config,
                &format!("/thinking {}", level.as_str()),
            )?;
            Ok(None)
        }
        "cycle_thinking_level" => {
            let output = handle_input(store, registry, config, "/thinking cycle")?;
            let level = output
                .strip_prefix("Thinking set: ")
                .unwrap_or("-")
                .to_string();
            if level == "-" {
                Ok(Some(Value::Null))
            } else {
                Ok(Some(json!({ "level": level })))
            }
        }
        "set_steering_mode" => {
            state.steering_mode = QueueMode::parse(string_field(command, "mode")?)?;
            Ok(None)
        }
        "set_follow_up_mode" => {
            state.follow_up_mode = QueueMode::parse(string_field(command, "mode")?)?;
            Ok(None)
        }
        "compact" => {
            let custom = command
                .get("customInstructions")
                .and_then(Value::as_str)
                .unwrap_or("");
            let before = estimated_tokens(store.messages());
            let summary = if custom.trim().is_empty() {
                "Manual RPC compaction".to_string()
            } else {
                custom.trim().to_string()
            };
            emit(json!({ "type": "compaction_start", "reason": "manual" }))?;
            let first_kept = store.append_compaction(summary.clone(), 8)?;
            let data = json!({
                "summary": summary,
                "firstKeptEntryId": first_kept,
                "tokensBefore": before,
                "estimatedTokensAfter": estimated_tokens(&store.conversation()),
                "details": {},
            });
            emit(json!({
                "type": "compaction_end",
                "reason": "manual",
                "result": data,
                "aborted": false,
                "willRetry": false,
            }))?;
            Ok(Some(data))
        }
        "set_auto_compaction" => {
            state.auto_compaction_enabled = bool_field(command, "enabled")?;
            Ok(None)
        }
        "set_auto_retry" => {
            state.auto_retry_enabled = bool_field(command, "enabled")?;
            Ok(None)
        }
        "bash" => {
            let command_text = string_field(command, "command")?;
            let output = handle_input(store, registry, config, &format!("!{command_text}"))?;
            // The `!` bash path returns only text — it does NOT surface a real
            // exit code, so we must not invent `exitCode: 0` (that made a panel
            // show green checkmarks for failed commands). Report what we can
            // truthfully know: the output and whether the user cancelled.
            Ok(Some(json!({
                "output": output,
                "exitCode": Value::Null,
                "cancelled": crate::commands::cancel_requested(),
            })))
        }
        "get_session_stats" => Ok(Some(session_stats(store))),
        "get_themes" => Ok(Some(json!({
            "themes": crate::themes::load_themes(config)?
                .into_iter()
                .map(|theme| json!({
                    "name": theme.name,
                    "path": theme.file_path.display().to_string(),
                }))
                .collect::<Vec<_>>()
        }))),
        "export_html" => {
            let path = command
                .get("outputPath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    config
                        .session_dir
                        .join("share")
                        .join(format!("{}.html", store.session().id))
                });
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            store.export_html(&path)?;
            Ok(Some(json!({ "path": path.display().to_string() })))
        }
        "switch_session" => {
            *store = SessionStore::open_session_ref(config, string_field(command, "sessionPath")?)?;
            crate::commands::restore_todo_from_conversation(&store.conversation());
            Ok(Some(json!({ "cancelled": false })))
        }
        "fork" => {
            let entry_id = string_field(command, "entryId")?;
            let text = store
                .messages()
                .iter()
                .find(|message| message.id.starts_with(entry_id) && message.role == Role::User)
                .map(|message| message.content.clone())
                .ok_or_else(|| anyhow!("no user message starts with {entry_id}"))?;
            store.new_branch_at(entry_id)?;
            *store = store.clone_current(config)?;
            Ok(Some(json!({ "text": text, "cancelled": false })))
        }
        "clone" => {
            *store = store.clone_current(config)?;
            Ok(Some(json!({ "cancelled": false })))
        }
        "get_fork_messages" => Ok(Some(json!({
            "messages": store
                .messages()
                .iter()
                .filter(|message| message.role == Role::User)
                .map(|message| json!({ "entryId": message.id, "text": message.content }))
                .collect::<Vec<_>>()
        }))),
        "get_last_assistant_text" => Ok(Some(json!({
            "text": store
                .messages()
                .iter()
                .rev()
                .find(|message| message.role == Role::Assistant)
                .map(|message| message.content.clone())
        }))),
        "set_session_name" => {
            store.set_name(string_field(command, "name")?)?;
            Ok(None)
        }
        "get_commands" => Ok(Some(json!({ "commands": available_commands(config)? }))),
        "get_harness_roles" => Ok(Some(harness_roles_json(config))),
        "set_harness_persona" => {
            let role = string_field(command, "role")?;
            let persona = command
                .get("persona")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let line = if persona.is_empty() {
                format!("/roles {role} persona clear")
            } else {
                format!("/roles {role} persona {persona}")
            };
            let _ = handle_input(store, registry, config, &line)?;
            Ok(Some(harness_roles_json(config)))
        }
        "set_harness_role" => {
            let role = string_field(command, "role")?;
            let model = command
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let line = match (role, model) {
                ("all", "") => "/roles clear".to_string(),
                ("all", reference) => format!("/roles {reference}"),
                (role, "") => format!("/roles {role} clear"),
                (role, reference) => format!("/roles {role} {reference}"),
            };
            let _ = handle_input(store, registry, config, &line)?;
            Ok(Some(harness_roles_json(config)))
        }
        "get_personas" => Ok(Some(json!({
            "personas": crate::personas::load_personas(config)
                .into_iter()
                .map(|p| json!({
                    "id": p.id,
                    "division": p.division,
                    "name": p.name,
                    "description": p.description,
                    "emoji": p.emoji,
                }))
                .collect::<Vec<_>>()
        }))),
        "get_sessions" => Ok(Some(json!({
            "sessions": SessionStore::list_session_lines(config)?
                .into_iter()
                .filter_map(|line| {
                    let mut fields = line.split('\t');
                    let id = fields.next()?.to_string();
                    let name = fields.next().unwrap_or("").to_string();
                    let messages = fields.next().unwrap_or("").to_string();
                    let created_at = fields.next().unwrap_or("").to_string();
                    let path = fields.next().unwrap_or("").to_string();
                    Some(json!({
                        "id": id,
                        "name": name,
                        "messages": messages,
                        "createdAt": created_at,
                        "path": path,
                    }))
                })
                .collect::<Vec<_>>()
        }))),
        "get_available_tools" => Ok(Some(json!({ "tools": available_tools(config) }))),
        "get_extensions" => Ok(Some(json!({ "extensions": available_extensions(config)? }))),
        "run_extension_hook" => {
            let extension_id = string_field(command, "extensionId")?;
            let event = string_field(command, "event")?;
            let payload = command.get("payload").cloned().unwrap_or(Value::Null);
            Ok(Some(crate::extensions::run_extension_hook(
                config,
                extension_id,
                event,
                payload,
            )?))
        }
        "run_extension_tool" => {
            let tool_name = string_field(command, "toolName")?;
            let tool_call_id = command
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or(tool_name);
            let arguments = command.get("arguments").cloned().unwrap_or(Value::Null);
            let output =
                crate::extensions::run_extension_tool(config, tool_name, tool_call_id, &arguments)?;
            Ok(Some(json!({
                "output": output.as_ref().map(|output| output.text.clone()),
                "terminate": output.as_ref().map(|output| output.terminate).unwrap_or(false),
            })))
        }
        "run_extension_shortcut" => {
            let shortcut = string_field(command, "shortcut")?;
            Ok(Some(json!({
                "output": crate::extensions::run_extension_shortcut(config, shortcut)?
            })))
        }
        "extension_ui_response" => Ok(None),
        "" => bail!("missing command type"),
        other => bail!("unknown RPC command: {other}"),
    }
}

fn run_prompt(
    store: &mut SessionStore,
    registry: &Registry,
    config: &AppConfig,
    message: &str,
    run_id: Option<Value>,
) -> Result<()> {
    emit(json!({ "type": "agent_start", "runId": run_id }))?;
    emit(json!({ "type": "turn_start", "runId": run_id }))?;
    let before = store.messages().len();
    if config.stream {
        fn emit_delta(kind: &str, chunk: &str, run_id: Option<&Value>) {
            let line = json!({
                "type": "message_update",
                "runId": run_id,
                "delta": { "type": kind, "text": chunk },
            });
            if let Ok(text) = serde_json::to_string(&line) {
                let mut stdout = std::io::stdout().lock();
                let _ = writeln!(stdout, "{text}");
                let _ = stdout.flush();
            }
        }
        let text_run_id = run_id.clone();
        crate::llm::set_stream_sink(Some(Box::new(move |chunk: &str| {
            emit_delta("text_delta", chunk, text_run_id.as_ref());
        })));
        // Reasoning must stay distinguishable from answer text for structured
        // consumers — the panel renders text deltas as the live message.
        let thinking_run_id = run_id.clone();
        crate::llm::set_thinking_sink(Some(Box::new(move |chunk: &str| {
            emit_delta("thinking_delta", chunk, thinking_run_id.as_ref());
        })));
    }
    let result = handle_input(store, registry, config, message);
    crate::llm::set_stream_sink(None);
    crate::llm::set_thinking_sink(None);
    match result {
        Ok(output) => {
            let new_messages = store.messages()[before..].to_vec();
            let has_visible_message = new_messages.iter().any(|message| {
                matches!(message.role, Role::Assistant | Role::Tool)
                    && !message.content.trim().is_empty()
            });
            let is_control_outcome = output.contains("(cancelled)")
                || output.contains("(stopped")
                || output.contains("automatic continuation limit");
            let incomplete = output.contains("unfinished todo items")
                || output.contains("unverified changes after the automatic verification limit")
                || output.contains("Automatic continuation required.");
            let control_outcome_missing = is_control_outcome
                && !new_messages
                    .iter()
                    .any(|message| message.content.contains(output.trim()));
            if !has_visible_message {
                let synthetic = json!({
                    "role": "assistant",
                    "content": output,
                    "created_at": Utc::now().to_rfc3339(),
                });
                emit(json!({ "type": "message_start", "runId": run_id, "message": synthetic }))?;
                emit(json!({ "type": "message_end", "runId": run_id, "message": synthetic }))?;
                emit(
                    json!({ "type": "turn_end", "runId": run_id, "message": synthetic, "toolResults": [] }),
                )?;
            } else {
                for message in &new_messages {
                    emit(json!({ "type": "message_start", "runId": run_id, "message": message }))?;
                    if message.role == Role::Tool {
                        emit(json!({
                            "type": "tool_execution_end",
                            "toolCallId": message.tool_call_id,
                            "toolName": message.tool_name,
                            "result": {
                                "content": [{ "type": "text", "text": message.content }],
                                "details": {},
                            },
                            "isError": message.is_error,
                        }))?;
                    }
                    emit(json!({ "type": "message_end", "runId": run_id, "message": message }))?;
                }
                let tool_results = new_messages
                    .iter()
                    .filter(|message| message.role == Role::Tool)
                    .collect::<Vec<_>>();
                if let Some(last) = new_messages.last() {
                    emit(json!({
                        "type": "turn_end",
                        "runId": run_id,
                        "message": last,
                        "toolResults": tool_results,
                    }))?;
                }
                // Guard/cancellation results are returned by handle_input but are
                // intentionally not persisted as normal assistant history. RPC
                // clients still need the reason, otherwise the turn looks like a
                // silent mid-task stop.
                if control_outcome_missing {
                    let synthetic = json!({
                        "role": "assistant",
                        "content": output,
                        "created_at": Utc::now().to_rfc3339(),
                    });
                    emit(
                        json!({ "type": "message_start", "runId": run_id, "message": synthetic }),
                    )?;
                    emit(json!({ "type": "message_end", "runId": run_id, "message": synthetic }))?;
                    emit(
                        json!({ "type": "turn_end", "runId": run_id, "message": synthetic, "toolResults": [] }),
                    )?;
                }
            }
            emit(json!({
                "type": "agent_end",
                "runId": run_id,
                "messages": store.messages(),
                "cancelled": crate::commands::cancel_requested(),
                "incomplete": incomplete,
                "stopReason": is_control_outcome.then_some(output),
            }))?;
            Ok(())
        }
        Err(error) => {
            let message = json!({
                "role": "assistant",
                "content": format!("{error:#}"),
                "isError": true,
                "created_at": Utc::now().to_rfc3339(),
            });
            emit(json!({
                "type": "turn_end",
                "runId": run_id,
                "message": message,
                "toolResults": [],
                "errorMessage": format!("{error:#}"),
            }))?;
            emit(json!({
                "type": "agent_end",
                "runId": run_id,
                "messages": store.messages(),
                "errorMessage": format!("{error:#}"),
            }))?;
            Err(error)
        }
    }
}

fn session_state(
    store: &SessionStore,
    registry: &Registry,
    config: &AppConfig,
    state: &RpcState,
) -> Value {
    let model = current_model(store, registry, config);
    json!({
        "model": model.as_ref().map(|(model, _)| model_json(model)),
        "persona": crate::personas::effective_persona(config).map(|p| json!({
            "id": p.id,
            "name": p.name,
            "emoji": p.emoji,
        })),
        "thinkingLevel": model.map(|(_, thinking)| thinking.as_str()).unwrap_or("off"),
        "isStreaming": false,
        "isCompacting": false,
        "steeringMode": state.steering_mode.as_str(),
        "followUpMode": state.follow_up_mode.as_str(),
        "sessionFile": store.session_file().map(|path| path.display().to_string()),
        "sessionId": store.session().id,
        "sessionName": store.session().name,
        "autoCompactionEnabled": state.auto_compaction_enabled,
        "messageCount": store.messages().len(),
        "pendingMessageCount": state.steering.len() + state.follow_up.len(),
    })
}

fn session_stats(store: &SessionStore) -> Value {
    let user_messages = store
        .messages()
        .iter()
        .filter(|message| message.role == Role::User)
        .count();
    let assistant_messages = store
        .messages()
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .count();
    let tool_results = store
        .messages()
        .iter()
        .filter(|message| message.role == Role::Tool)
        .count();
    let tool_calls = store
        .messages()
        .iter()
        .map(|message| message.tool_calls.len())
        .sum::<usize>();
    let actual_tokens = store.token_usage_total();
    let estimated_tokens = estimated_tokens(store.messages());
    let tokens = if actual_tokens.is_empty() {
        crate::session::TokenUsage::new(estimated_tokens, 0, 0, 0, estimated_tokens)
    } else {
        actual_tokens
    };
    json!({
        "sessionFile": store.session_file().map(|path| path.display().to_string()),
        "sessionId": store.session().id,
        "userMessages": user_messages,
        "assistantMessages": assistant_messages,
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "totalMessages": store.messages().len(),
        "tokens": {
            "input": tokens.input,
            "output": tokens.output,
            "cacheRead": tokens.cache_read,
            "cacheWrite": tokens.cache_write,
            "total": tokens.total,
            "estimated": estimated_tokens,
        },
        "tokensByModel": store
            .token_usage_by_model()
            .into_iter()
            .map(|(model, usage)| json!({
                "model": model,
                "input": usage.input,
                "output": usage.output,
                "cacheRead": usage.cache_read,
                "cacheWrite": usage.cache_write,
                "total": usage.total,
            }))
            .collect::<Vec<_>>(),
        "cost": 0.0,
    })
}

fn current_model(
    store: &SessionStore,
    registry: &Registry,
    config: &AppConfig,
) -> Option<(Model, ThinkingLevel)> {
    let resolved = store
        .session()
        .current_model
        .as_deref()
        .and_then(|current| registry.resolve_reference_with_thinking(current))
        .or_else(|| {
            registry.resolve_model_with_thinking(&config.provider, config.model.as_deref())
        })?;
    let thinking = select_thinking(&resolved.model, config.thinking_level.or(resolved.thinking));
    Some((resolved.model, thinking))
}

fn select_thinking(model: &Model, requested: Option<ThinkingLevel>) -> ThinkingLevel {
    if !model.reasoning {
        return ThinkingLevel::Off;
    }
    requested.unwrap_or(ThinkingLevel::Medium)
}

fn model_json(model: &Model) -> Value {
    json!({
        "id": model.id,
        "name": model.name,
        "api": model.api,
        "provider": model.provider,
        "baseUrl": model.base_url,
        "reasoning": model.reasoning,
        "contextWindow": model.context_window,
        "maxTokens": model.max_tokens,
    })
}

/// Harness role → model+persona assignments for the chat panel's settings
/// drawer (empty string = "use the current chat model" / "no persona").
fn harness_roles_json(config: &AppConfig) -> Value {
    let personas = crate::commands::harness_persona_assignments(config);
    json!({
        "roles": crate::commands::harness_role_assignments(config)
            .into_iter()
            .map(|(role, model)| {
                let persona = personas
                    .iter()
                    .find(|(name, _)| *name == role)
                    .map(|(_, id)| id.clone())
                    .unwrap_or_default();
                json!({ "role": role, "model": model, "persona": persona })
            })
            .collect::<Vec<_>>()
    })
}

/// Built-in slash commands surfaced to RPC clients (the chat panel renders
/// these as its menu — same feature set as the TUI's Tab menu). `needs_arg`
/// tells the client to prefill the composer instead of sending immediately.
const BUILTIN_COMMANDS: &[(&str, &str, bool)] = &[
    (
        "/settings",
        "Settings dashboard (model/thinking/roles/persona)",
        false,
    ),
    ("/login", "Login provider", false),
    (
        "/accounts",
        "Logged-in accounts & usage (Claude/Codex multi-login)",
        false,
    ),
    ("/model", "Switch model", false),
    ("/thinking", "Thinking level", false),
    ("/roles", "Harness role models", false),
    ("/persona", "Adopt a specialist persona", true),
    ("/new", "New task (fresh session)", false),
    ("/resume", "Resume session", false),
    ("/sessions", "List sessions", false),
    ("/plan", "Plan only", true),
    ("/harness", "Harness: plan + build + review", true),
    ("/bugfix", "Bugfix: find + fix + verify", true),
    ("/review", "Review with second pass", true),
    ("/loop", "Loop until complete", true),
    ("/batch", "Batch across files", true),
    ("/orchestrate", "Multi-task in parallel", true),
    ("/links", "Links in conversation", false),
    ("/files", "Codebase tree", false),
    ("/worktree", "Worktree branch", true),
    ("/lens", "Review uncommitted changes", false),
    ("/restore", "Restore files changed this session", false),
    ("/bench", "Self-benchmark (machine-graded suite)", false),
    ("/land", "Land changes (commit)", true),
    ("/wiki", "Project wiki", false),
    ("/goal", "Standing goal", false),
    ("/memory", "List or forget auto-memories", false),
    ("/improve", "Self-improve project", true),
    ("/autoimprove", "Auto-upgrade project", true),
    ("/help", "Help", false),
];

fn available_commands(config: &AppConfig) -> Result<Vec<Value>> {
    let mut commands = Vec::new();
    for (name, description, needs_arg) in BUILTIN_COMMANDS {
        commands.push(json!({
            "name": name,
            "description": description,
            "source": "builtin",
            "needsArg": needs_arg,
        }));
    }
    for extension in crate::extensions::load_extensions_with_runtime_commands(config)? {
        for command in extension.commands {
            commands.push(json!({
                "name": command.name,
                "description": command.description,
                "source": if command.runtime { "extension-runtime" } else { "extension" },
                "sourceInfo": { "type": "path", "path": command.root.display().to_string() },
                "path": command.root.display().to_string(),
            }));
        }
    }
    for prompt in crate::resources::load_prompts(config)? {
        commands.push(json!({
            "name": prompt.name,
            "description": prompt.description,
            "source": "prompt",
            "sourceInfo": { "type": "path", "path": prompt.file_path.display().to_string() },
            "path": prompt.file_path.display().to_string(),
        }));
    }
    for skill in crate::resources::load_skills(config)? {
        commands.push(json!({
            "name": format!("skill:{}", skill.name),
            "description": skill.description,
            "source": "skill",
            "sourceInfo": { "type": "path", "path": skill.file_path.display().to_string() },
            "path": skill.file_path.display().to_string(),
        }));
    }
    Ok(commands)
}

fn available_tools(config: &AppConfig) -> Vec<Value> {
    crate::tools::configured_tool_specs(config, true)
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "promptSnippet": tool.prompt_snippet,
                "promptGuidelines": tool.prompt_guidelines,
            })
        })
        .collect()
}

fn available_extensions(config: &AppConfig) -> Result<Vec<Value>> {
    Ok(
        crate::extensions::load_extensions_with_runtime_commands(config)?
            .into_iter()
            .map(|extension| {
                json!({
                    "id": extension.id,
                    "name": extension.name,
                    "description": extension.description,
                    "path": extension.root.display().to_string(),
                    "entry": extension.entry.map(|path| path.display().to_string()),
                    "hooks": extension.hooks,
                    "commands": extension
                        .commands
                        .into_iter()
                        .map(|command| json!({
                            "name": command.name,
                            "description": command.description,
                            "runtime": command.runtime,
                            "sourceInfo": {
                                "type": "path",
                                "path": command.root.display().to_string(),
                            },
                        }))
                        .collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// Pull the next messages to run after a turn: steering first (it's a course
/// correction), then follow-ups. `All` mode takes the whole queue at once;
/// `OneAtATime` takes a single message so each runs as its own turn.
fn drain_queued(state: &mut RpcState) -> Vec<String> {
    let mut batch = Vec::new();
    if !state.steering.is_empty() {
        match state.steering_mode {
            QueueMode::All => batch.append(&mut state.steering),
            QueueMode::OneAtATime => batch.push(state.steering.remove(0)),
        }
    }
    if batch.is_empty() && !state.follow_up.is_empty() {
        match state.follow_up_mode {
            QueueMode::All => batch.append(&mut state.follow_up),
            QueueMode::OneAtATime => batch.push(state.follow_up.remove(0)),
        }
    }
    batch
}

fn emit_queue_update(state: &RpcState) -> Result<()> {
    emit(json!({
        "type": "queue_update",
        "steering": state.steering,
        "followUp": state.follow_up,
    }))
}

fn response(
    id: Option<&Value>,
    command: &str,
    success: bool,
    data: Option<Value>,
    error: Option<String>,
) -> Value {
    let mut value = json!({
        "type": "response",
        "command": command,
        "success": success,
    });
    let object = value.as_object_mut().expect("response is object");
    if let Some(id) = id {
        object.insert("id".to_string(), id.clone());
    }
    if let Some(data) = data {
        object.insert("data".to_string(), data);
    }
    if let Some(error) = error {
        object.insert("error".to_string(), Value::String(error));
    }
    value
}

fn emit(value: Value) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", serde_json::to_string(&value)?)?;
    stdout.flush()?;
    Ok(())
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing string field '{field}'"))
}

fn bool_field(value: &Value, field: &str) -> Result<bool> {
    value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("missing boolean field '{field}'"))
}

fn estimated_tokens(messages: &[Message]) -> usize {
    messages
        .iter()
        .map(|message| message.content.len().div_ceil(4))
        .sum()
}
