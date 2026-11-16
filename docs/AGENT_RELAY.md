# 에이전트 간 위임: agent run / send / wait

작성일 2026-11-03. 상태: 설계 확정, 구현 중.

## 배경

Claude 탭이 다른 탭을 띄워 일을 맡기고(리뷰, 테스트, 조사) 결과를 받아 보는 흐름이 없다.
지금 있는 것은 `bbarit-ctl term create/write/read` 뿐이라, 에이전트가 자식을 띄워도
"끝났는지" 를 알 방법이 폴링밖에 없고, 자식이 막혔을 때(blocked) 부모는 모른다.

herdr-core 의 모델을 따른다.

- `hc run --bg codex "review my diff. Done: hc send t1"` → 자식 터미널을 만들고 프롬프트를 넣는다.
- `hc send t3 "take another look"` → 특정 터미널에 텍스트를 넣는다.
- `hc wait --children all` → 자식들이 끝날 때까지 기다린다.
- 자식의 blocked / 종료 소식은 코어가 부모 터미널에 `<hc from="t3">…</hc>` 로 **타이핑해 넣는다**.
  부모 에이전트는 그걸 입력으로 읽는다. MCP 가 필요 없다.

빠릿에는 이미 UI 커맨드 버스(`src/gatewayUiCommands.ts` → `src/App.tsx` 디스패치),
`bbarit-ctl`, 7501 상태, 입력 게이트가 있다. 그 위에 얹는다.

## 설계

### 1. 탭 안에서 ctl 에 닿기 (PTY 환경, 지금은 `pty_backend::build_shell_command` 한 곳)

- `BBARIT_TERMINAL_ID`, `BBARIT_BRIDGE_PORT` — [CLAUDE_SESSION_HOOK.md](CLAUDE_SESSION_HOOK.md)
  브랜치가 추가한다. 이 브랜치는 그 값이 있다고 가정하고 **추가하지 않는다**(머지 충돌 방지).
- `BBARIT_CTL` — `bbarit-ctl.mjs` 의 절대 경로. 개발 실행은 `<repo>/scripts/bbarit-ctl.mjs`,
  설치본은 번들 리소스. `scripts/bbarit-ctl.mjs` 를 `tauri.conf.json` `resources` 에 추가한다
  (`tauri-dev-screen.mjs` 와 같은 방식. ctl 은 `ws` 없이 Node 22 내장 WebSocket 으로 돈다).
- 에이전트는 `node "$BBARIT_CTL" agent …` 로 부른다. `node` 가 없는 환경은 지원하지 않는다
  (Claude Code 사용자 환경에는 사실상 있다). 문서에 적는다.
- ctl 은 `BBARIT_TERMINAL_ID` 가 있으면 그것을 **호출자(caller)** 로, `BBARIT_TERM_TOKEN` 을
  `callerToken` 으로 모든 agent 커맨드에 실어 보낸다. 앱은 토큰이 그 caller 의 것일 때만 caller 로
  인정한다(아래 "호출자 확인" 메모). `BBARIT_BRIDGE_PORT` 가 있으면 포트 스캔 없이 그 앱의 mcp-bridge 포트
  (19980→9223, 19981→9323)를 쓴다.

### 2. 데이터 모델 (`src/App.tsx` 상태, 영속 안 함)

    type AgentLink = { childId: string; parentId: string; name?: string; createdAt: number;
                       lastNotifiedTurn: number; lastState?: AgentTabState; exited?: boolean };
    agentLinks: Map<childId, AgentLink>

- 앱을 껐다 켜면 비운다. 링크는 세션 안에서만 의미가 있다.
- 부모 탭이 닫히면 링크만 지운다. 자식 탭은 **그대로 둔다**(사용자가 결과를 보고 닫는다).

### 3. UI 커맨드 (`src/gatewayUiCommands.ts` 등록 + `src/App.tsx` 디스패치)

| 커맨드 | 파라미터 | 동작 / 반환 |
|---|---|---|
| `agent.run` | `cliType` (claude·codex·shell…), `prompt`, `caller?`, `workDir?`, `name?`, `worktree?` (`true`·이름) | 현재 프로젝트에 터미널을 만들고 `agentLinks` 에 `{child, parent: caller}` 를 넣는다. 에이전트가 준비되면(7501 `idle` 보고 또는 기존 `looksLikeAgentUiReady`, 최대 60 s) 3 절의 첫 메시지를 게이트로 넣는다. 즉시 `{ ok, terminalId }` 를 돌려준다(비동기 주입). `caller` 없으면 링크 없이 터미널만 만든다. |
| `agent.send` | `terminalId`, `text`, `caller?`, `force?` | `queueAutoInput(terminalId, wrapped, { source: 'agent', submit: true, force })`. `caller` 가 있으면 `<bbarit from="<callerName>">text</bbarit>` 로 감싼다. 거부 사유는 `terminal.write` 와 같다. |
| `agent.status` | `caller?`, `terminalId?` | `terminalId` 가 있으면 그 하나, 없으면 `caller` 의 자식 전부: `{ terminalId, name, cliType, state (7501 rollup 또는 busy 폴백), kind?, exited, lastLines (12줄) }`. |
| `agent.list` | `caller?` | `agent.status` 와 같되 `lastLines` 없음. |
| `agent.stop` | `terminalId?`, `caller?`, `close?` | `terminalId` 하나(caller 가 있으면 그 caller 의 자식이어야 함) 또는 caller 의 자식 전부(손자 제외)를 멈춘다: 쌓인 자동 입력을 버린 뒤 인터럽트 키를 보낸다. `{ ok, stopped: [{ terminalId, name, ok, keys, reason?, closed? }] }`. |

`agent.wait` 는 서버 쪽 커맨드가 **아니다**. 게이트웨이 30 s 타임아웃과 ctl 20 s 기본 타임아웃을
넘기지 않기 위해 ctl 이 `agent.status` 를 2 s 간격으로 폴링한다.

### 4. ctl 서브커맨드 (`scripts/bbarit-ctl.mjs`)

    agent run <cliType> <prompt…> [--bg] [--workdir <dir>] [--name <n>] [--worktree [name]] [--timeout <s>]
    agent send <terminalId> <text…> [--force]
    agent wait [--id <terminalId> | --children any|all] [--timeout <s>=600]
    agent status [terminalId] | agent list
    agent stop [<terminalId> | --children] [--close]

- `run` 은 기본으로 **기다린다**: 자식이 `done`/`blocked`/종료가 될 때까지 폴링한 뒤
  `agent.status` 결과(상태 + 마지막 12줄)를 출력하고, blocked 면 종료 코드 2, 타임아웃은 3.
  `--bg` 면 terminalId 만 찍고 바로 끝난다.
- `wait` 는 조건을 만족하는 순간의 상태 목록을 JSON(`--json`) 또는 표로 찍는다. `any` 는
  하나라도 `done|blocked|exited`, `all` 은 전부.
- 모든 agent 커맨드는 `BBARIT_TERMINAL_ID` 를 `caller` 로, `BBARIT_TERM_TOKEN` 을 `callerToken` 으로
  보낸다. `--caller <id>` 는 그 탭의 토큰(`--caller-token <t>` 또는 환경 변수)이 함께 있을 때만
  통한다 — 다른 탭인 척하는 방법이 아니다.

### 5. 자식 → 부모 노트 (App, 자동)

`octo-agent-status` 와 PTY 종료를 보고, `agentLinks` 에 있는 자식에 대해 부모에게 노트를
넣는다. herdr `notes.rs` 와 같은 규칙이다.

- 보내는 전이: `blocked`(kind 포함), `done`, 프로세스 종료. `working`/`idle` 은 안 보낸다.
  같은 턴에 같은 상태를 두 번 보내지 않는다(`lastNotifiedTurn`).
- 형식(한 줄, 부모가 읽기 쉽게):

      <bbarit from="t3 reviewer" state="done" turn="2">마지막 비어있지 않은 3줄… — 전체: node "$BBARIT_CTL" term read 60 --id <childId></bbarit>
      <bbarit from="t3 reviewer" state="blocked" kind="question">질문 본문(msg)… — 답하기: node "$BBARIT_CTL" agent send <childId> "…"</bbarit>

- 전달은 `queueAutoInput(parentId, note, { source: 'agent', submit: true })` 다. 부모가
  `blocked` 면 게이트가 거부하므로 **부모별 대기열**에 쌓아 두었다가 부모가 blocked 를 벗어나는
  전이에서 순서대로 다시 보낸다. 부모가 사라졌으면 버린다.
- 부모가 7501 을 보고하지 않는 일반 셸이면 노트를 넣지 않는다(셸 프롬프트에 명령처럼 들어간다).
  대신 `agent wait` 로만 받는다.

### 6. 자식의 첫 메시지 (프로토콜을 가르친다)

`agent.run` 이 자식에게 넣는 첫 입력은 사용자의 프롬프트 앞에 다음을 붙인다.

    <bbarit from="t1" reach="node \"$BBARIT_CTL\" agent send t1 \"<message>\"">
    You were started by another agent (terminal t1). When you finish or get stuck, report back
    with the reach command above (one short message with the result or the question).
    </bbarit>
    <사용자 프롬프트>

`t1` 은 부모 터미널의 짧은 표시 이름(`name` 또는 id). 부모 쪽 안내는 번들 스킬
`src-tauri/resources/claude-skills/bbarit-agents/SKILL.md` 에 둔다(커맨드 4개, 노트 형식,
blocked 처리). 이 스킬이 Claude 탭에 자동 주입되지는 않는다. 사용자가 프롬프트에 "bbarit
agent 커맨드로 리뷰어를 띄워" 처럼 언급하면 Claude 가 `node "$BBARIT_CTL" agent --help` 를
읽을 수 있도록 ctl 의 help 를 충분히 쓴다.

### 7. 바꾸지 않는 것

- 기존 `term create/write/read`. `agent.*` 는 그 위의 얇은 층이다.
- 입력 게이트 규칙. 노트도 게이트를 탄다(사람이 치는 중이면 기다리고, blocked 면 대기열).
- 7501 상태 모델. `agent.status` 는 읽기만 한다.
- 워크트리 생성. `--workdir` 는 있는 디렉터리를 받을 뿐이다. 작업별 워크트리는 아래
  "자식별 워크트리" 메모(`--worktree`)로 추가됐다.

## 검증

- 순수 함수 + vitest: 노트 포맷(`formatAgentNote`), 첫 메시지 포맷(`formatAgentBrief`),
  부모별 대기열(blocked → 해제 시 순서대로 flush, 부모 사라지면 drop), 전이 필터(같은 턴
  중복 금지, working/idle 무시), ctl 의 `agent wait` 조건 평가(`any`/`all`, 타임아웃).
- ctl: `node scripts/bbarit-ctl.mjs agent --help` 출력이 커맨드 4개를 설명한다.
- `npm run test:run`, build, lint, `--audit`, `check:bundled-scripts`.
- 실기(macOS 개발 빌드): Claude 탭 A 에서
  `node "$BBARIT_CTL" agent run claude "Reply with exactly: pong. Then report back."` 를 치면
  자식 탭이 생기고 ctl 이 `done` 과 마지막 줄을 출력하는지. 자식에게 AskUserQuestion 을 시켜
  blocked 가 되면 부모 탭 입력창에 `<bbarit … state="blocked">` 노트가 들어오는지.

## 구현 메모

설계와 다르거나 설계가 정하지 않은 부분만 적는다.

- **순수 로직**: `src/terminal/agentRelay.ts`(+ `agentRelay.test.ts`). 브리프·노트 포맷, 전이
  필터(`decideAgentNote`/`decideExitNote`), 부모별 대기열(`enqueueNote`/`flushNotes`/
  `requeueFront`/`dropParent`), 끝남 판정(`agentSettledBy`), 준비·주입(`runAgentBrief`), 부모 판정(`parentAcceptsNotes`). App 은 상태와 게이트 연결만 한다.
- **`from` 표시**: `<id> <name>`(이름이 없으면 id). 문서 예시 `t3 reviewer` 와 같은 모양이다.
  `reach`·`agent send`·`term read` 에는 항상 터미널 id 를 쓴다(이름은 겹칠 수 있다).
- **`agentLinks` 위치**: 렌더에 쓰지 않으므로 App 의 `useRef<Map>` 에 둔다(영속 안 함).
  caller 없는 `agent.run` 도 `parentId: ''` 항목을 둔다 — wait 판정용 주입 기록만 하고 노트·
  `agent.list` 대상은 아니다. 닫힌 자식, 부모가 닫힌 링크, 사라진 부모의 대기열은 `projects`
  변경 때 버린다(자식 탭은 그대로).
- **자식 위치**: caller 가 있으면 caller 탭이 있는 프로젝트에, cwd 는 `workDir` || caller 의
  `lastWorkDir` || 그 프로젝트 폴더로 만들고 포커스를 옮기지 않는다(`addTerminal` 에
  `projectId`·`activate` 옵션 추가, 기존 호출은 그대로). caller 가 없으면 예전처럼 활성
  프로젝트에 만들고 활성화한다.
- **Claude 자식 = 전용 세션**: 실기에서 자식이 `claude --continue` 로 떠서 같은 폴더의 부모 대화를
  이어받았다. `agent.run` 은 Claude 자식을 "Claude (새 대화)" 경로(`freshClaudeSession`:
  `claudeSessionId` + `claudeSessionSource: 'app'`, `--session-id <uuid>` 로 시작)로 만든다
  (`agentRunTerminalSpec`, `dedicatedClaudeSessionFields`). Codex 자식도 같은 이유로 "Codex (새 대화)"
  경로(`freshCodexSession` → `codexFreshSession`)로 만든다: 이어 보기 설정이 켜져 있어도
  `codex resume --last` 대신 새 `codex` 로 시작한다(src/terminal/codexSession.ts). 탭 이름은
  `--name` 또는 `<cliType> (agent)`.
- **준비 판정**(`runAgentBrief`, 의존성 주입으로 테스트): 300 ms 간격, 첫 검사는 첫 sleep 뒤다.
  addTerminal 직후에는 탭이 `projectsRef` 에 아직 없으므로 2 s 동안은 "사라짐" 으로 보지 않는다.
  60 s 시계는 PTY 가 뜬 때부터 잰다(다른 프로젝트에 만든 탭은 그 프로젝트를 볼 때 마운트된다,
  최대 10 분). 7501 `idle` → 300 ms 뒤, `isTerminalAgentUiReady`(환영 문구) → 1.5 s 뒤 주입.
  시간이 지나면 셸 자식은 프롬프트만 넣고, 에이전트 자식은 **넣지 않는다**(맨 셸일 수 있다) —
  `agent.status` 의 `error: "agent not ready"`, ctl 종료 코드 1. 게이트 거부도 `error` 로 보인다.
  셸 자식에는 여러 줄 브리프 없이 프롬프트만 넣는다.
- **브리프 문구**: 막히면 보고, 끝났을 때는 부모 프롬프트가 보고를 요구할 때만 보고하라고 쓴다.
- **끝남(`settled`) 판정**(`agentSettledBy`): App 이 `agent.status` 에 넣고 ctl 은 any/all 만
  본다. 종료됐거나, blocked 거나, 마지막 입력(브리프·`agent.send`) 이후 7501 턴이 넘어가
  done/idle 이면 끝. `done` 은 다음 working 까지 남으므로 턴 비교가 필요하다. blocked 인 자식에
  답을 보낸 직후의 같은 턴 blocked 는 아직 처리 전으로 본다. 7501 이 없는 자식은 마지막 입력과
  마지막 출력 뒤 30 s 가 지나야 끝이고, 셸은 프롬프트가 다시 보여야 한다
  (`looksLikePlainShellPrompt`). 이 추정은 `settledBy: "quiet"` 로 표시하고 ctl 표에
  `yes (quiet-heuristic)` 로 보인다. 링크 없는 `--id` 는 exited/blocked/done.
- **노트 받는 부모**: 부모 탭 `cliType` 이 `shell` 이 아니고, 7501 롤업이 working/blocked/done 이며
  마지막 보고가 30 분 안일 때만 쌓는다(`parentAcceptsNotes`). idle·보고 없음·오래된 보고는
  에이전트가 떠나 셸만 남았을 수 있어 버린다.
- **노트 세부**: 브리프 주입 전(`pending`)의 done 은 무시한다(시작 직후 보고). "마지막 3 줄" 은
  글자·숫자가 없는 줄(TUI 입력창 테두리 등)을 건너뛴다. blocked 본문은 7501 `msg`, 없으면
  마지막 3 줄. 종료 노트는 `state="exited"`. 실기에서 done 노트가 Claude 하단 상태줄만 담아서
  `noteTailLines` 로 고른다: 마지막 사용자 입력 에코(`❯ `·`> `) 뒤부터 다음 프롬프트 표시 전까지,
  `⏺` 줄 우선, 하단 줄(`bypass permissions`, `? for shortcuts`, 모델·`$` 비용, `✻ … done`,
  가로줄, `%` 상태줄) 제외. 남는 게 없으면 예전 규칙. 본문과 이름의 셸 메타문자
  `` ` $ ; | & < > \ `` 는 비슷한 모양의 안전한 글자(ˋ ＄ ； ｜ ＆ ‹ › ＼)로 바꾼다(`</bbarit` 위조도
  막힌다). 자식이 같은 턴에 `agent send` 로 부모에게 직접 보고했으면 그 턴의 done 노트는
  보내지 않는다(`lastSendTurn`: 보고가 working 중이면 턴+1, working 을 떠날 때 턴이 오르므로).
  게이트가 `typing`/`no-writer`/`cancelled` 로 거부하면 5 s 뒤 다시, `blocked` 면 부모의 다음
  비-blocked 상태 보고 때 다시 보낸다. 게이트 출처는 `'agent'`(`AutoInputSource` 에 추가).
- **PTY 종료 신호**: `pty-exit` 이벤트는 `mod` 트리 밖인 `pty.rs` 에서만 나와 실제로 오지 않는다.
  main.rs 의 리더 스레드가 끝나면 채널 송신단이 사라져 `read_from_pty` 가 출력을 다 준 뒤
  `PTY disconnected` 를 돌려준다. XTerminal 이 이 에러를 받으면 7501 working/blocked 를 버리고
  `octo-pty-exited`(`PTY_EXITED_EVENT`, detail `{ terminalId }`)를 한 번 보낸다(새 출력이 오면
  다시 보낼 수 있게 초기화). App 은 이 이벤트로 종료 노트를 만든다. 셸 안의 에이전트만 끝나면
  PTY 는 살아 있으므로 종료 노트는 없다(7501 done 이 대신한다).
- **게이트웨이 비서**: `agent.run`/`agent.send` 는 `SECRETARY_ALLOWED_CMDS` 에 없고, 그대로
  거부되는지 `agent_gateway.rs` 테스트(`secretary_commands_deny_shell_reach`)가 고정한다.
- **`BBARIT_CTL` 경로**: setup 에서 한 번 계산해 `OnceLock` 에 둔다(`init_bbarit_ctl_path`).
  debug 빌드는 컴파일한 체크아웃(`CARGO_MANIFEST_DIR/../scripts`, CARGO_TARGET_DIR 를 다른 곳에
  두면 exe 기준 경로가 다른 체크아웃을 가리킨다) → exe 기준 리포 `scripts/` 순으로, release 는 번들 리소스(`<resource>/_up_/scripts/`)를 먼저
  찾는다. `cmd.env("BBARIT_CTL", …)` 는 두 빌더 모두 `BBARIT_TERM_SCOPE` 바로 다음 줄이다.
- **ctl**: `agent run`/`agent wait` 의 `--timeout` 은 초 단위 전체 대기(기본 600)이고 요청마다
  20 s 응답 제한은 그대로다. `agent send` 는 `term write` 처럼 40 s. 폴링마다 다시 연결하므로
  처음 붙은 포트를 기억해 먼저 시도한다. `BBARIT_BRIDGE_PORT` 로 정한 포트도 앱 식별 검사는
  거친다. 테스트를 위해 헬퍼를 export 하고 `main()` 은 스크립트로 실행될 때만 돈다
  (`tests/bbarit-ctl-agent.test.mjs`, `npm run test:source-build` 에 포함).
- **설정 → Control CLI**: 예시 매핑(`CLI_EXAMPLES`)에 `agent.*` 네 개를 추가했다.

- **자식별 워크트리**(`agent run --worktree [name]`, 설계
  [2026-11-16-agent-worktree-and-stop-design.md](superpowers/specs/2026-11-16-agent-worktree-and-stop-design.md)):
  `agent.run` 의 `worktree: true | "<name>"`. 순수 로직은 `src/terminal/agentWorktree.ts`
  (+ 실제 git 으로 도는 `agentWorktree.test.ts`). 기준 폴더 = `agentWorktreeBaseDir`: `workDir` || caller cwd
  (`lastWorkDir`, 일반 run 과 같은 순서 — 연결된 워크트리 안의 caller 는 자기 브랜치 HEAD 에서 딴다)
  || caller 프로젝트 폴더 || 활성 프로젝트 폴더의 git top-level. git 이 브리지 요청 한 번(mcp-bridge
  `execute_js` 5 s)보다 오래 걸릴 수 있어 `agent.run` 은 `{ ok, pending, jobId }` 를 바로 돌려주고 앱이
  워크트리를 만든 뒤 탭을 연다. ctl 은 `agent.run.result { jobId }` 를 0.5 s 마다 최대 120 s 폴링한다
  (끝난 결과는 한 번 읽으면 지우고, 안 읽힌 것은 10 분 뒤 버린다). 위치는 `<repo>/.bbarit/worktrees/<slug>`,
  브랜치는 그 repo HEAD 에서 새로 딴 `agent/<slug>`. Orchestra(브로커) 워크트리
  `.octo-tmp/broker-wt-*` 는 브랜치 없는 detached 이고 `git_cleanup_broker_worktrees` 가 지우므로
  자리는 쓰지 않고 Rust 커맨드 `git_worktree_add` 만 재사용한다. slug 는 이름(없으면 `--name`,
  그다음 cliType)을 소문자 ASCII·`-` 로 줄인 것(최대 40 자, 한글만이면 cliType)이고, 이미 있는
  `agent/*` 브랜치나 폴더와 겹치면 `-2`, `-3`… 을 붙인다(대소문자 무시). `git rev-parse --git-path
  info/exclude`(연결된 워크트리에서도 공용 git 디렉터리)에 `/.bbarit/worktrees/` 를 한 번만 넣는다.
  `.gitignore` 는 건드리지 않는다. git repo 가 아니거나 커밋이 없으면 에러를 돌려주고 탭을 만들지
  않는다. git 명령은 `run_cli_oneshot`(login 아님)으로 돈다. 자식 cwd 는 워크트리, 첫 메시지에
  `<bbarit worktree="…" branch="…">` 블록(이 폴더에서만 일하고 이 브랜치에 커밋, push·merge·브랜치
  전환 금지)을 붙인다(caller 없는 에이전트 자식도, 셸 자식은 프롬프트만). 링크에 `worktree`·
  `branch` 를 저장(`PersistedAgentLink`, 예전 저장본도 그대로 읽힌다)하고 `agent.status/list` 행과
  노트(`branch="agent/<slug>"`)에 싣는다. 자동 삭제는 없다(탭을 닫아도 워크트리·브랜치는 남는다).

- **멈춤**(`agent stop`, 팀 멈춤 버튼, 같은 설계 문서): 순수 로직 `selectStopTargets`·
  `stopAgentTerminal`·`markLinkStopped`·`interruptKeysFor`·`anyRelayChildWorking`·`effectiveAgentState`(agentRelay.ts).
  순서: ① 입력 게이트 `dropQueuedAutoInput`(inputGate.ts 에 추가 — 요청마다 epoch 를 잡아 두고,
  올린 뒤에는 아직 쓰지 않은 요청이 `cancelled` 로 끝나며 쓰는 중이면 남은 Enter 를 안 보낸다)과
  그 자식 앞으로 쌓인 손자 노트 버리기 ② 링크 `stopped`/`stopTurn`(working 이면 turn+1) ③ 게이트로
  인터럽트 키(`force`, `quietMs: 0`, `submit: false` — PTY 직접 쓰기 아님). 키가 거부되면(no-writer 등)
  ②를 이전 값(`stopped`·`stopTurn`·노트 기록)으로 되돌리고(`restoreStopMark`) 결과에 `interrupt key not sent: <사유>` 를 싣는다 ④ ctl 로 다른 탭이 멈췄을 때만 부모에게
  `state="stopped"` 노트 한 번(부모 자신이 멈췄거나 버튼으로 멈췄으면 보내지 않는다) ⑤ `--close` 면 탭
  닫기(다른 프로젝트 탭도 `closeTerminalAnywhere`). 키는 이 리포에 근거가 있는 것만: `claude` Esc
  (main.rs READY_REFS 의 Claude 화면 문구 "esc to interrupt", 설치된 2.1.325 바이너리), `bbarit`·
  `bbarit-oss` Esc(bbarit-agent `tui.rs` 의 턴 중 Esc 취소·"(Esc to cancel)", XTerminal 의
  `isBbaritAgentCli` 가 둘을 같은 에이전트로 다룬다), `shell`·`ollama` Ctrl+C. 그 밖의 CLI(codex,
  gemini, qwen, opencode, cursor, kimi, pi, reasonix, gajae)는 키를 보내지 않고 `ok: false` +
  `no known interrupt key for <cliType> (use --close)` 를 돌려준다(`--close` 면 입력을 버리고 탭만
  닫는다). 에이전트에 Ctrl+C 를 쓰지 않는 이유: 두 번째 Ctrl+C 는 CLI 를 끝낸다. 멈춘 링크는 다음 turn 에 working 이 될 때까지
  done/blocked/exit 노트를 보내지 않고, 그 자식에게 쌓인 노트도 넣지 않는다(`agent send` 성공 시
  해제). 브리프 주입 전에 멈추면 프롬프트를 넣지 않는다(`error: stopped before the prompt was typed`).
  팀 멈춤 버튼은 위쪽 막대의 종·창 고정 버튼 오른쪽(빨간 `OctagonX`)에 있고, 부모가 있고 중단 키를
  아는 CLI(`interruptKeysFor` 가 null 이 아닌) 릴레이 자식 중 working 이 하나라도 있을 때만 보이며,
  그런 자식만 멈춘다. 상태는 7501 이 있으면 그것, 없으면 최근 3 s 출력
  (`isTerminalBusy`, `describeAgentTerminal` 과 같은 폴백)이고, 7501 이벤트·탭 변경 때와 릴레이 자식이
  있는 동안 2 s 마다(자식 id 문자열을 키로 한 effect) 다시 계산한다. 누르면 working/blocked 인 릴레이
  자식을 모두 멈추고 부모에게 노트를 넣지 않는다. `agent.stop` 은 `SECRETARY_ALLOWED_CMDS` 에 없고 `secretary_commands_deny_shell_reach` 가 고정한다.

- **Claude 제출 키**: Claude Code 의 `keybindings.json`("Chat" 맥락)에서 Enter 를 `chat:newline` 으로
  바꾸면 게이트의 `\r` 은 줄바꿈이라 브리프·`agent send`·노트가 입력창에 남고 자식이 시작하지 않았다
  (1.1.71 에도 있던 문제). Rust `claude_chat_keybindings`(async)가 `$CLAUDE_CONFIG_DIR/keybindings.json`
  (`read_env_var` 와 같은 방식으로 보이는 경우) 또는 `~/.claude/keybindings.json` 에서 Chat 바인딩만
  돌려주고(`{ chat, autocomplete }` — Chat·Autocomplete 맥락만, 1 MiB 넘거나 없거나 깨진 파일은 빈 값), `src/terminal/claudeSubmitKey.ts` 가 제출 키를 고른다: Enter 가
  그대로 제출이면 `\r`, 아니면 `chat:submit` 에 묶인 shift+enter(`\x1b[13;2u`) → cmd+enter(`\x1b[13;9u`)
  순(사람 키 입력과 같은 CSI-u 바이트 — 사람 경로도 이 둘은 `csiUKeys` 설정과 무관하게 보낸다). 보낼 수
  있는 키가 없으면 `\r` 을 유지하고 `agent run/send` 결과에 `warning`("Claude submit key is not Enter
  and cannot be sent")을 싣는다. 앱이 게이트에 `setInputGateSubmitKeyResolver` 를 등록해 Claude 탭에서
  게이트가 Enter 를 누를 때(`queueAutoInput`·`queueButtonInput`·브리프·노트·ctl `term write`·devreview
  제출) 그 키를 쓴다. Claude Code 가 지금 실행 중인 Claude 탭에서만 쓴다(`agentProgramRunning`: 7501
  레코드가 남아 있음). 실측: Claude 는 시작 때 `7501;?` 질의 뒤 `state=idle:app=claude-code` 를 보내고,
  `/exit` 때 `7501;state=clear` 를 세 번 보낸 뒤 "Resume this session with:" 를 찍는다. clear 는 레코드를
  비우지만 `reported` 는 남아 롤업이 idle 로 읽히므로 idle/done 만으로는 zsh 프롬프트와 구별되지 않았다
  (zsh 에 `;2u` 가 붙던 원인). 같은 탭에서 다시 `claude` 를 치면 새 질의가 저장소를 비우고 보고가 다시
  레코드를 채운다. 재부착 재생도 같은 파서를 지나 같은 값이 된다. 그 밖(보고 전, 종료 뒤)은 `\r`. 브리프는 준비 판정이 환영 화면일 수 있어 `submitKey` 로 설정 키를 직접
  넘긴다. blocked(권한·질문 대화상자, Chat 맥락이 아님)이면 `\r`. 셸·다른 CLI 는 그대로 `\r`.
  고른 제출 키가 Autocomplete 맥락에서 `autocomplete:dismiss` 이고 텍스트가 메뉴를 여는 모양(첫 글자
  `/`, 또는 마지막 단어가 `@` 로 시작)이면 첫 누름은 메뉴만 닫으므로 300 ms(`SUBMIT_REPEAT_GAP_MS`)
  뒤 한 번 더 누른다. 키는 누르는 순간에 고른다(devreview 제출도 빈 텍스트 + submit 으로 같은 경로). 시작 때와 창 포커스 때(2 s 안 중복은 건너뜀), `agent run claude`·`agent send` 직전에 다시 읽는다.

- **릴레이 제한**(설계 [2026-11-16-agent-limits-and-log-design.md](superpowers/specs/2026-11-16-agent-limits-and-log-design.md)):
  자식이 다시 `agent run` 을 부를 수 있어 팬아웃이 끝없이 커질 수 있다. `agent.run` 은 caller·프롬프트 검사 바로
  뒤(마지막 await 다음), 탭·워크트리·브랜치를 만들기 전에 `createAgentRunReservations().reserve`
  (`src/terminal/agentLimits.ts`, 안에서 순수 함수 `checkAgentRunLimits`)로 검사와 자리 잡기를 한 동기 단계에서 한다.
  설정은 앱 설정 `agents: { maxChildren, maxDepth, maxTotal }`(`~/.config/octo/config.json`, 설정 화면 없음)이고
  `normalizeAgentLimits` 가 정수로 자르고 범위로 묶는다(maxChildren 1..32 기본 6, maxDepth 1..5 기본 2,
  maxTotal 1..64 기본 12, 숫자가 아니면 기본값). 순서: ① depth — 새 자식의 깊이(`agentDepth`: 릴레이 부모가 없는
  탭 0, 그 자식 1, 손자 2. parentId 사슬을 따라가며 이미 본 id 를 만나면 멈춘다)가 maxDepth 를 넘으면 거부
  (기본값이면 깊이 2 탭은 자식을 못 만든다) ② children — caller 를 부모로 둔 살아 있는 링크 수 ③ total — 앱 전체의
  살아 있는 링크 수(caller 없는 run 과 부모가 닫힌 자식의 `parentId: ''` 링크 포함). "살아 있음" = 링크가 있고
  exited 가 아니고 탭이 아직 있거나 `pending`(새 탭은 렌더 뒤에야 `projectsRef` 에 보이므로). 멈춘 자식도 탭이
  닫힐 때까지 센다. 예약(reserve 가 잡은 자리)은 그 caller 의 자식처럼 세다가 링크를 넣은 직후(그때부터 링크가
  센다) 또는 실패(워크트리 에러, 터미널 생성 실패) 때 돌려준다 — 동시에 온 `agent run --bg` 여러 개나 git 을 돌리는
  `--worktree` 잡이 함께 제한을 넘지 못한다. 링크에는 만들 때의 `depth` 를 적어 둔다. caller 없는 run 은 total 만
  본다. **부모 탭이 닫히면** 자식 링크를 지우지 않고 `parentId: ''` + 적어 둔 깊이로 남긴다(`orphanAgentLink`):
  total 에 계속 들고 깊이도 유지하지만 노트는 없고 누구의 자식도 아니다(list·stop·팀 멈춤 버튼 대상 아님, 예전에
  링크를 지우던 것과 같은 동작). caller 없는·고아 링크도 프로젝트와 함께 저장되고, 복원 때 부모가 없으면 고아로
  돌아온다. 거부는 `{ ok: false, error, limit }` 이고 문구에 제한 이름·현재 수·최대·해결 방법이
  있다: `child limit reached: this tab already has 6 live children (max 6; a stopped child still counts: close one
  with agent stop <id> --close, or raise agents.maxChildren)`, `depth limit reached: this tab is at depth 2 of the agent chain and a child would be at
  depth 3 (max 2; do the work in this tab, or raise agents.maxDepth)`, `total agent limit reached: the app already
  has 12 live relay agents (max 12; a stopped agent still counts: close some with agent stop <id> --close, or raise
  agents.maxTotal)`. ctl 은 `✗ <error>` 를 찍고
  종료 코드 1(`--json` 도 1). `agent.status/list` 행에 `depth` 가 붙고 ctl 표에 depth 열이 생긴다(보고하는 앱일 때).
- **감사 로그**(같은 설계 문서): `~/.config/octo/agent-relay.log` 에 이벤트마다 JSON 한 줄. 항목은 프런트가
  `buildAgentRelayLogEntry`(`src/terminal/agentRelayLog.ts`)로 만들고 Rust `agent_relay_log_append`
  (`src-tauri/src/agent_relay_log.rs`, async, `main.rs` 에 등록. 디렉터리는 `config_file_path()` 의 부모)가
  붙인다. App 은 `invoke(...).catch(() => {})` 로 기다리지 않고(fire and forget) 실패를 버린다. 이벤트:
  `run`(탭을 만든 뒤, 워크트리 run 은 워크트리를 만든 뒤), `run_refused`(`reason` = 제한 이름, `count`, `max`,
  `error`), `send`(게이트 결과 `ok`/`reason`, `force`), `stop`(대상마다 `ok`/`keys`/`closed`/`reason`,
  `by: "ctl" | "button"`), `exit`(링크가 처음 exited 가 될 때, caller = 부모). 공통 필드 `ts`(ISO), `event`,
  알 때만 `caller`/`target` `{ id, name, cliType }`, `depth`(run 은 새 자식, 나머지는 대상의 깊이),
  `worktree`/`branch`, run/send 는 `textLen`(전체 글자 수)과 `textHead`(`oneLine` 으로 한 줄로 만든 뒤 앞 120 자).
  환경 변수·토큰·전체 프롬프트는 쓰지 않는다. 파일은 unix 에서 0600 으로 만들고(더 넓으면 0600 으로 고친다),
  붙이면 1 MiB 를 넘게 될 때 `agent-relay.log.1` 로 이름을 바꾸고(이전 .1 은 덮어씀) 새로 시작한다. 한 항목이
  8 KiB 를 넘으면 버린다. 쓰기는 프로세스 안 뮤텍스로 줄 세운다. 읽기는 `agent_relay_log_tail { lines }`(기본 20,
  최대 500, 모자라면 .1 에서 더 읽음)와 UI 커맨드 `agent.log { tail }` → `{ ok, lines }`(원본 JSON 문자열).
  ctl `agent log [--tail N] [--json]` 은 한 줄씩 사람이 읽는 모양(`ts  event  caller → target  depth=…
  branch=… by=… ok=… "textHead…" (N chars)`)으로, `--json` 이면 원본 줄을 찍는다. 앱에 닿지 않거나 앱에
  `agent.log` 가 없으면(`unknown cmd`) 파일을 직접 읽는다. 읽기는 Rust·ctl 모두 각 파일의 마지막 1 MiB 까지만
  보고(잘린 첫 줄은 버림), 깨진 UTF-8 은 대체 문자로 읽는다. `--tail` 은 값이 있어야 하고 `--tail=N` 도 된다. `agent.*` 는 전부 `SECRETARY_ALLOWED_CMDS` 밖이고
  `secretary_commands_deny_shell_reach` 가 `agent.` 로 시작하는 허용 항목이 없음을 고정한다.

- **호출자 확인**(설계 [2026-11-16-agent-caller-verification-design.md](superpowers/specs/2026-11-16-agent-caller-verification-design.md)):
  모든 탭 PTY 에 `BBARIT_TERM_TOKEN` = HMAC-SHA256(키, terminal id) 앞 16 바이트(16진 32 자)를 넣는다
  (`apply_bbarit_terminal_env`, 순수 `build_shell_command` 의 주입 값 `ShellEnvDeps::term_token`. 물려받은 값은
  먼저 지운다). terminal id 만으로 정해지므로 앱 재시작·PTY 홀더 재부착에도 그대로이고 저장해 둘 표가 없다.
  키는 `~/.config/octo/agent-relay.key`(debug 빌드는 `agent-relay.dev.key` — PTY 홀더의 `.dev` 처럼 나눠 개발 앱이
  설치 앱의 키·키 시각을 건드리지 않는다)이고 두 줄이다: 32 바이트를 16진 64 자로, 그리고 만든 시각(unix ms, 0 = 모름).
  unix 0600. 없으면 잠금 파일(`.<키 파일>.lock`, 배타 생성, 10 s 넘은 잠금은 죽은 인스턴스 것으로 보고 가져온다)을
  잡고 다시 읽은 뒤 만들고(임시 파일 → rename), 쓴 뒤 디스크에서 다시 읽은 값을 쓴다. 그래서 두 인스턴스가 동시에
  만들어도 같은 키를 갖는다. 맞는 키는 다시 쓰지 않고, 깨진 파일만 같은 잠금 안에서 만든 시각 0 으로 바꾼다(시각을
  모르면 legacy 가 없다). 앱 실행 동안 메모리에 둔다. 로그에 쓰지 않고 어떤 커맨드도 키·토큰을 돌려주지 않는다. 확인은 Rust
  `agent_caller_verify { terminalId, token } -> bool`(`src-tauri/src/agent_caller.rs`, async,
  `verify_truncated_left` 로 상수 시간 비교). 앱 규칙은 순수 함수 `decideCaller`(`src/terminal/agentCaller.ts`)이고
  App 의 `checkAgentCaller` 가 `agent.run/send/stop/status/list` 모두에서 쓴다: caller 없음 → 예전대로,
  caller + 맞는 토큰 → 통과(`callerVerified: true`), caller + 틀린 토큰 → `{ ok: false, error: "caller not verified:
  <id> (the token does not match this tab)", callerRefused: "wrong_token" }`, caller + 토큰 없음 → 거부
  (`missing_token`, 그 탭 안에서 실행하고 업데이트 전에 연 탭이면 새로 열라는 문구) — 단 그 탭 PTY 가 이번 실행에서
  PTY 홀더로부터 복구됐고 아직 살아 있으며 키가 생기기 전에 시작됐으면(`recoveredPtyFor`, 0 보다 큰 홀더
  `started_at` < Rust `agent_caller_key_info` 의 `sinceMs` = 키 파일에 적힌 만든 시각, `predatesCallerTokens`. 예전 앱이
  띄운 셸이라 env 가 없다) `callerVerified: "legacy"` 로 받는다. 홀더 클라이언트는 이번 실행이 띄운 셸을 `started_at: 0`
  으로 돌려주므로(웹뷰 새로고침) 0 은 legacy 가 아니다. 키 시각을 모르면(0) 역시 legacy 가 없다. 키가 생긴 뒤에 시작된
  셸은 토큰이 있으므로 토큰을 빼면 앱을 다시 켜도 통과하지 못한다. 키를 읽거나 만들 수 없으면 caller 가 있는 요청은
  모두 `callerRefused: "key_unavailable"`, `caller verification unavailable: cannot read the relay key …` 로 거부한다
  (legacy 도 없다. caller 없는 요청은 그대로). `agent.run` 에서 확인(await)은 프롬프트 검사 바로 뒤, 제한 검사·자리 잡기
  앞이라 그 둘은 여전히 마지막 await 뒤의 한 동기 단계다. 거부는 감사 로그에 `caller_refused`(`reason`, `cmd`)로,
  통과한 run/run_refused/send/ctl stop 항목에는 `callerVerified` 가 남는다(토큰은 쓰지 않는다). 팀 멈춤 버튼 등
  앱 안의 경로는 caller 가 없어 그대로다. 자식 브리프와 `bbarit-agents` 스킬은 `--caller` 를 쓰라고 하지 않는다
  (자식 탭에는 자기 id·토큰이 있다).

- **팀 보드**(설계 [2026-11-16-agent-team-board-design.md](superpowers/specs/2026-11-16-agent-team-board-design.md)):
  릴레이 팀(관계 사슬의 루트 탭 + 그 아래 모든 자손, 팀 id = 루트 탭 id)마다 게시판 하나. **당겨 읽기만** 한다:
  글이 올라와도 어떤 탭에도 아무것도 타이핑하지 않는다(노트·`queueAutoInput` 없음). 팀은 순수 함수
  `teamRootOf(links, tabId)`(`src/terminal/agentBoard.ts`)가 정한다: 링크에 적힌 `teamId` 가 있으면 그것, 없으면
  parentId 사슬을 올라가 릴레이 부모가 없는 탭(이미 본 id 를 만나거나 64 단계면 멈춤). `agent.run` 이 링크를 만들 때
  caller 의 팀 루트를 `teamId` 로 적고 저장·복원한다(`PersistedAgentLink.teamId`) — 부모 탭이 닫혀 고아가 된 자식도
  만들어진 팀에 남는다. caller 없는 run 의 자식과 링크 없는 탭은 자기 자신이 루트다. UI 커맨드 `agent.board.post|read|teams|clear`
  는 모두 `checkAgentCaller` 를 거친다. post 는 확인된 caller 가 필요하고(legacy 포함), 본문은 `sanitizeBoardText`
  (이스케이프 시퀀스·제어 문자 제거, 줄바꿈 유지, `<bbarit` 위조 무력화, 최대 2000 자·40 줄 — 넘으면 자르지 않고 에러).
  read 는 caller 의 팀 또는 `team`(다른 팀 탭에서도 읽기는 허용, caller 가 없으면 `team` 필수). `--new` 는 caller
  자기 팀에서만, `--since/--kind/--author/--search` 없이 쓴다(`planBoardRead`·`parseBoardReadRequest`, Rust 도 거부):
  탭별 커서 뒤의 안 읽은 글(자기 글 제외)을 오래된 것부터 `--tail` 개 돌려주고, 남은 글이 있으면(`more`) 커서를 보여 준
  마지막 글까지만, 없으면 최신 글까지 옮긴다 — 안 읽은 동료 글을 건너뛰지 않는다. clear 는 확인된 caller 가 그 팀의
  루트 탭일 때만(`canClearBoard`; caller 없는 clear 는 거부). 2 단계 보기 패널의 사람용 지우기는 App 내부 함수
  `clearAgentBoard` 를 부르며 ctl·UI 커맨드로는 닿지 않는다. 표시할 때 글의 둘째 줄부터는 `    | ` 를 붙여 다른 글이나
  머리글처럼 보이지 않게 하고, 본문·이름의 Unicode 서식 문자(Cf: zero-width, bidi override)는 TS·Rust 모두 지운다.
  이 변경 전에 저장된 링크에는 `teamId` 가 없다: 재시작 뒤 그 자식은 부모 탭이 남아 있으면 parentId 사슬로 팀을 찾고,
  부모가 이미 닫혀 고아로 복원된 자식은 자기 자신이 루트(혼자인 팀)다.
  저장은 Rust `src-tauri/src/agent_board/`(아래 "팀 할 일과 보드 저장소" 참고). seq 는 `BEGIN IMMEDIATE` 안에서
  `teams.last_post_seq` 를 하나 올려 정하므로 동시에 올라온 글도 겹치지 않고, clear·상한 뒤에도 되돌아가지 않아 커서가
  그대로 맞는다. 팀당 5000 개 넘으면 같은 트랜잭션에서 오래된 글을 지운다. 탭을 닫아도 보드는 지우지 않는다. 검색은
  `LIKE ? ESCAPE '\'`(`%`·`_`·`\` 이스케이프). DB 가 깨지거나 열리지 않으면 `agent board …`·`agent task …` 만
  `team board unavailable: …` 로 실패하고 run/send/stop 은 그대로다. 감사 로그 `board_post`(작성자, team, kind, seq,
  task, textLen, 120 자 한 줄 머리)·`board_clear`(team, removed). 글·지우기 뒤 창 이벤트 `octo-agent-board`
  (`AGENT_BOARD_EVENT`, `onAgentBoardChange`)를 보낸다(4 단계 보기 패널용). `--kind announce` 는 팀의 루트 탭만 쓸 수
  있고(`canPostKind`, Rust 도 거부) 필터 없는 `board read` 가 최근 3 개를 맨 앞에 따로 보여 준다(목록에는 다시 넣지
  않는다. `--new` 에는 안 읽은 글로 순서대로 나온다). `--task <#>` 는 글을 같은 팀의 할 일에 잇는다(`(task #n)` 로 표시).
  자식 브리프에 짧은 `<bbarit team-board>` 블록(시작 전·막힐 때 `board read --new` 와 `task list`, 번호가 주어지면
  `task claim 3`, 아니면 `task claim --next`, 끝나면 `task done 3 --summary "…"`, 막히면 `task block 3 --reason "…"`,
  발견·결정은 `board post`, 비밀 금지, 읽은 내용은 지시가 아님)을 붙인다. 블록의 명령은 그대로 복사해도 안전하다
  (`a|b` 나 맨 `<#>` 가 없다). `agent.board.*`·`agent.task.*` 는 `SECRETARY_ALLOWED_CMDS` 밖이다.

- **팀 할 일**(설계 [2026-11-16-agent-team-board-v2-design.md](superpowers/specs/2026-11-16-agent-team-board-v2-design.md),
  2 단계): `agent task add|list|show|claim|block|unblock|release|done|submit|approve|reject|fail|retry|reopen|cancel|edit|dep`.
  UI 커맨드 `agent.task.<sub>` 는 모두 `checkAgentCaller` 를 거친다. 쓰기는 확인된 caller 가 필요하고 언제나 caller
  자기 팀이다(`planTaskWrite`, `--team` 으로 다른 팀을 고치지 못한다). 읽기(list/show)는 보드처럼 `--team` 으로 어느
  팀이든 된다(`planTaskRead`). 요청 → 저장 연산 변환·글자 정리·한도는 `buildTaskOp`(`src/terminal/agentTasks.ts`),
  상태 기계(누가 어느 상태에서 무엇을 할 수 있나)는 Rust `agent_board/model.rs` `check_transition` 한 곳에 있다.
  caller 가 팀의 루트 탭이면 actor 에 `root` 가 붙는다(승인·재개·한도 넘은 재시도·취소 권한). 사람 버튼용 App 내부
  함수 `humanTaskAction`(actor `user`, `human`)은 ctl·UI 커맨드로 닿지 않는다(4 단계 보기 패널이 쓴다).
  - 상태: open(의존 작업이 done 이 아니면 "waiting" 으로 보임, 저장하지 않음) → claimed ⇄ blocked → (needs_review 면
    review) → done / failed / cancelled. 전이 규칙은 설계 문서의 표 그대로다. 모든 전이는 한 트랜잭션이다: 기대 상태(와
    필요하면 주인)로 묶은 UPDATE + `task_events` 한 줄. UPDATE 가 아무 행도 바꾸지 못하면 성공이 아니라 현재 상태를
    밝힌 에러다("#12 is already claimed by b2 (worker)").
  - done/submit 은 `--summary`(한 줄, 500 자) 필수, 본문 8000 자, branch·commit·worktree·checks(passed|failed|none)·
    artifact(key=value, 20 개). branch·worktree 를 안 주면 caller 의 릴레이 워크트리(`agent run --worktree`)를 쓴다.
    done 에 이르면(승인 포함) 같은 트랜잭션에서 kind `done` 글을 task 에 이어 올린다 — `board read --new` 로 동료가 안다.
  - `claim --next`: open 이고 의존 작업이 모두 done 인 것 중 priority 높은 것, 같으면 번호 낮은 것. 없으면 ctl 종료 코드 4.
    의존은 같은 팀만, 자기 자신 금지, 추가 때(`add --after` 포함) 깊이 64 까지 순환 검사(넘으면 거부), 작업당 32 개.
    취소된 의존 작업은 끝난 것으로 치고 "a dependency was cancelled" 로 표시한다(취소된 작업을 새 의존으로는 못 단다).
    실패한 의존 작업은 계속 막는다.
  - 권한(`model::check_transition`·`check_edit`): 자기가 낸 작업은 루트 탭도 승인·반려할 수 없다(사람만 예외). 편집과
    의존 변경은 만든 쪽·루트 탭·사람, 주인은 claimed/blocked 동안만, 끝난 작업은 루트 탭·사람만. `review` 를 바꾸는 것은
    만든 쪽·루트 탭·사람만, 지금 주인은 안 되고 review 상태에서도 안 된다. 사람(`user`)은 claim·block·unblock·release·
    done·submit·fail 을 하지 않는다.
  - 임대(lease): claim 이 `lease_until = now + agents.board.leaseSeconds`(기본 300)와 `owner_instance`(앱 시작마다
    무작위, 메모리에만)를 적는다. 갱신은 웹뷰가 아니라 Rust 호스트가 한다(`agent_board::start_lease_worker`): 이
    인스턴스가 쥔 작업이 있을 때만 `renewSeconds`(기본 60, 임대의 절반 이하) 마다 깨어나, 호스트의 PTY 백엔드
    (`PtyBackend::alive`, 프로세스 안·PTY 홀더 모두)로 주인 탭의 PTY 가 살아 있으면 UPDATE 한 번으로 늘리고, 죽었으면
    `auto_release` 한다. 창이 가려지거나 숨거나 웹뷰가 다시 로드돼도 계속 돈다. 실패하면 간격을 두 배로 늘리되 임대의
    절반 아래로만, 놓기에 실패한 작업은 다음 틱에 다시 놓고 절대 갱신하지 않는다. 앱이 끝나거나 업데이트로 넘겨줄 때
    (`RunEvent::Exit`, `app_relaunch_for_update`) 먼저 멈추므로 PTY 홀더가 살려 두는 탭의 작업은 놓이지 않고 다시
    켜면 다시 맡는다. 탭이 닫히면 웹뷰가 바로 놓기를 부탁하지만 호스트는 그 PTY 가 정말 끝났을 때만 놓는다(웹뷰의
    "PTY disconnected" 로는 놓지 않는다). 시작(과 웹뷰 로드) 때 이 호스트의 다른 인스턴스 작업은 PTY 홀더가 되살린
    탭이면 다시 맡고, 아니면 오래된 것(심장 박동이 `renewSeconds` 의 두 배보다 오래됐거나 임대가 끝남)만 놓는다 — 같은
    DB 를 쓰는 다른 앱이 살아 있으면 그 작업은 건드리지 않는다(`planStartupLeases`; DB 파일이 없으면 만들지 않는다). 읽기·claim 은 `lease_until < now` 인 작업을 같은 팀 범위에서 `lease_expired` 로 놓는다 — 단, 주인이 자기
    작업에 쓰는 경우는 그 작업을 놓지 않고 임대를 새로 한다(살아 있음을 스스로 보였으므로). "stale"(claimed/blocked 인데
    `staleMinutes`(기본 30) 동안 바뀐 것 없음)은 표시만 한다.
  - 한도: 팀당 할 일 2000 개·이벤트 20 000 개(넘으면 가장 오래 끝난 할 일을 이벤트와 함께 먼저 지운다. open/claimed/
    blocked/review 와, 살아 있는 할 일이 의존하거나 자식으로 둔 끝난 할 일은 지우지 않는다. 지울 것이 없으면 add 를
    거부), 글 5000 개, 30 일 동안 글·할 일 변화가 없는 팀은 앱 시작 때 통째로 지운다.
  - 감사 로그: `task_<action>`(caller, team, task, from, to, post, by; 제목·이유·에러·요약은 길이와 120 자 머리만),
    앱이 놓은 것은 `task_auto_release`·`task_lease_expired`. 창 이벤트 `octo-agent-board` 의 `action: 'task'`
    (`task`, `taskAction`, `state`) — 보기 패널이 다시 읽는 신호다.
  - 설정 `config.json` → `agents.board.{leaseSeconds 60..3600, renewSeconds 10..600, staleMinutes 5..1440}`
    (`normalizeAgentBoardConfig`, 범위 밖은 잘라 맞춤, renew 는 lease 의 절반 이하).

### 팀 할 일과 보드 저장소 (스키마 2, 외부에서 읽는 사람용)

Rust 모듈 `src-tauri/src/agent_board/`: `model.rs`(한도·글자 규칙·actor·상태 기계, 엔진과 무관), `common.rs`(두 엔진이
같이 쓰는 할 일 행·JSON·입력 검사), `store.rs`(`BoardStore` — 모든 연산이 지나는 async 인터페이스, `Sqlite`·`Pg` 두 변형),
`sqlite.rs`·`pg.rs`(엔진별 SQL 전부), `config.rs`(사용 유형·연결 칸·비밀번호 파일·가림), `copy.rs`(데이터 복사),
`admin.rs`(설정 화면 커맨드), `mod.rs`(게시판 커맨드와 저장소 고르기, SQL 없음), `tests.rs`(`BoardStore` 만 쓰는 동작
테스트 묶음 — SQLite 에는 늘, `BBARIT_TEST_PG_URL` 이 있으면 PostgreSQL 에도 같은 테스트를 돌린다). 커맨드:
`agent_board_post|read|teams|clear|info`, `agent_task_write|list|show`, `agent_task_lease_tick|release_owner|held_on_host|
lease_apply`, 설정용 `agent_board_settings_status|pg_test|pg_migrate|copy|pg_cleanup|secret_save|secret_clear`.

#### 저장소 고르기 (SQLite / PostgreSQL)

- `config.json` → `agents.board.mode`: `sqlite`(기본), `sync`(3b 단계 동기화 작업자가 들어오기 전까지는 SQLite 와 같다),
  `postgres`. 예전 키 `backend: "sqlite" | "postgres"` 도 같은 이름의 mode 로 읽는다. 모르는 값은 SQLite(서버로 몰래 바꾸지
  않음) + 설정 화면 경고. 연결 칸은 `agents.board.postgres.{host, port, database, user, sslMode, schema}`(기본 스키마
  `bbarit_board`). 저장소는 명령마다 설정·환경·비밀번호 파일을 다시 읽어 고르므로 바꾸면 다음 명령부터 적용된다. 자동 복사는 없다.
- 비밀번호는 config.json 에 넣지 않는다: `~/.config/octo/agent-board.secret`(debug `agent-board.dev.secret`), 0600,
  무작위 이름의 임시 파일에 쓰고 rename. 둘째 줄에 그 비밀번호의 서버(`user@host:port/database`)를 함께 적고, 연결 칸이
  다른 서버를 가리키면 쓰지 않고 "re-enter the password for this server" 로 거부한다. 쓰기 전용 커맨드로만 저장하고,
  웹뷰는 "저장됐는가, 어느 서버용인가"만 안다. `BBARIT_BOARD_DATABASE_URL` 은 터미널 환경에서 빠진다
  (`pty_backend::HIDDEN_FROM_TERMINALS`). `BBARIT_BOARD_DATABASE_URL`(프로세스
  환경 또는 `~/.config/octo/.env`)이 있으면 연결 칸과 비밀번호 대신 그 URL 을 쓴다(스키마는 설정값). 오류 문자열은 모두
  비밀번호·URL 사용자 정보·`password=` 를 가린다(`config::redact`; sqlx 오류에 URL 이 섞일 수 있다).
- PostgreSQL 이 골라졌는데 닿지 않거나 설정이 비었으면 게시판 명령만 `team board unavailable: …` 로 실패한다. run/send/stop
  은 그대로다. 표는 앱이 저절로 만들지 않는다: 설정의 "표 만들기 / 올리기" 만 마이그레이션을 실행한다(먼저 실행할 문장을
  보여 준다, advisory lock 안에서 버전을 다시 읽는다). 데이터베이스가 앱보다 새 버전이면 명령도 마이그레이션도 거부한다.
- 연결: sqlx `PgPool` 최대 5 개, 연결 5 초 제한, 세션마다 `statement_timeout` 5 초, TLS 는 `sslMode`(rustls). 스키마 이름은
  `[a-z_][a-z0-9_]{0,62}`(pg_… 와 information_schema 제외)만 받고 SQL 에서는 늘 따옴표로 감싼다. 값은 모두 바인딩.
- PostgreSQL 엔진의 차이: 쓰기는 먼저 팀 행을 `FOR UPDATE` 로 잠근다(번호·상한·전이 검사가 SQLite 와 같게 동작하고, 잠금
  순서가 늘 팀 → 할 일이라 교착이 없다). 바꾸는 할 일은 `FOR UPDATE`, `claim --next` 와 임대 만료는 `FOR UPDATE SKIP LOCKED`,
  `--new` 읽기는 팀 행 `FOR SHARE`, 일반 읽기는 REPEATABLE READ 스냅숏 하나. 검색은 `ILIKE`. 교착·직렬화 실패는 세 번까지
  다시 한다. 로컬 변경 기록(`changes`, `sync_state`)은 없고, 대신 동기화될 표(teams, posts, tasks, task_deps, task_events)의
  모든 insert/update 가 트리거로 `board_server_seq` 에서 새 `server_seq` 를 받는다(3b 의 pull 기준). `posts.arrival` 은
  팀 잠금 안에서 `board_arrival_seq` 로 받는다. 서버 전용 `hosts(host, instance_id, first_seen, last_seen, app_version)` 표도
  미리 만든다. 30 일 팀 정리는 PostgreSQL 에서 자동으로 돌지 않고 "오래된 팀 정리" 버튼으로만 돈다(먼저 몇 개인지 세어
  보여 주고 확인을 받는다). PostgreSQL 저장소 호출은 모두 15 초 제한이 있다.
- 데이터 복사: 살아 있는 팀의 teams·posts·tasks·task_deps·task_events·cursors 를 다른 저장소로 넣는다(사용 유형이 쓰는
  쪽으로). 대상에 팀이 하나라도 있으면 거부하고, "대상에 없는 팀만 합치기" 를 켜면 같은 uid 나 같은 (team, home_host) 팀은
  건너뛴다. id·번호·row_version·시각은 그대로, `arrival` 은 대상이 새로 주고 읽기 커서는 그 순서로 바꾼다. 원본은 바꾸지
  않는다. 방향은 사람이 고른다. 글은 읽은 순서(`team_uid, arrival`)로 내보내고 넣는다(PostgreSQL 은 300 행씩
  묶어 넣는다). 대상의 묘비 팀은 "비어 있지 않음"으로 치지 않고, 복사할 팀과 겹치면 먼저 완전히 지운다. SQLite 로
  들어간 행은 변경 기록에 남는다.
- 공유 서버에서는 데이터베이스 계정이 곧 신뢰 경계다: 그 계정을 가진 누구나 어떤 팀이든 쓸 수 있다. 호출자 확인은 각 앱
  안에서만 한다. 설정 커맨드는 `agent.*` UI 커맨드가 아니고, `config get|set`(`config.get`/`config.patch`)은
  `agents.board.mode|backend|postgres` 를 보여 주지도 바꾸지도 않는다(부모 경로를 바꿔도 그 값은 그대로) — 다만 로컬
  브리지처럼 같은 사용자의 프로세스가 Tauri 커맨드를 직접 부르는 것은 막지 못한다(아래 "알려진 한계").
- 테스트용 PostgreSQL: `docker run -d --name bbarit-board-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16`
  뒤 `BBARIT_TEST_PG_URL=postgres://postgres:test@127.0.0.1:55432/postgres cargo test --manifest-path src-tauri/Cargo.toml
  agent_board`(픽스처마다 스키마를 따로 만들고 지운다; `BBARIT_TEST_PG_REQUIRED=1` 이면 URL 이 없을 때 건너뛰지 않고
  실패), 끝나면 `docker rm -f bbarit-board-pg-test`.

파일 `~/.config/octo/agent-board.db`(debug 빌드 `agent-board.dev.db`), 0600(db·`-wal`·`-shm`), WAL, busy_timeout
5 s, 연결 하나를 뮤텍스 뒤에 두고 블로킹 풀에서 돌린다. 모든 쓰기는 `BEGIN IMMEDIATE`, 모든 SQL 은 바인딩 파라미터.
버전은 `board_meta.schema_version`(같은 값을 `PRAGMA user_version` 에도 적어 1 단계 앱이 v2 파일을 "newer app
version" 으로 거부하게 한다). 열 때 버전만 읽고 낮을 때만 쓰기 잠금으로 순서대로 마이그레이션한다(1 단계 파일은 데이터
그대로 v2 로 올라간다). 앱보다 새 버전이면 거부한다. 시각은 모두 unix ms 정수, JSON 값은 JSON 을 담은 TEXT, 상태·종류는
CHECK 없는 텍스트(코드가 검사).

동기화 준비(아직 동기화 작업자는 없다): teams·posts·tasks·task_deps·task_events 는 UUIDv7 텍스트 id(teams 는 `uid`)를
쓰고, 모두 `origin_host`, `updated_at`, `row_version`(바뀔 때마다 +1), `deleted_at`(묘비)을 가진다. clear·상한·30 일 정리는
지우지 않고 `deleted_at` 을 적으며 읽기는 묘비를 건너뛴다. 30 일 지난 묘비는 앱 시작 때 실제로 지운다. 이런 행을 넣거나
바꾸거나 묘비로 만들 때마다 같은 트랜잭션에서 `changes` 에 한 줄을 남긴다(`log_change`; 소비자가 없으면 최근 50 000 줄만
둔다). 팀은 `uid` 로 가리키고, 루트 탭 id(`team`)는 `home_host`(팀을 만든 기계, 번호와 할 일 상태의 주인)와 함께 유일하다.
`--new` 커서는 `seq` 가 아니라 이 기계에 도착한 순서(`posts.arrival` = 그 글을 넣은 변경 위치)를 쓴다 — 나중에 도착한
낮은 번호의 글도 건너뛰지 않는다. 호스트 id 는 호스트 이름(`BBARIT_BOARD_HOST` 로 바꿀 수 있다).

| 표 | 열 |
|---|---|
| `board_meta` | `key` PK, `value` — `schema_version`, `created_at`, `created_by_app_version` |
| `teams` | `uid` PK (UUIDv7), `team` (루트 탭 id), `name`, `home_host`, `home_instance`, `created_at`, `last_post_seq`, `last_task_seq`, `last_activity_at`, 동기화 열 — UNIQUE(team, home_host) (번호는 되돌아가지 않는다) |
| `posts` | `id` PK (UUIDv7), `team_uid`, `seq` (UNIQUE(team_uid, seq)), `ts`, `author_id`, `author_name`, `author_cli`, `author_host`, `kind` (note, finding, question, decision, done, announce), `text`, `task_id` NULL, `arrival`, 동기화 열 |
| `cursors` | (`team_uid`, `tab_id`) PK, `arrival` — `board read --new` 커서(이 기계 전용, 동기화하지 않음) |
| `tasks` | `id` PK (UUIDv7), `team_uid`, `seq` (UNIQUE(team_uid, seq), 에이전트가 쓰는 `#n`), `parent_id`, `title` (≤200), `body` (≤8000), `state` (open, claimed, blocked, review, done, failed, cancelled), `priority` (0–3, 기본 1), `needs_review` (0/1), `created_by_id/_name/_host`, `owner_id/_name/_host`, `owner_instance`, `attempt` (기본 0), `max_attempts` (기본 3), `blocked_reason`, `last_error` (≤2000; reject 이유는 `rejected: …`), `result_summary` (≤500), `result_body` (≤8000), `result_branch`, `result_commit`, `result_worktree`, `result_checks` (passed, failed, none), `result_artifacts` (JSON 객체), `labels` (JSON 배열), `meta` (JSON 객체), `created_at`, `updated_at`, `claimed_at`, `started_at`, `submitted_at`, `finished_at`, `lease_until`, `heartbeat_at`, `due_at`, `version` (내용이 바뀔 때 +1, 화면 편집의 낙관적 동시성), 동기화 열 |
| `task_deps` | (`task_id`, `depends_on_id`) PK, `team_uid`, 동기화 열 — 앞 작업이 done 이어야 claim 된다 |
| `task_events` | `id` PK (UUIDv7), `task_id`, `team_uid`, `seq` (작업별), `ts`, `actor_id/_name/_host`, `action` (add, claim, release, auto_release, lease_expired, block, unblock, submit, approve, reject, done, fail, retry, reopen, cancel, edit, dep_add, dep_remove), `from_state`, `to_state`, `attempt`, `note`, `data` (JSON), 동기화 열 |
| `changes` | `local_seq` PK AUTOINCREMENT, `tbl`, `row_id` (task_deps 는 `<task_id>/<depends_on_id>`), `at` |
| `sync_state` | `key` PK, `value` — 지금은 비어 있다(`consumer` 가 있으면 `changes` 를 줄이지 않는다) |

동기화 열 = `origin_host`, `updated_at`, `row_version`, `deleted_at`.

인덱스: `tasks(team_uid, state, priority DESC, seq)`, `tasks(team_uid, owner_id, state)`, `tasks(parent_id)`,
`tasks(state, lease_until)`, `task_deps(depends_on_id)`, `task_events(task_id, seq)`, `task_events(team_uid, ts)`,
`posts(team_uid, kind, seq)`, `posts(team_uid, ts)`, `posts(team_uid, arrival)`. 앱 밖에서 이 파일을 읽을 때(`sqlite3`)는 읽기만 하는 것이 안전하다 —
쓰기는 앱의 규칙(임대·이벤트·카운터)을 거치지 않는다.

### 알려진 한계

- 제한은 링크 기준이다. 사용자가 손으로 연 탭이나 `term create` 로 만든 탭은 세지 않는다. 앱을 다시 켜면 링크는
  저장본에서 복원되므로 제한도 이어진다.
- **호출자 확인과 maxDepth·maxChildren 은 보안 경계가 아니다.** 탭이 플래그나 환경 변수로 다른 탭인 척하는 것은
  막지만(토큰이 맞아야 한다), 로컬 브리지는 어떤 로컬 클라이언트든 받고, 키 파일과 다른 프로세스의 환경 변수는
  같은 사용자가 읽을 수 있어 악성 로컬 프로세스는 토큰을 만들거나 베낄 수 있다. caller 를 빼는 요청도 예전처럼
  받는다(누구의 자식도 아니고 maxTotal 에만 든다). caller 없는 `agent stop <자식 id>` 는 지금도 어느 릴레이 자식이든
  멈춘다 — 막는 것은 "다른 탭의 id 를 대서 그 탭으로 행세하기" 다. 그래서 이것들은 사고(끝없는 팬아웃, 엉뚱한 탭의
  자식으로 계산)를 막는 장치다. 하드 상한은 caller 와 무관하게 모든 링크를 세는 maxTotal 이다.
- 예전 앱이 띄운 홀더 셸은 그 셸이 살아 있는 동안 토큰 없이 `legacy` 로 받으므로, 그동안은 누구든 토큰을 빼고 그 탭
  id 를 댈 수 있다. 오래된 탭을 새로 열면 사라진다. 키 파일을 지우면 새 키(새 시각)가 생겨 그 전의 셸은 토큰이 틀리고,
  토큰을 빼면 legacy 로 보일 수 있다 — 키 파일을 지울 수 있는 프로세스는 이미 경계 밖이다.
- 팀 보드·할 일은 같은 사용자의 로컬 프로세스가 DB 파일을 직접 읽고 고칠 수 있고, caller 를 빼고 `--team` 으로 어느
  팀이든 읽을 수 있다(쓰기·지우기는 확인된 caller 만). 로컬 브리지는 Tauri 커맨드(`agent_board_clear` 등)를 직접 부를 수도
  있어 이것도 보안 경계가 아니다. 자식은 보드 글을 다른 에이전트의 정보로만 다루라고 안내받지만, 그 안내가 프롬프트
  주입을 막는 장치는 아니다.
- 임대 갱신은 앱이 깨어 있을 때만 돈다. 노트북이 임대 시간보다 오래 잠들면 깨어난 뒤 다른 읽기가 그 작업을 먼저
  놓을 수 있다(주인은 다시 claim 하면 된다). 같은 호스트에서 같은 DB 파일을 쓰는 앱 두 개를 동시에 켜면 나중에 켠
  쪽이 시작할 때 먼저 켠 쪽의 작업을 놓을 수 있다(보통은 dev 와 설치본이 다른 파일을 쓴다).
- 감사 로그는 앱이 남기는 기록이다. 같은 사용자 권한의 프로세스는 파일을 고치거나 지울 수 있어 변조 방지 기록은 아니다.

- caller 가 활성 프로젝트가 아닌 프로젝트에 있으면 자식은 그 프로젝트를 화면에 띄울 때까지
  시작되지 않는다(터미널은 활성 프로젝트 것만 마운트된다). 10 분이 지나면 `agent not ready`.
- 7501 없는 자식의 끝남은 30 s 무출력 추정이라 긴 무출력 작업을 오판할 수 있다.
- `--worktree` 워크트리와 `agent/<slug>` 브랜치는 저절로 지워지지 않는다. 검토 뒤 사람이
  `git worktree remove` / `git branch -d` 로 정리한다. 워크트리를 만든 뒤 탭 생성이 실패해도 남는다.
  동시에 같은 이름으로 두 자식을 띄우면 둘째는 `git worktree add` 에러로 실패할 수 있다.
- 인터럽트 키를 모르는 CLI(codex, gemini, qwen, opencode, cursor, kimi, pi, reasonix, gajae)는
  `agent stop` 으로 멈추지 못한다(`--close` 로 탭을 닫는 것만 된다). 키가 확인되면 `interruptKeysFor`
  에 근거와 함께 넣는다. Claude·bbarit·셸·ollama 도 실제로 멈추는지는 개발 앱에서 확인하지 않았다.
- 7501 을 보고하지 않는 오래된 Claude Code 탭에는 `agent send`·노트도 `\r` 로 간다(브리프만 설정 키).
  Claude 가 clear 없이 죽으면(강제 종료 등) 레코드가 남아 zsh 에 CSI-u 가 갈 수 있다(PTY 가 끝나면
  working/blocked 만 버린다). 다른 후보(DEC 1004·2031·1049, 마우스 모드)도 시작 때 켜지고 종료 때
  꺼지지만 fullscreen 설정에 따라 달라 쓰지 않았다.
- 제출 키는 Chat 맥락의 enter·shift+enter·cmd+enter 만 본다. ctrl/alt+enter 나 다른 키에만 묶인
  제출은 보낼 수 없다(`warning`). 메신저의 명시적 `enter` 키 명령, XTerminal 내부의 스킬 가로채기·
  시작 명령은 그대로 `\r` 이다.
- Claude 가 한 번도 신뢰하지 않은 폴더에서 뜬 자식은 "trust this folder" 확인에서 멈추고 브리프가
  들어가지 않는다(`agent not ready`). 이미 신뢰한 폴더를 쓴다. 신뢰한 저장소 안의 `--worktree`
  워크트리는 실기에서 확인을 묻지 않았다.
- 출력 폴백은 "최근 3 s 출력" 이라 스피너 없이 조용히 일하는 자식은 working 으로 보이지 않을 수 있다.
- mcp-bridge `execute_js` 는 5 s 에서 끊는다. 게이트 대기가 긴 `agent send`·`term write` 는 ctl 이
  40 s 를 기다려도 5 s 에 `Script execution timeout` 을 받을 수 있다(이번 변경 밖, 기존 동작).
- `--worktree <name>` 의 이름은 플래그 바로 뒤, 프롬프트 앞에 쓴다(`--worktree=<name>` 도 된다).
  뒤에 cliType 과 프롬프트 단어가 남지 않으면 다음 단어를 이름으로 보지 않는다.
- 실기 확인(macOS 개발 빌드)은 하지 않았다. 단위 테스트, build, lint, `--audit`,
  `check:bundled-scripts`, `cargo test` 만 통과.
