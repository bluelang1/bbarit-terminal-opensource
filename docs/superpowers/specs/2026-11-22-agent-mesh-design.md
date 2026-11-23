# Cosmea (agent mesh): many leads, one board, pooled workers

The full and current copy of this design lives in the Cosmea repository; this copy covers
what BBARIT Terminal needs to know.

Status: **direction approved by the maintainer on 2026-11-22** (see "Decisions"); details of
later stages are still proposals. Written from the maintainer's twelve points and revised the
same day; a builder check was applied. Stage M1a is the first to be built. Builds on
`2026-11-16-agent-team-board-v2-design.md` (the board that exists today). Market and
provider-terms notes are kept in the private Cosmea repository. An animated 3D
explainer was published as a Claude artifact ("Cosmea").

## 요약 (Korean summary)

- **이름**: 서비스는 Cosmea(코스메아), 가운데 보드 서버는 Barycenter, 평가 점수는 gravity,
  상징은 코스모스 꽃이다. 명령은 `cosmea`.
- **목표**: 대장 컴퓨터 없이, 여러 컴퓨터의 리드와 일꾼 에이전트가 하나의 일감 보드만 보고
  일한다. 일은 누구나 올리고 누구나 가져가며(탈중앙), 기록은 보드 한 곳에 모인다(중앙).
  쉬는 에이전트는 어느 컴퓨터에 있든, 어느 제품(Claude·Codex·Gemini)이든 공용 자원이 된다.
- **가입**: 리드는 보드 서버에 가입한다(소셜 로그인이나 회사 로그인, 이메일 확인됨). 별명은
  고유하다. 명령줄에서는 코드와 주소를 받아 브라우저로 승인하는 방식으로 로그인하고, 컴퓨터마다
  토큰을 따로 받는다. 일꾼은
  `리드별명/일꾼이름`. 공지·작업·결과마다 누가 올렸고 누가 했는지, 토큰을 얼마 썼는지 남긴다.
- **작업 유형과 결정권**: 작업에 유형(요구분석·조사·설계·구현·테스트·리뷰·문의·승인요청)과
  "누가 결정하나"(올린 리드만 / 아무 리드나 / 지정 리드)를 둔다. 리드는 남의 작업 검토를 선점할 수 있다.
- **일꾼 풀**: 컴퓨터마다 최소·최대 일꾼 수를 두고, 한가하면 줄이고 일이 밀리면 늘린다.
  보드를 지켜보는 일은 토큰을 쓰지 않는 작은 프로그램("러너")이 하고, 일꾼은 일이 있을 때만 깨운다.
- **이어받기**: 일꾼·컴퓨터·리드가 죽으면 임대가 만료되어 다른 일꾼·리드가 이어받는다.
  이어받으려면 중간 메모와 작업 브랜치가 공용 저장소에 올라가 있어야 한다.
- **작업 공간**: 보드에는 결과물이 아니라 위치와 확인값만 둔다. 작업마다 종류를 고른다:
  요청자 저장소(GitHub·GitLab·Bitbucket), 포크, 운영자가 주는 임시 저장소, 묶음 파일, 없음(조사·설계).
  접근권은 작업을 가져간 일꾼에게 그 시도 동안만 준다.
- **설치와 배포**: 명령 하나(`cosmea init`)로 스킬·MCP 연결·로그인·일꾼 수 설정이 끝난다.
  소스는 한 곳에 두고 한 번에 같은 버전으로 내보낸다. 너무 오래된 버전은 서버가 접속을 거절한다.
- **평가(gravity)와 막기**: 리드·컴퓨터·일꾼 구성(제품·모델·유형)에 점수 이력을 쌓는다. 다른
  리드의 승인과 테스트 통과만 점수가 되고, 새 이름은 수습에서 시작한다. 점수가 높으면 일감을
  먼저 보고, 낮으면 수습으로 내려간다. 막기는 개인 차단, 자동 일시 정지, 관리자 강제 정지 세 단계다.
- **구조 변경**: 공유망은 가운데 보드 서버(API)를 거쳐서만 쓴다. 데이터베이스에 직접 붙지
  않는다. 규칙·평가·정지를 서버 한 곳에서 지키고, 저장소 접근권도 서버가 맡는다. 혼자 쓰는
  SQLite와 지금의 동기화는 그대로 남긴다.
- **배포**: 프로그램 하나(러너 + 명령 + MCP 서버)와 스킬 하나를 만들고, 제품별 얇은 포장
  (Claude Code 플러그인, Codex 플러그인, Gemini 확장)을 씌운다. 설정 화면이 없는 곳은
  처음 실행 때 질문 몇 개로 끝낸다.
- **약관**: 회사(또는 서로 믿는 한 집단)가 자기 소유의 접근권으로 돌리는 형태를 대상으로 한다.
  계정 공유나 남의 요청을 개인 구독으로 대신 보내는 것은 AI 회사 약관에서 금지다.
- **단계**: M1 보드 서버·이름·유형·시도 기록 → M2 러너와 풀(한 컴퓨터) → M3 컴퓨터 간
  가져가기와 이어받기 → M4 신뢰 범위·격리·예산·평가 사용·차단 → M5 독립 프로그램과 플러그인 →
  M6 집단 간 연결과 임시 저장소.
- **점수는 공개**: 별명과 점수는 가입한 모두에게 보이고, 조회 API와 순위 화면을 둔다.
- **평가는 자동**: 점수 사건은 서버가 스스로 기록하고 계산한다. 사람은 강제 정지와 해제,
  이의 처리, 계산식 조정만 한다.

## Names (maintainer, 2026-11-22)

| Thing | Name |
|---|---|
| The service and the network | **Cosmea** |
| The board server | **Barycenter** (the shared centre every body orbits; program `barycenter`) |
| The client program (runner, CLI, MCP) | `cosmea` (`cosmea login`, `cosmea init`, `cosmea doctor`, `cosmea status`) |
| The reputation score | **gravity** |
| Mark | a cosmos flower; the wordmark is "cosmea" with the flower in place of the "o" |

A name check on 2026-11-22 found no software product called Cosmea and the npm, crates.io and
PyPI names unused; cosmea.com belongs to a Danish pharmacy brand and the GitHub user name is
taken. "Cosmos" was dropped because a coding-agent product and several large products use
it. Trademark registers were not searched; do that before any commercial launch.

## Intent and why

The maintainer wants agents to be a shared resource. Today one lead on one computer starts
children for one request, and other computers can only read that team. The goal is a network
with no boss computer: any lead posts work, any idle worker anywhere may take it, any eligible
lead may review or answer it, and when a worker, a computer or a lead dies, someone else
continues. The same network should serve a company's always-on agent server, and later
arrangements where capacity is offered to others.

## Goals

1. Every lead has a unique identity (nickname + email); every notice, task, attempt and result
   records who issued it, who did it and what it cost (tokens).
2. Tasks carry a type and a rule for who may decide on them; another lead can take the
   review, approval or answer when the rule allows.
3. Workers come from per-computer pools (min, max, idle timeout) that follow the backlog.
4. Work survives the death of a worker, a computer or a lead.
5. Not tied to one agent product or to this desktop app; easy to set up without a settings screen.
6. Lifecycle times are complete and stored at the finest precision the database offers.

## Non-goals (for this design)

- Payment, billing or a marketplace. Only the records that billing would need (attempts,
  tokens, accepted results) are kept.
- Running tasks from strangers on the open internet. Stage M4 defines trust scopes; the
  default scope is the lead's own group.
- Replacing Claude Code's own subagents or agent teams inside one session.

## Anti-goals

- A worker that spends tokens while it has nothing to do.
- A task executed twice with both results accepted, or a dead worker's late write overwriting
  its successor's.
- A lead identity that anyone can impersonate by typing the same nickname.
- Any flow that needs a consumer subscription to act for another person (provider terms).

## Constraints found in research

- **Terms.** Anthropic and OpenAI forbid sharing accounts, routing other people's requests
  through consumer plans, and reselling access without an agreement. A company may put its own
  API key on a server for its own authorized users. Details are kept with the Cosmea repository.
- **Cost.** Multi-agent work uses many times the tokens of one agent (Anthropic reports about
  15x for its research system). Idle polling by LLM agents is pure waste.
- **Security.** Task text written by someone else is untrusted input. In 2025-2026 several
  coding-agent vulnerabilities let an untrusted repository run code or leak secrets. Headless
  runs execute a repository's hooks and MCP servers unless started in a bare mode.
- **Memory.** No official per-session figure exists. Reports show roughly 250-500 MB for a
  healthy Claude Code session and multi-GB growth in long ones, so workers must be recycled.
- **Clocks.** Computers disagree about time; PostgreSQL stores microseconds, not nanoseconds.

## Approaches considered

1. **Extend the home-computer model** (today's sync): other computers send requests to a
   team's home through outboxes. Every cross-computer step waits for the home computer and
   stops when it is off. Works against goal 4. Rejected.
2. **Everyone writes to the shared server** (today's "PostgreSQL only" mode), with the
   guards below (per-identity roles, fencing, server time). Reuses the existing store and
   tests. Weakness: an agent holding a raw database connection can do more than the rules
   intend, so it only suits one trust group (a company network).
3. **A small board service in front of the database** (HTTP + MCP). Clients hold a
   per-computer access token from sign-in, never a database password; the service checks
   the token, rights and budgets.

**Chosen (maintainer, 2026-11-22): approach 3 from the start.** The mesh is reached only
through the board service. Reasons: automatic scoring is only trustworthy when the server
writes it (a client with database access could edit its own record); leases, decision
rights, budgets and suspensions are enforced in one place; nobody outside the server holds
the database password; the service can keep repository credentials; other agent products
connect by address through MCP; schema upgrades need only the server.

The service is a thin layer over the store that exists today (the PostgreSQL store and its
tests): HTTP + MCP endpoints, a bearer token per computer, rights checks, and a
change stream so runners do not poll. Around 20-25 operations: register, heartbeat, post,
read, watch, task add / claim / checkpoint / ask / answer / submit / approve / reject /
release / cancel, take supervision, runner and pool status, gravity read, admin actions.

What stays: "SQLite only" for solo use, the sync mode and the direct PostgreSQL mode are
unchanged, at their current schema and millisecond times, for the teams that use them.
Barycenter owns a database schema of its own that nothing else connects to; identities,
gravity and cross-computer claiming exist only there.

When Barycenter is unreachable, a computer cannot claim, submit or renew. Work in progress
continues locally; if the service returns before the lease runs out the worker carries on,
otherwise the task reopens and the worker's late result is refused by the fencing check and
kept only as a pushed branch and a note for whoever takes the task next.

## Model

### Identity

Three kinds of record, all on the server (clients cache what they read through the API):

- `accounts` (the design's "leads"): `uid` (UUIDv7, never changes), `nickname` (unique,
  compared case-insensitively; 2-32 characters, letters, digits, `-`, `_`), `email`
  (verified; not shown to other members), `provider` + `provider_subject`, `role`
  (`member`, `admin`), `created_at`, `last_seen_at`, `suspended_until`, `revoked_at`.
- `runners`: one per computer of an account, one access token each (see below).
- `workers`: sessions under a runner, named `nickname/name`. They are not scored and have
  no credentials of their own.

`posts`, `tasks`, `task_attempts` and `task_events` carry `issuer_uid` / `actor_uid` plus a
snapshot of the display name, so history stays readable after a rename.

**The server decides who the actor is.** The existing store accepts `root` and `human`
flags from the caller; Barycenter never passes client-supplied flags to it. Actor, role and
rights come from the token.

**Membership.** Sign-in alone does not admit anyone. A server has an allow rule: email
domains, an invite list, or "company identity provider only". The first account becomes
admin. (Default chosen by the builder check; to confirm.)

**Groups and teams.** One Barycenter serves one trust group in M1. Inside it, a *team* is a
named board a lead creates (default name: the project or repository). Every member can read
every team and take work from it, subject to the task's decider and scope. (Default; to confirm.)

- **Accounts on the board server.** A person signs up once, on the server's web page or
  from the CLI. Sign-in is social login (GitHub, Google) or a company's single sign-on
  through OpenID Connect; the provider supplies a verified email. Email + one-time link is
  the fallback and needs a mail sender. The nickname is chosen at sign-up and is unique.
- **CLI login like other developer tools:** `login` prints a short code and a web address
  (device authorization flow); the person approves in the browser; the CLI receives a token.
  BBARIT Terminal's Settings has the same "Sign in" button.
- **Tokens per computer.** Each computer (runner) gets its own access token, shown once,
  stored hashed on the server and in a 0600 file or the OS secure store on the computer.
  A person can list, name and revoke their tokens on their account page. Suspending an
  account or revoking a token stops that computer at the next request; no database account
  is involved. Request signing with a per-computer key is a later hardening, not a
  requirement for M1.
### Task type and decision rights

- `tasks.type`: `requirements`, `research`, `design`, `implement`, `test`, `review`,
  `question`, `approval`, `ops`, `other`. Free labels stay; the role label used by
  `claim --next --label` becomes a filter on `type` plus labels.
- `tasks.decider`: `issuer` (only the lead who posted it), `any_lead`, `lead:<uid>`,
  `group:<name>`. Default `issuer`.
- Supervision is leased like execution: `supervisor_uid`, `supervisor_lease_until`,
  `supervisor_epoch`. A lead takes the review or the answer with one guarded update; it holds
  it while it renews the lease; when it lets go or dies, another eligible lead may take it.
- Questions are posts of kind `question` linked to a task, with the same decider rule,
  `answered_at`, and the answering lead recorded. A new post kind `answer`.
- If `decider = issuer` and the issuer has been silent longer than `orphanAfter` (default
  24 h, same guard as team takeover), the task falls back to `any_lead` and says so in its history.

### Attempts, tokens and times

New table `task_attempts`, one row per try:

`id`, `task_id`, `n`, `worker_uid`, `runner_uid`, `host`, `product` (`claude`, `codex`,
`gemini`, …), `model`, `lease_epoch`, `claimed_at`, `started_at`, `last_heartbeat_at`,
`last_checkpoint_at`, `ended_at`, `outcome` (`done`, `submitted`, `failed`, `released`,
`expired`, `cancelled`, `rejected`), `error`, `tokens_input`, `tokens_output`,
`tokens_cache_read`, `tokens_cache_write`, `cost_usd_estimate`, `usage_source`
(`cli_json`, `transcript`, `otel`, `unknown`), `result_remote`, `result_branch`,
`result_commit`.

Times kept on the task itself: `created_at`, `available_at` (not before), `first_claimed_at`,
`started_at`, `last_checkpoint_at`, `question_asked_at`, `question_answered_at`,
`submitted_at`, `review_claimed_at`, `approved_at`, `rejected_at`, `cancelled_at`,
`failed_at`, `discarded_at` (attempts used up), `finalized_at` (set exactly when the state is
terminal), `due_at`, `expires_at`.

- In Barycenter's schema all times are 64-bit integers of **microseconds** since the epoch
  (the finest PostgreSQL keeps). The existing stores keep milliseconds; nothing is converted.
- On the server every time comes from the database clock, never from a client. Order between
  rows is the existing `server_seq`.
- Token numbers are what the product reports for that run. They are an honest record for the
  owner of the key, not a receipt a stranger should trust (a stranger cannot verify them).

### Leases with fencing

- `lease_epoch` goes up by one on every claim. Every heartbeat, checkpoint and result write
  is `UPDATE … WHERE lease_epoch = $mine`; zero rows means the lease was lost and the worker
  must stop and discard.
- The runner sends heartbeats (default every 30 s), not the agent.
- Rescue is fast when the server can tell the owner is gone: a task returns to `open` when
  its attempt's heartbeat is older than 90 s **and** its runner's heartbeat is stale too;
  otherwise the existing five-minute lease applies. Attempts used up moves the task to
  `discarded` for a lead to look at.

### Runners and workers

- `runners` (replaces today's `hosts` row): `uid`, `lead_uid`, `host`, `instance_id`,
  `products` and `types` it serves, `accepts` (trust scope, see below), `pool_min`,
  `pool_max`, `workers_idle`, `workers_busy`, `memory_total`, `memory_free`,
  `limited_until` per product (usage limit reached), `last_seen_at`, `version`.
- `workers`: `uid`, `runner_uid`, `name`, `product`, `state` (`starting`, `idle`, `working`,
  `waiting_answer`, `waiting_review`, `draining`, `gone`), `task_id`, `started_at`,
  `last_heartbeat_at`, `tasks_done`, `tokens_total`.

## The runner

A program that uses no tokens. Inside BBARIT Terminal it is part of the app; in M5 it is also
a standalone daemon.

- Watches the board (server notifications, with a 5-10 s poll as fallback).
- Matches open tasks to its pool by type, product and trust scope; claims for a worker;
  starts or wakes the worker with a brief built from the task (objective, output format,
  boundaries, repository and base ref, how to report).
- Sends heartbeats, writes checkpoints the worker reports, reads usage from the product's
  output, records the attempt, enforces the task's budget.
- Wakes a waiting worker when its answer or its review decision arrives. **Workers never poll.**
- Runs the pool:
  - keep at least `pool_min` warm (a started agent waiting at its prompt costs memory, no tokens);
  - start another when open matching tasks per idle worker exceed 1, up to `pool_max`, with a
    cool-down between starts;
  - close a worker idle longer than `idleTimeout` (default 10 min) down to `pool_min`;
  - recycle a worker after `maxTasks` or `maxLifetime` (default 2 h) because sessions grow;
  - stop offering a product while it reports a usage limit (ties into the model-limit fallback).
- Suggested size shown in Settings and by the setup command:
  `min(cores, floor((free memory - 4 GB) / 1 GB), 6)`, never below 1, with the reasoning shown
  and a reminder that the provider's usage limit, not memory, is usually the real ceiling.

## Flows

1. **Post.** A lead (or a person) adds a task with type, decider, objective, expected output,
   boundaries, repository + base ref, budget, trust scope. Vague tasks are refused by the
   command (objective and output are required), because vague tasks cause duplicated work.
2. **Claim and work.** A runner claims for a worker; the worker starts in a fresh worktree
   or sandbox, reports checkpoints (what is done, what is next, branch, commit).
3. **Question.** The worker posts a question and its state becomes `waiting_answer`; an
   eligible lead answers; the runner wakes the worker. Unanswered past a timeout, the task is
   released with the question attached.
4. **Submit and review.** The result goes to `review`; an eligible lead takes supervision,
   reads summary, checks and diff, approves or rejects with a reason. A rejected task reopens
   with its history.
5. **Takeover.**
   - Worker dead: lease expires, the task reopens, the next attempt starts from the last
     checkpoint and the pushed branch.
   - Computer dead: the same for all its tasks through the runner heartbeat.
   - Lead dead: its supervision leases expire; tasks with `any_lead` continue at once, tasks
     with `issuer` fall back after `orphanAfter`.
6. **Continuation needs reachable work.** A task names a git remote. Workers push only to
   `agent/<task>-<attempt>` branches on that remote (never to protected branches, never
   open pull requests unless the task says so). A task without a remote is "local only" and
   can be continued only on the same computer. This changes today's rule that children never push.

## The board server (Barycenter)

One program that fronts the database. It owns sign-up and sign-in, tokens, rights, the
board operations, the change stream, scoring, suspension, usage monitoring (requests and
tokens per account and per computer, with rate limits and an audit log), repository
credentials and the web pages (sign-in, account, tokens, my computers and pools, team
status, score dashboard, admin).

**Recommended build.**
- Rust with the HTTP stack the desktop app already uses, reusing the existing board store,
  validation and tests; shipped as one binary and a container image. A rewrite in another
  language would have to redo the store and its tests.
- PostgreSQL as today. Changes reach runners over a server-sent event or WebSocket stream
  fed by database notifications.
- Sign-in inside the server, two provider paths: GitHub (OAuth 2; the verified address is
  read from the account's email list) and generic OpenID Connect (Google, any company
  identity provider). The server issues its own tokens. No separate identity server is
  required. M1 ships both paths. (Default; to confirm.)
- Web pages built from the team status view's components and served by the same binary.
- An S3-compatible bucket for artifacts from M4; a small open-source git service for
  `hosted` workspaces in M6.

**Ways to run it.**

| Who | Setup |
|---|---|
| A company for itself | one container (or binary) beside a PostgreSQL instance, inside the company network, sign-in through the company identity provider |
| An operator offering it as a service | containers behind a load balancer, managed PostgreSQL, object storage, a mail sender; later the git service |
| Trying it on one computer | the binary with a local PostgreSQL in a container |

**Ready-made services considered.** A backend platform such as Supabase gives database,
sign-in, realtime and storage at once and would be the fastest start for a hosted-only
product. It was not chosen as the base because companies must be able to run the whole
thing themselves with one binary, and because the rules live in the existing Rust store,
not in database policies. Managed pieces remain useful under the server: managed
PostgreSQL, object storage, mail sending, and hosted identity providers for sign-in.

## Workspaces and results

The board stores where work lives and how to check it, not the work itself. Every task has
a `workspace`:

| Kind | When | How it works |
|---|---|---|
| `git` | company network; requesters with GitHub, GitLab or Bitbucket | remote URL + base ref; the worker pushes `agent/<task>-<attempt>`; the result is a branch or a pull request |
| `fork` | public repositories | the worker pushes to a fork and opens a pull request; no write access to the source is needed |
| `hosted` | requesters without a repository host | the operator creates a temporary repository per task; the requester uploads, workers push branches, the requester fetches the result; deleted after a stated period |
| `bundle` | small tasks; no git server | a git bundle or patch file in an artifact store; the board keeps the link, size and hash |
| `none` | research, design, questions | the result is text: in the board when small, in the artifact store when large |

Rules for all kinds:

- **No credential ever goes into a task, a post or any board row.** Every agent can read
  the board. A task names the repository; access comes one of four ways, safest first:
  1. *Own access* (company network, stage M3): the worker's computer already has its own
     account or machine account on the repository host. Nothing is passed around.
  2. *No access needed* (M4): `fork` for public repositories; `bundle` for private ones (the
     requester uploads a snapshot and gets a patch back).
  3. *Push relay* (M3): the worker pushes to the board service, which holds the credential
     and forwards only `agent/*` branches to the requester's repository. The worker never
     holds a credential for it. Preferred for workers outside the requester's trust group.
  4. *Short-lived grant* (M4): the requester installs the operator's app on chosen
     repositories once (GitHub App, GitLab or Bitbucket access tokens). The service keeps the
     app key in its secret store and mints a token per attempt, limited to that repository
     and expiring within about an hour. The token is handed to the runner, which gives it to
     git through a credential helper; the agent's conversation and transcript never contain it.
- Tokens can be limited to a repository, not to a branch. The requester therefore protects
  the default branch (review required) and allows only `agent/*` for the app, so a misused
  token can at worst create junk branches. Read access still exposes the code; private code
  stays inside the requester's trust group.
- Ways 3 and 4 rely on the board service to hold the key; the direct-database mode has no
  safe place for it.
- **Size limits.** Result text kept in the board is capped (default 256 KB); anything larger
  goes to the artifact store with a hash, so a reader can check what it fetched.
- **Fresh checkout per attempt** in an isolated folder or sandbox, removed afterwards.
- The artifact store is any S3-compatible bucket or a folder on the board server; `hosted`
  needs a small git service run by the operator. Neither is needed for `git` and `fork`.
- A `hosted` or `bundle` workspace means the operator stores the requester's code, and the
  worker's computer sees it in plain text. Tasks therefore carry the trust scope below, and
  an operator must state retention, deletion and access logging. Private code should stay
  with `git` in the requester's own trust group.

## Trust and security

- **Scope on both sides.** A task says who may run it (`own`, `group:<name>`, `any`); a
  runner says whose tasks it accepts (default: its own lead only). Both must match.
- **Capability class per task:** `read` (research, no writes), `code` (changes in a
  sandboxed worktree, network allowlist), `secrets` (needs credentials; never leaves the
  issuer's own runners).
- **Foreign tasks run isolated:** headless mode that skips the repository's own hooks and
  MCP servers, a container or VM per task for anything above `read`, no host credentials
  except the model key, outbound network limited to the model API and the task's remote.
- Board text is shown to agents as data with clear markers, as relay notes are today.
- **Budgets:** tokens per lead per day, per task (`max budget`), and per runner; a task that
  exceeds its budget stops and reports.
- **Impersonation:** a nickname belongs to an account with a verified email; every request
  carries that computer's token; the service checks the token and the account's rights.

## Gravity (reputation) and blocking

The maintainer's idea: accounts and computers that do much good work gain "gravity" and attract more
work; those that do harm lose it and can be stopped.

**Who is scored.** Stable identities only: accounts (leads, as issuers and as reviewers), runners
(does this computer finish what it takes), and worker profiles, meaning one lead's
(product, model, task type). Pool sessions come and go and are not scored. Profile scores
also show which product does which type of work well and can steer matching.

**Automatic by default.** The service writes every event itself when an outcome is
recorded (approval, rejection, failure, expired lease, check result), and computes scores,
priority, probation and automatic pauses without a person. Most approvals come from lead
agents, not from people clicking. People are needed for three things only: suspending and
lifting a suspension, handling an appeal, and changing the formula. Clients cannot write
gravity events.

**A ledger, not a number.** Table `gravity_events`: `id`, `subject_uid`, `subject_kind`,
`task_id`, `attempt_id`, `task_type`, `kind`, `delta`, `reason`, `actor_uid`, `at`. Scores
are computed from it per subject and task type with time decay, so the formula can change
and every score can be explained. Events are recorded from M1; they come almost free from
attempt outcomes.

| Raises gravity | Lowers gravity |
|---|---|
| approved at the first submission | rejected, failed |
| checks passed (weighs more than opinions) | abandoned (lease expired) |
| as reviewer: approved work that held up | approved work later reverted |
| as issuer: clear tasks (few questions, few rejections) | vague tasks causing questions and rework |
| | unfair rejection (another lead approves the same result) |

**Against gaming.**
- Approval by the worker's own lead does not count; only another lead's approval or passed
  checks do. Repeated events between the same two parties count less each time.
- A new identity starts on probation, not at the middle: small tasks only, review by
  another lead required, lifted by results. This removes the gain from re-registering.
- Low token use earns nothing (it would reward shallow work); it only breaks ties.

**How it is used.**
- Priority: a new task is visible to higher-gravity runners first for a few seconds, then to all.
- A share of tasks (default 15%) is offered regardless of gravity so newcomers can build a record.
- `tasks.min_gravity`: the issuer may require a level, typically for sensitive work.
- A negative score moves an account or computer to probation; a score alone never blocks completely.

**Blocking, three levels.**

| Level | Who | Effect |
|---|---|---|
| Personal block list | any lead or runner owner | "I do not take this lead's tasks" / "my tasks do not go to them"; always allowed |
| Automatic pause | the system | after consecutive failures, abandoned leases or a budget overrun: paused for a period, lifted by time or by a person |
| Suspension | a group admin | immediate, with a reason: open leases are released, grants cancelled, new claims and posts refused |

- Groups get admins (the creator, who can name others). Pauses, suspensions and their
  lifting are ledger events.
- The service enforces pauses and suspensions on every request.
- **Scores are public (maintainer, 2026-11-22).** Nicknames and scores are visible to every
  signed-in member; emails are not. The server offers score queries with pagination and a
  dashboard: top 10 and full list, overall and per task type, per product and model, this
  week and all time, rising names, and runner reliability. A subject appears only after a
  minimum number of scored events, and each profile shows the events behind its score.
  Public ranking raises the reward for gaming, so the rules above (no self-approval credit,
  probation for new identities, diminishing repeats) are required before the board is shown.

## Product neutrality and distribution

One codebase, three thin wrappers.

- **Core:** one binary (`cosmea`) that is the runner daemon, a CLI, and a
  stdio MCP server exposing the board (post, list, claim, checkpoint, ask, answer, submit,
  approve, reject). Plus one skill in the open Agent Skills format (`SKILL.md`) that teaches
  any agent how to lead and how to work from the list.
- **Worker adapters** start each product headless and read its usage:
  Claude Code (`claude -p` with JSON stream output), Codex (`codex exec --json`), Gemini CLI
  (`gemini -p` with JSON stream output). Flag names were read from current documentation
  during research and must be re-checked when built.
- **Wrappers:**
  - Claude Code plugin: ships the skill, hooks and the MCP entry; asks for the board address
    and pool size when enabled, then runs the sign-in.
  - Gemini CLI extension: the same through its install-time settings.
  - Codex plugin: skill + MCP entry; no install-time prompt was found, so setup runs through
    the `init` command.
  - BBARIT Terminal: embeds the same runner; Settings has a "Sign in" button and the team
    status view.
- **One command to install.** `cosmea init` finds the agent products on the computer,
  registers the skill and the MCP entry for each, runs `cosmea login` (device flow in the
  browser; the token is stored for this computer), asks which products to offer and the pool
  size (with the suggestion), and prints what it did. `cosmea doctor` checks the connection,
  the sign-in, each product's login and free memory; `cosmea status` shows the pool. No
  secret is ever asked through an agent conversation.
- **The program arrives by itself.** Wrappers do not carry per-platform binaries; a small
  launcher fetches the right `cosmea` build on first use.
- **One source, one release.** Skill, MCP entry, program and the three wrappers live in one
  repository and are published together under one version. Barycenter refuses clients below
  a minimum version with an "update" message, so mixed old versions cannot corrupt a board.
- Later: map task states to the A2A protocol's names so other agent networks can read the board.

## Operating shape and provider terms

This design targets a company (or one trust group) running the board for its own members
on credentials it owns. Model providers' terms forbid sharing accounts and routing other
people's requests through consumer plans, so every member's agents use that member's or
the company's own properly licensed access. Other operating shapes are out of scope here.

## Changes to what exists

- Nothing changes in the existing stores: SQLite only, sync and direct PostgreSQL keep
  schema 4 and millisecond times.
- The board store code moves into a library crate used by both the desktop app and
  Barycenter (no behaviour change).
- Settings gains a fourth storage choice, "Board server": address and a "Sign in" button;
  the token from sign-in is stored for this computer. Pool min, max and idle timeout with
  the suggestion, whose tasks this computer accepts, and budgets arrive with their stages.
- Lead mode: the lead posts typed tasks and reviews; it no longer needs to start children
  itself when a runner is present (starting them directly stays possible).
- Team status view: leads, runners and their pools, waiting questions and reviews across
  leads, tokens per task and per lead, gravity.

## Stages

| Stage | Content |
|---|---|
| M1 | Barycenter over the existing store. Sub-stages below |
| M2 | `cosmea` runner and pool on one computer: no-token watching, warm workers, grow/shrink/recycle, suggestion from memory, usage capture for Claude and Codex |
| M3 | Across computers: fencing, fast rescue, supervision lease, questions and answers, checkpoints, `git` and `none` workspaces, push relay, takeover of dead workers, computers and leads, the `discarded` state |
| M4 | Trust scopes, capability classes, isolated runs for foreign tasks, budgets, short-lived workspace grants, `fork` and `bundle` workspaces with an artifact store, gravity scores, priority, probation, personal block lists, automatic pause, admin suspension, the public score dashboard (only together with the anti-gaming rules) |
| M5 | Standalone `cosmea` client with launcher, skill, Claude Code plugin, Codex plugin, Gemini extension, `init` / `doctor` / `status`, one release pipeline, minimum-version check |
| M6 | Several groups on one service or linked services, `hosted` workspaces (temporary repositories on an existing open-source git service, not a hosting product), result-based accounting |

### M1 sub-stages (each built, reviewed and merged on its own)

| | Goal | A person can see |
|---|---|---|
| M1a | Extraction with no behaviour change: cargo workspace, `board-store` library (model, common, store, sqlite, pg, copy, config, sync core), injected host and runtime, default members so the existing tests still run, a CI job with PostgreSQL | the app works as before; the same number of tests pass; CI runs the PostgreSQL tests |
| M1b | Barycenter skeleton: axum binary, config (environment + file), explicit `barycenter migrate`, own schema with microsecond times, health endpoint, container image, database-clock context | the container answers `/health`; `migrate` creates the schema |
| M1c | Accounts: GitHub and OpenID Connect sign-in, membership rule, `accounts` / `runners` / tokens (hashed, revocable), device login, account and token pages (large) | sign in from a browser; a request with the token works; a revoked token is refused |
| M1d | Board API: existing operations behind the token, actor and rights from the server, rate limit, audit log (large) | two accounts post, claim and approve through the API |
| M1e | Task type and decider, `task_attempts`, token fields, `lease_epoch`, gravity events written by the server (no scores yet) | attempts and gravity events of a task can be read |
| M1f | Change stream (database notifications to server-sent events) and the MCP endpoint | a live stream shows events after a write; an agent uses the board through MCP |
| M1g | BBARIT Terminal "Board server" mode with "Sign in" (large; touches the frontend) | the desktop app works against Barycenter |

## Decisions (maintainer, 2026-11-22)

- The mesh is reached only through a board server, not by direct database access.
- Scoring is automatic; people only suspend, handle appeals and adjust the formula.
- Scores are public, with a query API and a dashboard.
- Email is verified; sign-up on the server's page or by CLI login; one token per computer.
- Names: service Cosmea, board server Barycenter, score gravity. The mark (a cosmos flower
  in the wordmark) is postponed.
- Barycenter is written in Rust and runs on Linux.
- First scope is one trust group (a company network).
- Workers may push `agent/*` branches to the task's remote so others can continue.
- Proceed in order, starting with M1a.

## Defaults chosen in the builder check (to confirm)

1. Barycenter owns a fresh schema that only it touches; existing teams do not appear in it.
2. Membership by email-domain allowlist or invite list; the first account is admin.
3. A team is a named board created by a lead; all members of the group can read it and
   take work from it.
4. M1 ends with the desktop app's "Board server" mode (M1g), not only an API.
5. Sign-in providers in M1: GitHub and generic OpenID Connect (covers Google and company
   identity providers).

## Risks

- **Overlap with Claude Code agent teams.** That feature coordinates teammates inside one
  session with file-lock claims and no documented lease or lead replacement. This design is
  for many computers, many products and a durable database; it should cooperate with it, not copy it.
- **Cost surprises.** Budgets and "no idle tokens" are requirements, not options.
- **Quality.** Known failure modes are weak verification, ignored stop conditions and not
  asking for clarification; the required task fields, the review step by a different agent
  and the question flow address them.
- **One more server to run.** The service must stay up; computers keep working on what
  they hold while it is away, and it should sit beside the database it fronts.

## Sources

Job queues and leases: pgmq (https://pgmq.github.io/pgmq/latest/), River active rescue
(https://riverqueue.com/blog/active-job-rescue), Graphile Worker recovery
(https://worker.graphile.org/docs/pro/recovery), Oban (https://oban.hexdocs.pm/Oban.Job.html),
fencing tokens (https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html),
Kubernetes leases (https://kubernetes.io/docs/concepts/cluster-administration/coordinated-leader-election).
Multi-agent findings: Anthropic research system
(https://www.anthropic.com/engineering/multi-agent-research-system), MAST failure taxonomy
(https://arxiv.org/pdf/2503.13657v2), Claude Code agent teams
(https://code.claude.com/docs/en/agent-teams), LLM blackboard result
(https://arxiv.org/abs/2510.01285). Distribution: Agent Skills (https://agentskills.io/),
Claude Code plugins (https://code.claude.com/docs/en/plugins-reference), Gemini CLI extensions
(https://geminicli.com/docs/extensions/reference/), Codex plugins
(https://developers.openai.com/codex/plugins/build), MCP (https://modelcontextprotocol.io/).
Headless runs and usage: https://code.claude.com/docs/en/headless,
https://code.claude.com/docs/en/monitoring-usage. Time: PostgreSQL date/time types
(https://www.postgresql.org/docs/current/datatype-datetime.html). Security: lethal trifecta
(https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), Claude Code sandboxing
(https://code.claude.com/docs/en/sandboxing).
