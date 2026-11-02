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

### 1. 탭 안에서 ctl 에 닿기 (PTY 환경, create_shell·create_cli_shell 둘 다)

- `BBARIT_TERMINAL_ID`, `BBARIT_BRIDGE_PORT` — [CLAUDE_SESSION_HOOK.md](CLAUDE_SESSION_HOOK.md)
  브랜치가 추가한다. 이 브랜치는 그 값이 있다고 가정하고 **추가하지 않는다**(머지 충돌 방지).
- `BBARIT_CTL` — `bbarit-ctl.mjs` 의 절대 경로. 개발 실행은 `<repo>/scripts/bbarit-ctl.mjs`,
  설치본은 번들 리소스. `scripts/bbarit-ctl.mjs` 를 `tauri.conf.json` `resources` 에 추가한다
  (`tauri-dev-screen.mjs` 와 같은 방식. ctl 은 `ws` 없이 Node 22 내장 WebSocket 으로 돈다).
- 에이전트는 `node "$BBARIT_CTL" agent …` 로 부른다. `node` 가 없는 환경은 지원하지 않는다
  (Claude Code 사용자 환경에는 사실상 있다). 문서에 적는다.
- ctl 은 `BBARIT_TERMINAL_ID` 가 있으면 그것을 **호출자(caller)** 로 모든 agent 커맨드에
  실어 보낸다. `BBARIT_BRIDGE_PORT` 가 있으면 포트 스캔 없이 그 앱의 mcp-bridge 포트
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
| `agent.run` | `cliType` (claude·codex·shell…), `prompt`, `caller?`, `workDir?`, `name?` | 현재 프로젝트에 터미널을 만들고 `agentLinks` 에 `{child, parent: caller}` 를 넣는다. 에이전트가 준비되면(7501 `idle` 보고 또는 기존 `looksLikeAgentUiReady`, 최대 60 s) 3 절의 첫 메시지를 게이트로 넣는다. 즉시 `{ ok, terminalId }` 를 돌려준다(비동기 주입). `caller` 없으면 링크 없이 터미널만 만든다. |
| `agent.send` | `terminalId`, `text`, `caller?`, `force?` | `queueAutoInput(terminalId, wrapped, { source: 'agent', submit: true, force })`. `caller` 가 있으면 `<bbarit from="<callerName>">text</bbarit>` 로 감싼다. 거부 사유는 `terminal.write` 와 같다. |
| `agent.status` | `caller?`, `terminalId?` | `terminalId` 가 있으면 그 하나, 없으면 `caller` 의 자식 전부: `{ terminalId, name, cliType, state (7501 rollup 또는 busy 폴백), kind?, exited, lastLines (12줄) }`. |
| `agent.list` | `caller?` | `agent.status` 와 같되 `lastLines` 없음. |

`agent.wait` 는 서버 쪽 커맨드가 **아니다**. 게이트웨이 30 s 타임아웃과 ctl 20 s 기본 타임아웃을
넘기지 않기 위해 ctl 이 `agent.status` 를 2 s 간격으로 폴링한다.

### 4. ctl 서브커맨드 (`scripts/bbarit-ctl.mjs`)

    agent run <cliType> <prompt…> [--bg] [--workdir <dir>] [--name <n>] [--timeout <s>]
    agent send <terminalId> <text…> [--force]
    agent wait [--id <terminalId> | --children any|all] [--timeout <s>=600]
    agent status [terminalId] | agent list

- `run` 은 기본으로 **기다린다**: 자식이 `done`/`blocked`/종료가 될 때까지 폴링한 뒤
  `agent.status` 결과(상태 + 마지막 12줄)를 출력하고, blocked 면 종료 코드 2, 타임아웃은 3.
  `--bg` 면 terminalId 만 찍고 바로 끝난다.
- `wait` 는 조건을 만족하는 순간의 상태 목록을 JSON(`--json`) 또는 표로 찍는다. `any` 는
  하나라도 `done|blocked|exited`, `all` 은 전부.
- 모든 agent 커맨드는 `BBARIT_TERMINAL_ID` 를 `caller` 로 보낸다. 없으면 `--caller <id>` 로
  줄 수 있다.

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
- 워크트리 생성. `--workdir` 는 있는 디렉터리를 받을 뿐이다. 작업별 워크트리 자동 생성은 후속.

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
  (`agentRunTerminalSpec`, `dedicatedClaudeSessionFields`). 탭 이름은 `--name` 또는
  `<cliType> (agent)`.
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

### 알려진 한계

- caller 가 활성 프로젝트가 아닌 프로젝트에 있으면 자식은 그 프로젝트를 화면에 띄울 때까지
  시작되지 않는다(터미널은 활성 프로젝트 것만 마운트된다). 10 분이 지나면 `agent not ready`.
- 7501 없는 자식의 끝남은 30 s 무출력 추정이라 긴 무출력 작업을 오판할 수 있다.
- 실기 확인(macOS 개발 빌드)은 하지 않았다. 단위 테스트, build, lint, `--audit`,
  `check:bundled-scripts`, `cargo test` 만 통과.
