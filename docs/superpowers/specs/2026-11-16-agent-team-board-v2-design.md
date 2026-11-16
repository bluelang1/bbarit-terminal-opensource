# Agent team board v2: tasks, history, pluggable storage (SQLite / PostgreSQL)

Status: approved by the maintainer on 2026-11-16. This document is the source of truth for
the remaining work; update the "Progress" table when a stage lands.

Supersedes the storage and scope parts of `2026-11-16-agent-team-board-design.md` (stage 1,
notes only). Related: `2026-11-16-agent-limits-and-log-design.md`,
`2026-11-16-agent-caller-verification-design.md`, `docs/AGENT_RELAY.md`.

## 요약 (Korean summary)

- 팀 게시판에 "할 일"을 더한다. 누구나 올리고, 먼저 잡은 탭이 맡는다.
- 상태: 준비 → 작업 중 → (막힘) → (검수 대기) → 완료 / 실패 / 취소. 실패는 한도 안에서 재처리.
- 상태가 바뀔 때마다 이력을 남긴다. 완료할 때 결과(요약, 본문, 브랜치, 커밋, 검사 결과)를 적는다.
- 선행 관계, 검수 단계, 생존 신호(임대 시간)를 이번에 넣는다.
- 저장소는 SQLite(기본)와 PostgreSQL을 설정에서 바꿀 수 있다. 설정 화면에 연결 정보,
  연결 시험, 표 만들기, 데이터 복사 버튼을 둔다.
- 진행 단계는 맨 아래 "Stages"와 "Progress" 참고.

## Why

The blog experiment this feature borrows from (1 lead + 999 helpers) coordinated through
five SQL tables: announce, assign, notes, subtasks (first claim wins) and landed. Stage 1
shipped only "notes". What actually moved work there was the task list: read the plan,
claim a task, do it, mark it done, post an update. Without it two children can do the same
work and nobody can see what is left.

BBARIT is open source and will be used in setups we do not control, so the design keeps
doors open: a documented schema, text-valued states, JSON output everywhere, versioned
migrations and a storage layer that can be SQLite on one machine or PostgreSQL shared by
several.

## Goals

- A per-team task list with atomic claiming, explicit states, retry and a full history.
- Completion records: what was done, where (branch/commit/worktree), whether checks passed.
- Dependencies between tasks, an optional review step, and leases so abandoned work returns.
- Storage selectable in Settings: SQLite (default, zero setup) or PostgreSQL, with a
  connection test, explicit table creation/upgrade and a data copy between the two.
- A viewer panel for humans (notes + tasks, filters, search, history).

## Non-goals

- A general project-management tool (sprints, estimates, assignees chosen by a human UI).
- Pushing board changes into other tabs (still pull only).
- A security boundary against a hostile local process (see the caller-verification note).
- Automatic two-way sync between a SQLite board and a PostgreSQL board.

## Anti-goals

- Silent fallback from PostgreSQL to SQLite when the server is unreachable (split state).
- Creating tables in someone's PostgreSQL database without an explicit click.
- Storing the database password in config.json or returning it to the webview.
- A board outage breaking `agent run/send/stop`.

## Tables and concurrency (what the table count does and does not buy)

SQLite takes one write lock per database file, not per table, and every write goes through
the app process anyway. Splitting data across tables therefore does not add write
concurrency. What does:

- WAL journal mode: readers never wait for the writer (reads dominate: 8:1 in the blog).
- Short write transactions: a claim is one `UPDATE … WHERE state = 'open'` statement.
- `busy_timeout` (5 s) instead of failing on a momentary lock.
- Indexes that match the hot queries (below).

On PostgreSQL the same statements use row locks, so concurrent claims on different tasks
do not block each other at all. Tables are split by data shape, not for speed.

## Schema (version 2)

All timestamps are `BIGINT` unix milliseconds (portable across both engines; no time zone
handling in SQL). JSON-valued columns are `TEXT` holding JSON (portable; PostgreSQL users
can cast to `jsonb` in their own queries). States and kinds are plain text validated in
code, with no CHECK constraints, so adding a value later needs no table rewrite. Names
below are the same in both engines; PostgreSQL puts them in a configurable schema (default
`bbarit_board`).

`board_meta(key TEXT PRIMARY KEY, value TEXT)` — `schema_version`, `created_at`,
`created_by_app_version`. Replaces `PRAGMA user_version` so both engines work the same way.

`teams(team TEXT PRIMARY KEY, name TEXT, host TEXT, created_at, last_post_seq BIGINT,
last_task_seq BIGINT, last_activity_at)` — per-team counters; numbers never go backwards.

`posts(id PK, team, seq, ts, author_id, author_name, author_cli, author_host, kind, text,
task_id NULL, UNIQUE(team, seq))` — stage 1 table plus `author_host` and an optional link
to a task. Kinds: note, finding, question, decision, done, announce (root tab only; shown
first by `board read`).

`cursors(team, tab_id, seq, PRIMARY KEY(team, tab_id))` — unchanged.

`tasks`:

| Column | Meaning |
|---|---|
| id PK, team, seq (UNIQUE(team, seq)) | identity; agents use `#seq` |
| parent_id NULL | subtask tree (a task split into smaller ones) |
| title (≤200), body (≤8000) | what to do |
| state | open, claimed, blocked, review, done, failed, cancelled |
| priority (0–3, default 1) | higher first for `claim --next` |
| needs_review (0/1) | done goes through `review` first |
| created_by_id / _name / _host | who added it |
| owner_id / _name / _host / owner_instance | current claimer; instance = app instance id |
| attempt (default 0), max_attempts (default 3) | retry accounting |
| blocked_reason, last_error (≤2000) | why it stopped / why it failed last time |
| result_summary (≤500), result_body (≤8000) | what was done, written at completion |
| result_branch, result_commit, result_worktree | where the work is |
| result_checks | passed, failed, none |
| result_artifacts (JSON) | extra pointers (files, PR url, …) |
| labels (JSON array), meta (JSON object) | extension room without schema changes |
| created_at, updated_at | always set |
| claimed_at, started_at | last claim; first claim ever |
| submitted_at, finished_at | entered review; reached done/failed/cancelled |
| lease_until, heartbeat_at | see "Leases" |
| due_at NULL | optional deadline, display only |
| version (BIGINT) | optimistic concurrency for edits from the UI |

`task_deps(task_id, depends_on_id, PRIMARY KEY(task_id, depends_on_id))` — a task can be
claimed only when every `depends_on` task is `done` or `cancelled` (a cancelled dependency
counts as met and is flagged "a dependency was cancelled"; a failed one still blocks, shown as
waiting on a failed task; a cancelled task cannot be added as a dependency). Same team only.
Adding a dependency (also `add --after`) runs a bounded cycle check (depth ≤ 64) and is
refused when it would create a cycle or the walk is deeper.

`task_events(id PK, task_id, team, seq, ts, actor_id, actor_name, actor_host, action,
from_state, to_state, attempt, note, data JSON)` — one row per change. Actions: add, claim,
release, auto_release, lease_expired, block, unblock, submit, approve, reject, done, fail,
retry, reopen, cancel, edit, dep_add, dep_remove. Durations per state, who dropped what and
retry history are computed from here, so new reports need no new columns.

### Sync groundwork (amendment, 2026-11-16)

The board will later sync a local SQLite with a shared PostgreSQL (offline-first). Stage 2
lays the groundwork only; no sync worker exists.

- Row ids of `teams` (`uid`), `posts`, `tasks` and `task_events` are UUIDv7 text (36
  characters) generated in Rust; `task_deps`, `posts.task_id`, `tasks.parent_id` and
  `task_events.task_id` reference them. Other tables carry `team_uid`. The per-team numbers
  (`seq`, shown as `#12`) stay as above; the CLI takes `#seq`.
- `teams(uid PK, team, name, home_host, home_instance, created_at, last_post_seq,
  last_task_seq, last_activity_at, …, UNIQUE(team, home_host))`. Home = the machine (and
  app instance) that created the team, where its root tab lives; it owns the team's numbers
  and task state. A local write uses the team homed on this host (created on first use).
- Every synced row (teams, posts, tasks, task_deps, task_events) has `origin_host`,
  `updated_at`, `row_version` (+1 on every update) and `deleted_at` (tombstone). Clear,
  caps and the 30-day team cleanup set `deleted_at`; reads skip tombstones; tombstones older
  than 30 days are removed for good at app start. Caps count live rows. `tasks.version`
  stays the content version for viewer edits; a lease renewal bumps `row_version` but not
  `version` or `updated_at` (so "stale" still means no progress).
- `changes(local_seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl, row_id, at)`: one row per
  insert/update/tombstone of a synced row, in the same transaction (one helper,
  `log_change`; task_deps rows are keyed `<task_id>/<depends_on_id>`). Trimmed to the newest
  50 000 rows while `sync_state` has no `consumer` key. `sync_state(key PK, value)` is empty.
- `--new` cursors use local arrival order: `posts.arrival` is the change-log position of the
  post's insert, `cursors(team_uid, tab_id, arrival)`; a row that arrives later with a lower
  `seq` is still unread.
- Host ids come from one helper (host name; `BBARIT_BOARD_HOST` overrides it).

### Indexes

| Query | Index |
|---|---|
| next task to claim | tasks(team_uid, state, priority DESC, seq) |
| my tasks | tasks(team, owner_id, state) |
| children of a task | tasks(parent_id) |
| expired leases | tasks(state, lease_until) |
| what blocks / is blocked by | task_deps(depends_on_id) (+ the primary key) |
| task history | task_events(task_id, seq) |
| team activity feed | task_events(team, ts) |
| notes by kind | posts(team, kind, seq) |
| notes by time (prune) | posts(team, ts) |

## States and transitions

| State | Meaning |
|---|---|
| open | nobody has it. Shown as "waiting" when a dependency is not done (derived, not stored) |
| claimed | one tab is working on it |
| blocked | the owner stopped with a reason; still theirs |
| review | work submitted, waiting for someone else's approval (only when needs_review) |
| done | finished, result recorded |
| failed | gave up with an error; may be retried |
| cancelled | no longer needed |

"Stale" is also derived: claimed/blocked with no update for 30 minutes; shown in the
viewer, never acted on automatically (the lease handles real abandonment).

| Transition | Who | Notes |
|---|---|---|
| add → open | any team member | optional parent, deps, priority, needs_review |
| open → claimed | any member | atomic; refused when deps are not done; `claim --next` picks by priority then seq |
| claimed ↔ blocked | owner | reason required to block |
| claimed/blocked → open (release) | owner | hands it back, attempt unchanged |
| claimed/blocked → open (auto_release) | the app | owner tab closed or exited (this app instance) |
| claimed/blocked → open (lease_expired) | any instance | lease ran out (app crash, other machine) |
| claimed → done | owner | when needs_review = 0; result_summary required |
| claimed → review | owner | when needs_review = 1; result_summary required |
| review → done (approve) | any member, the root tab or a person — never the task's owner (the one who submitted it), the root tab included; only a person is exempt | |
| review → open (reject) | same as approve | reason required; attempt + 1 |
| claimed/blocked → failed | owner | last_error required |
| failed → open (retry) | any member while attempt < max_attempts; root/human beyond | attempt + 1; the previous error stays in history and in last_error |
| done → open (reopen) | root tab or human | attempt + 1 |
| any except done → cancelled | creator, root tab or human | |
| edit (no state change) | creator, root tab or person; the owner only while claimed/blocked; once done/failed/cancelled only root tab or person | changing `review`: creator, root tab or person, never the current owner (a person excepted), never while in review |
| dep add / dep rm | same as edit, on open/claimed/blocked tasks | |

A person (actor "user", the viewer) never claims, blocks, unblocks, releases, finishes,
submits or fails a task; agents do the work.

Every transition is one transaction that updates the task (guarded by the expected current
state and, where relevant, the owner) and inserts the event. A guard that matches no row is
reported as a clear error ("#12 is already claimed by b2"), never as success.

## Leases (survival signal)

Agents do not send heartbeats. The app does it for them:

- A claim sets `lease_until = now + 5 min` and `owner_instance` = this app instance id
  (random per app start, kept in memory).
- Renewal runs in the Rust host, not the webview: a worker loop (no overlap; idle while
  nothing is claimed by this instance) wakes every `renewSeconds` and renews, in one UPDATE,
  the claimed/blocked tasks of this instance whose owner tab has a live PTY according to the
  host's PTY backend (in-process or PTY holder), and releases (auto_release) those whose PTY
  is gone. It keeps working while the window is hidden, occluded or reloaded. A failed tick
  backs off (doubling) but always below `leaseSeconds / 2`; a failed release is retried on
  the next tick and its task is never renewed.
- The worker stops the moment the app exits or hands over for an update (with the PTY
  holder the tabs live on; their claims are re-adopted after the relaunch). A "PTY
  disconnected" seen by a dying webview never releases anything.
- Owner tab closed → the webview asks the host to release at once; the host does so only
  when that PTY is really gone (else the worker handles it).
- On app start (and every webview load), tasks owned by another instance on this host:
  re-adopted (instance id updated) when the PTY holder recovered their tab; released only
  when stale — heartbeat older than 2 × `renewSeconds` or lease over — so a second live app
  copy on the same database keeps its claims. This instance's own tasks are left alone.
- Any reader that sees `lease_until < now` on a claimed/blocked task may release it
  (lease_expired) inside the same transaction as its own read/claim. This is what makes a
  shared PostgreSQL board self-healing when another machine disappears.

Lease length, renew interval and stale threshold live in config
(`agents.board.leaseSeconds`, `renewSeconds`, `staleMinutes`) with clamps.

## Results at completion

`agent task done <#> --summary "<one line>" [--body -|<text>] [--branch b] [--commit sha]
[--checks passed|failed|none] [--artifact key=value …]`. Summary is required; branch and
worktree default to the caller's relay worktree when it has one. The same fields are set by
`submit` (review flow). `task show` prints them; the viewer shows them in the task detail.
A `done` post (kind done, linked by task_id) is written to the notes automatically so
`board read --new` tells teammates about it.

## Commands

Notes (stage 1, unchanged): `agent board post|read|teams|clear`. Adds `--kind announce`
(root only) and `--task <#>` to link a note to a task.

Tasks: `agent task add <title…> [--body] [--parent #] [--after #,#] [--priority n]
[--review] [--label x]`, `list [--state …] [--mine] [--ready] [--tree] [--search]`,
`show <#> [--history]`, `claim <#>|--next`, `block <#> --reason`, `unblock <#>`,
`release <#>`, `done …`, `submit …`, `approve <#>`, `reject <#> --reason`,
`fail <#> --error`, `retry <#>`, `reopen <#>`, `cancel <#>`, `dep add|rm <#> <#>`,
`edit <#> [--title --body --priority --label]`. All accept `--json`; all go through the
verified caller check; write commands need a caller in the team. `--` ends options.

Relay brief and bundled skill get a short, copy-safe loop: read notes, `task claim --next`
(or claim what the parent named), work, `task done --summary …`, post what others need.

## Limits

2000 tasks and 20 000 events per team (oldest finished tasks and their events are pruned
first; open/claimed tasks are never pruned), 5000 posts per team, text limits as in the
table. Teams with no activity for 30 days are deleted at app start (SQLite) or by an
explicit "Clean up old teams" button (PostgreSQL; never automatic on a shared server).

## Storage layer

One Rust interface (`BoardStore`) with every operation the commands need, and two
implementations selected at runtime:

- `SqliteStore` — rusqlite (bundled), WAL, busy_timeout 5 s, one connection behind a mutex,
  file `~/.config/octo/agent-board[.dev].db`, mode 0600 (db, -wal, -shm).
- `PgStore` — sqlx `PgPool` (already a dependency), max 5 connections, connect timeout 5 s,
  `statement_timeout` 5 s per session, TLS through rustls per `sslMode`.

Rules that keep the two interchangeable:

- Queries live in one place per engine behind the same function signatures; no SQL in the
  command layer or the webview.
- Only bound parameters; the PostgreSQL schema name is validated as an identifier
  (`[a-z_][a-z0-9_]{0,62}`) and quoted.
- Same column names, types and semantics; engine differences are confined to: placeholders
  (`?` / `$n`), identity columns, case-insensitive search (`LIKE` / `ILIKE`), claim-next
  (single writer / `FOR UPDATE SKIP LOCKED`), counters (`BEGIN IMMEDIATE` / row lock on
  `teams`).
- One shared behavior test suite runs against both stores: always against a temp SQLite
  file; against PostgreSQL when `BBARIT_TEST_PG_URL` is set (CI job optional, documented).
- Migrations are an ordered list per engine keyed by `schema_version`. A database newer
  than the code is refused with a clear message. SQLite migrates automatically on open;
  PostgreSQL migrates only from the Settings button or `agent board storage init`.

### Configuration

`config.json` → `agents.board`:

```json
{
  "backend": "sqlite",
  "postgres": { "host": "", "port": 5432, "database": "", "user": "",
                "sslMode": "prefer", "schema": "bbarit_board" },
  "leaseSeconds": 300, "renewSeconds": 60, "staleMinutes": 30
}
```

The password is never in config.json. It is written to `~/.config/octo/agent-board.secret`
(0600, `.dev` variant for debug builds) through a write-only command; the webview can ask
"is a password saved?" but never read it. `BBARIT_BOARD_DATABASE_URL` (process env or
`~/.config/octo/.env`) overrides everything, for teams that provision by environment. An OS
keychain backend is a possible later improvement (needs a new dependency; not in scope).

### Settings UI ("Agent team board" group)

- Storage: SQLite (this Mac) / PostgreSQL (shared).
- PostgreSQL fields: host, port, database, user, password (write-only, shows "saved"),
  SSL mode, schema name.
- Test connection → reports: reachable, server version, TLS in use, schema present,
  schema version, privileges (can create / can read-write), and what to do next.
- Create / upgrade tables → runs the migrations in the configured schema; shows what it
  will run first; refuses when the schema belongs to a newer app version.
- Copy data → copies teams, posts, tasks, deps, events and cursors from the other backend
  into the selected one (empty target or explicit "merge teams that do not exist there");
  never deletes the source.
- Status line: current backend, schema version, counts, last error.
- Switching takes effect for the next command; nothing is copied automatically. When
  PostgreSQL is selected but unreachable, board commands fail with
  "team board unavailable: …" and everything else in the relay keeps working.

These settings commands are not `agent.*` UI commands: agents cannot switch the backend,
read connection settings or trigger table creation through `bbarit-ctl`.

### What changes with a shared PostgreSQL board

- Several machines can read and write the same teams. Tab ids are unique enough across
  machines (timestamp + random); every row also records `*_host`.
- Caller verification stays local to each app. On a shared server, trust is the database
  credentials: anyone with them can write. Documented plainly.
- Auto-release covers only this instance's tabs; other machines' abandoned tasks return
  through the lease.
- Live refresh in the viewer uses the local event for local writes and a slow poll
  (existing poller rules) for remote ones. `LISTEN/NOTIFY` is a later improvement.

## Viewer panel

Opened from a button next to the stop-team button (shown when a team exists) and from the
menu. Team selector; two tabs. Notes: stage-1 posts with kind/author/search filters,
announcements pinned. Tasks: list or tree, grouped by state, with owner, attempt,
waiting/stale badges; detail pane with body, result, dependencies and the event history.
Human actions (not through ctl, author "user"): post a note or announcement, add/edit/
cancel/reopen/retry/approve/reject a task, clear a board. Korean and English strings; a
getting-started guide step.

## Approaches considered

1. Notes only (stage 1 as is). Smallest; cannot prevent duplicate work. Rejected.
2. The blog's five tables verbatim. `assign` duplicates task ownership at our scale (12
   agents app-wide) and `landed` duplicates a task's completion record. Rejected.
3. Notes + tasks with history, dependencies, review and leases, on a pluggable store
   (chosen). Covers all five roles with tables split by data shape and leaves room for
   shared PostgreSQL boards.

For storage: SQLite only (simplest, single machine); PostgreSQL only (needs a server for
everyone); both behind one interface (chosen: zero-setup default, shared option for teams).

## Stages

Each stage: implement → code review → check in the dev app → PR. UI stages are checked by
the maintainer in the dev app before merge.

| Stage | Content |
|---|---|
| 1 | Notes on SQLite + `agent board` CLI |
| 2 | Store interface, schema v2 (`board_meta`, tasks, deps, events, leases), `agent task` CLI, brief/skill, lease renewal and auto-release |
| 3 | PostgreSQL store, config, secret file, settings UI (test, create/upgrade, copy), shared-suite tests |
| 4 | Viewer panel (notes + tasks), human actions, guide step |

## Progress

| Stage | State | Where |
|---|---|---|
| 1 | done: implemented, reviewed, checked in the dev app | first PR from branch `feat/agent-board` (stages 1+2 together) |
| 2 | done: implemented, reviewed twice (store; app/CLI), checked in the dev app (claim, deps, review flow, fail/retry, tab-close release, lease renewal, claims surviving quit/relaunch with the PTY holder) | same PR; notes in "Stage 2 notes" below |
| 3 | not started | |
| 4 | not started | |

## Stage 2 notes (builder's choices inside the rules)

- `BoardStore` is an enum with async methods (no `async-trait` dependency); stage 3 adds a
  `Pg` variant. Every SQL statement for SQLite is in `agent_board/sqlite.rs`; the transition
  rules are one pure function (`model::check_transition`) both engines call.
- `user_version` mirrors `board_meta.schema_version`, so a stage-1 app refuses a v2 file
  with "newer app version" instead of failing on renamed columns.
- `edit` and `dep add/rm` rules are in the transition table (review fix M1/S2); at most 32
  dependencies per task. A walk deeper than 64 levels is refused like a cycle.
- Review fixes (2026-11-16): lease renewal moved to the host (PTY liveness via
  `PtyBackend::alive`, `agent_board::start_lease_worker`), owner self-approval refused for
  the root tab too, cancelled dependencies count as met, tombstone purge waits while a sync
  consumer exists, a person never works on tasks, the event cap prunes nothing when finished
  tasks cannot cover the excess.
- Lazy lease expiry skips the task its own owner is writing to (the owner proved it is
  alive; that write renews the lease). Reads expire in their own short write transaction,
  only when something actually expired.
- `reject` stores its reason as `last_error = "rejected: …"` so the next claimer sees it.
- Finished tasks that a live task depends on, or that are the parent of a live task, are not
  pruned by the caps; when nothing can be pruned, `add` is refused.
- Announcements: a plain `board read` returns the newest three apart and leaves them out of
  the list; `--new` shows them in order with the other unread posts.
- `claim --next` with nothing ready exits with code 4 in `bbarit-ctl`.

## Left to the builder

Exact Rust module split, SQL text, CLI table layouts, panel layout details, test names.
Anything that changes a rule in "States and transitions", "Leases", "Storage layer" or the
anti-goals comes back to the maintainer first.
