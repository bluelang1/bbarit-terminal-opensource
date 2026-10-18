/**
 * 빠릿터미널 UI 커맨드 버스의 명령 사전 — 게이트웨이 비서(app_control)와
 * 로컬 CLI(scripts/bbarit-ctl.mjs)가 공유한다. `commands.list`가 이 배열을
 * 그대로 돌려주므로, 명령을 추가하면 여기에도 반드시 등록할 것.
 * 사용자 노출 문구는 영어 고정 (설정 → Control CLI 탭에 그대로 표시된다).
 */
export interface GatewayUiCommandDoc {
  cmd: string;
  args: string;
  desc: string;
  group: string;
}

export const GATEWAY_UI_COMMAND_DOCS: GatewayUiCommandDoc[] = [
  { group: 'Status', cmd: 'status', args: '-', desc: 'Active project, view mode, projects, open files' },
  { group: 'Status', cmd: 'commands.list', args: '-', desc: 'This full command dictionary' },

  { group: 'Projects', cmd: 'project.list', args: '-', desc: 'Open projects (id / name / workDir)' },
  { group: 'Projects', cmd: 'project.create', args: 'workDir, name?', desc: 'Open a folder as a project (switches if already open)' },
  { group: 'Projects', cmd: 'project.switch', args: 'projectId', desc: 'Switch the active project' },

  { group: 'Layout', cmd: 'view.set', args: 'view=default|terminal|editor|kanban|pm2|hub|side|project-terminal', desc: 'Change the main view mode' },
  { group: 'Layout', cmd: 'terminal.layout.set', args: 'layout=tabs|horizontal|vertical|grid|mix|tiled|tiled_tb|tree|monitor', desc: 'Change the terminal split layout' },
  { group: 'Layout', cmd: 'sidebar.set', args: 'visible=true|false', desc: 'Show/hide the file tree sidebar' },

  { group: 'Terminals', cmd: 'terminal.list', args: '-', desc: 'Terminals of the active project (id / name / cliType / active)' },
  { group: 'Terminals', cmd: 'terminal.create', args: 'cliType?=shell|claude|codex|…, workDir?', desc: 'Create a new terminal' },
  { group: 'Terminals', cmd: 'terminal.write', args: 'text, terminalId?, submit?=true', desc: 'Type into a terminal (defaults: active terminal, Enter appended)' },
  { group: 'Terminals', cmd: 'terminal.read', args: 'terminalId?, lines?=80', desc: 'Read the last N lines of a terminal buffer' },
  { group: 'Terminals', cmd: 'terminal.activate', args: 'terminalId', desc: 'Focus a terminal tab' },
  { group: 'Terminals', cmd: 'terminal.close', args: 'terminalId', desc: 'Close a terminal (no confirm)' },

  { group: 'Editor', cmd: 'editor.open', args: 'path', desc: 'Open a file in the built-in editor (office files included)' },
  { group: 'Editor', cmd: 'editor.list', args: '-', desc: 'Open editor tabs of the active project (path / modified / active)' },
  { group: 'Editor', cmd: 'editor.close', args: 'path', desc: 'Close an open editor tab (no confirm, discards unsaved changes)' },

  { group: 'Kanban', cmd: 'kanban.list', args: 'column?', desc: 'Kanban tasks (id / title / column / priority / dueDate / linkedNotes / calendarEventId), optionally filtered by column' },
  { group: 'Kanban', cmd: 'kanban.add', args: 'title, column?=todo, priority?=medium, description?, dueDate?, note?, gantt?', desc: 'Add a kanban task (column: backlog|todo|inprogress|review|done|cancelled; dueDate: YYYY-MM-DD; note: vault note path/title to link; gantt: true → also create a linked gantt bar)' },
  { group: 'Kanban', cmd: 'kanban.move', args: 'taskId, column', desc: 'Move a kanban task to another column (linked gantt bar follows)' },
  { group: 'Kanban', cmd: 'kanban.update', args: 'taskId, title?, description?, priority?, column?, dueDate?, note?, removeNote?', desc: 'Update fields of a kanban task; note/removeNote link/unlink a vault note by path or title' },
  { group: 'Kanban', cmd: 'kanban.delete', args: 'taskId', desc: 'Delete a kanban task (removes its linked gantt bar too)' },

  { group: 'Gantt', cmd: 'gantt.list', args: 'from?, to?', desc: 'Planner/gantt events (id / title / date / endDate / status / kanbanTaskId), optionally filtered by date range' },
  { group: 'Gantt', cmd: 'gantt.add', args: 'title, date?=today, endDate?, status?=todo, priority?, description?', desc: 'Add a gantt event (status: todo|in_progress|done)' },
  { group: 'Gantt', cmd: 'gantt.update', args: 'eventId, title?, date?, endDate?, status?, priority?, description?', desc: 'Update a gantt event; kanban-linked events mirror status/dates onto the task' },
  { group: 'Gantt', cmd: 'gantt.delete', args: 'eventId', desc: 'Delete a gantt event (kanban-linked tasks are unlinked)' },

  { group: 'Panels', cmd: 'panel.open', args: 'panel=image|design|cowork|marketing|motion|browser|settings', desc: 'Open a major panel/window' },
  { group: 'Panels', cmd: 'image.generate', args: 'prompt?', desc: 'Open BBARIT Image and submit a generation prompt' },
  { group: 'Panels', cmd: 'motion.generate', args: 'prompt?', desc: 'Open BBARIT Motion (fal.ai image/video studio) and submit a prompt' },
  { group: 'Panels', cmd: 'design.open', args: 'prompt?', desc: 'Open BBARIT Design and submit a prompt' },
  { group: 'Panels', cmd: 'design.canvas', args: 'action=status|reload|enhance|variations|autopilot|tidy|syncInstances', desc: 'Control the BBARIT Design canvas — status returns session dir and design.pen.json path for direct node edits; autopilot runs explore→pick→polish unattended' },
  { group: 'Panels', cmd: 'cowork.open', args: 'workDir?, prompt?', desc: 'Open BBARIT Cowork (optionally start a task)' },
  { group: 'Panels', cmd: 'marketing.open', args: 'workDir?, prompt?', desc: 'Open BBARIT Marketing (optionally start a task)' },
  { group: 'Panels', cmd: 'lounge.open', args: '-', desc: 'Open the Chat panel (global BBARIT Lounge)' },
  { group: 'Panels', cmd: 'lounge.send', args: 'text', desc: 'Send a message to the global Lounge (panel must be open and connected)' },
  { group: 'Panels', cmd: 'thread.open', args: '-', desc: 'Open the BBARIT Thread window (text SNS)' },
  { group: 'Panels', cmd: 'toolbar.toggle', args: '-', desc: 'Collapse/expand the top toolbar tool buttons' },

  { group: 'Scheduler', cmd: 'schedule.list', args: '-', desc: 'Scheduled terminal commands (id / command / schedule / nextRun)' },
  { group: 'Scheduler', cmd: 'schedule.add', args: 'command (natural language, e.g. "매일 9시에 npm run build"), terminalId?', desc: 'Schedule a terminal command — understands 매일/매주/N분마다/N분 뒤/내일 HH:MM (ko/en)' },
  { group: 'Scheduler', cmd: 'schedule.delete', args: 'jobId', desc: 'Delete a scheduled job' },
  { group: 'Scheduler', cmd: 'schedule.toggle', args: 'jobId, enabled?', desc: 'Pause/resume a scheduled job' },
  { group: 'Scheduler', cmd: 'schedule.run', args: 'jobId', desc: 'Run a scheduled job now (types it into the terminal)' },
  { group: 'Scheduler', cmd: 'schedule.panel', args: '-', desc: 'Open the Scheduler panel UI' },

  { group: 'Settings', cmd: 'config.get', args: 'path?', desc: 'Read app config (path e.g. agent.bbaritPersona)' },
  { group: 'Settings', cmd: 'config.patch', args: 'path, value', desc: 'Change one app setting (dot path)' },
  { group: 'Settings', cmd: 'persona.list', args: '-', desc: 'BBARIT Agent persona library' },
  { group: 'Settings', cmd: 'persona.set', args: 'id ("" = clear)', desc: 'Set the default persona' },

  { group: 'Utility', cmd: 'clipboard.copy', args: 'text', desc: 'Copy text to the system clipboard' },
  { group: 'Utility', cmd: 'notify', args: 'text, title?', desc: 'Show a native OS notification' },

  { group: 'All actions (palette)', cmd: 'palette.list', args: '-', desc: 'Every registered app action (the full command palette)' },
  { group: 'All actions (palette)', cmd: 'palette.run', args: 'id', desc: 'Run any palette action by id — covers every menu/action' },
];
