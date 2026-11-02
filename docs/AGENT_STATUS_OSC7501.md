# 에이전트 상태 표시 (OSC 7501) 와 알림 모델

작성일 2026-11-02. 상태: 설계 확정, 구현 중.

## 배경

빠릿은 지금 터미널 상태를 PTY 출력 활동으로만 추정한다. 출력이 멈추면 `busyTerminals`
에서 빠지고(`src/App.tsx` 의 `busyTerminals`), `XTerminal.tsx` 의 idle 타이머가
`octo-task-toast` 이벤트를 쏘면 완료 토스트와 OS 알림이 뜬다. 그래서

- Claude Code 가 **권한 승인이나 질문을 기다리는 상태**를 구분하지 못한다. 출력이 멈추면
  "완료"로 보이고, 사용자는 탭을 열어 보기 전까지 모른다.
- 완료 알림이 **보고 있는 탭에서도** 매번 울린다.
- 도구 호출 사이의 짧은 멈춤이 완료로 오인될 수 있다.

Claude Code 2.1.295 부터 Program Status Protocol(OSC 7501)을 지원한다. 시작 시 터미널에
지원 여부를 묻고, 터미널이 답하면 이후 상태 변화를 이스케이프 시퀀스로 알려 준다. 화면을
읽어 추정할 필요가 없다. 참고 스펙: https://www.superlogical.com/rex/docs/build/program-status
(rev 0.4). herdr-core 와 Ghostty, Rex 가 같은 프로토콜을 쓴다.

## 프로토콜 요약

프로그램 → 터미널 (보고):

    ESC ] 7501 ; key=value(:key=value)* ST        ST = ESC \ 또는 BEL

프로그램 → 터미널 (지원 질의):

    ESC ] 7501 ; ? ST

터미널 → 프로그램 (질의 응답, 질의와 같은 종결자로):

    ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth ST

키:

| 키 | 값 | 비고 |
|---|---|---|
| `state` | `idle` `working` `done` `blocked` `error` `clear` | 필수. 모르는 값이면 보고 전체 무시 |
| `id` | `seg(/seg)*`, seg = `[A-Za-z0-9_.+-]{1,32}` | 없으면 루트 레코드. 깊이 8, 128바이트 |
| `kind` | `permission` `question` `auth` | `blocked` 일 때만 |
| `progress` | 0–100 | `working`/`blocked` 일 때만 |
| `app` | `[A-Za-z0-9_.+-]{1,32}` | 예 `claude-code` |
| `title`, `msg` | base64(UTF-8) | 제어문자 금지. msg 2048바이트, title 192바이트 |

규칙: 키·값 양쪽 공백 제거, 잘못된 쌍은 건너뜀, 모르는 키 무시, 중복 키는 마지막 값.
시퀀스 전체 4096바이트, 레코드 256개 제한. `clear` 는 해당 id 와 자식을 지우고, id 가
없으면 전부 지운다. 프로세스 종료나 OSC 133 `A`(새 프롬프트) 를 받으면 `working`/`blocked`
는 버린다. `done`/`error` 는 남는다.

Claude Code 는 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` 이면 질의도 보고도 하지 않는다.
tmux 안에서는 tmux 가 지원해야만 보고한다. 백그라운드 세션은 보고하지 않는다.

## 설계

### 1. 수신: `src/terminal/programStatus.ts` (새 파일, 순수 함수)

- `parseProgramStatus(data: string): ProgramStatusReport | { query: true } | null`
  위 문법을 그대로 구현한다. 테스트 파일 `programStatus.test.ts` 를 함께 둔다.
- `PROGRAM_STATUS_QUERY_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth'`
  뒤에 질의가 쓴 종결자(`\x1b\\` 또는 `\x07`)를 붙여 돌려준다. xterm.js OSC 핸들러는
  종결자를 알려 주지 않으므로 기본은 `ESC \` 로 답한다(Claude Code 는 `ESC \` 로 묻는다).
- 레코드 집합 → 탭 상태 한 개로 접는 `rollupAgentState(records): AgentTabState`.
  우선순위는 `blocked > working > done > idle`. 루트 레코드를 기준으로 하고 자식 레코드는
  루트가 없을 때만 본다.

### 2. 연결: `src/XTerminal.tsx`

- 터미널 생성 시 OSC 52 옆에 `term.parser.registerOscHandler(7501, ...)` 를 등록한다.
  질의면 `writeToPty` 로 응답하고, 보고면 파싱해 `terminalStates` 의 새 필드
  `programStatus` 에 반영한 뒤 `window.dispatchEvent(new CustomEvent('octo-agent-status', { detail }))`
  를 보낸다. detail 은 `{ terminalId, cliType, state, kind, app, msg, turn }`.
- **턴 카운터**: 루트 상태가 `working` 에서 다른 상태로 바뀔 때마다 1 증가한다. "본 턴"
  과 비교해 중복 알림을 막는 데 쓴다.
- 프로세스가 끝나거나(`check_pty_alive` 실패, exit 처리) 셸 프롬프트가 다시 보이면
  `working`/`blocked` 레코드를 버린다. OSC 133 은 지금 등록돼 있지 않으므로 이번에는
  PTY 종료와 터미널 재생성만 처리한다.
- 7501 보고가 한 번이라도 온 터미널은 `reported = true` 로 표시한다. 이 터미널에서는
  기존 idle 타이머 기반 `octo-task-toast` 를 **쏘지 않는다**. 7501 의 `done` 이 그 역할을
  대신한다. 보고가 없는 터미널(일반 셸, 구버전 CLI)은 기존 동작을 그대로 유지한다.

### 3. 상태 모델: `src/App.tsx`

- `agentStatus: Map<terminalId, { state, kind, msg, turn, seenTurn }>` 상태를 추가한다.
- 탭(`terminal-tab`)과 사이드바 점(`project-terminal-dot`, `pty-status-dot`)의 CSS 클래스를
  `running | stopped` 에서 `working | blocked | done | idle` 로 확장한다. 7501 상태가 없는
  터미널은 기존 `busyTerminals` 로 `working | idle` 을 정한다.
  - `blocked`: 주황/노랑 계열, 깜빡임 없음, 탭에 ⏸ 또는 `?` 글리프.
  - `done`: 초록, 사용자가 그 탭을 본 뒤(`seenTurn >= turn`) `idle` 로 내려간다.
  - `working`: 지금의 `running` 과 같은 표시.
- 프로젝트 단위 집계: 프로젝트 안 터미널 중 가장 급한 상태를 프로젝트 행에 보여 준다.
  우선순위 `blocked > done > working > idle`.
- `seenTurn` 갱신 조건: 그 터미널이 활성 탭이고, 창이 포커스돼 있고, 문서가 보일 때.
  활성 탭 전환과 `focus`/`visibilitychange` 이벤트에서 갱신한다.

### 4. 알림 규칙 (herdr-app 의 모델을 따른다)

"보고 있다(looking)" = 그 터미널이 활성 탭 AND `document.hasFocus()` AND `!document.hidden`.

| 전이 | 보고 있을 때 | 안 보고 있을 때 |
|---|---|---|
| → `blocked` (이전이 blocked 아님) | 인앱 토스트 + 소리 | 인앱 토스트 + OS 알림 + 소리 |
| `working`/`blocked` → `done`/`idle` | 탭 색만 바뀜, 알림 없음 | 인앱 토스트 + OS 알림 + 소리 (기존 완료 알림) |
| 같은 턴에서 반복 보고 | 무시 | 무시 |
| 앱 시작 직후 첫 보고 | 알림 없음 | 알림 없음 |

- OS 알림과 소리는 기존 설정을 그대로 따른다: `notifyWhenWaiting !== 'never'`,
  `playOsNotifySound`, `osNotifySoundName`, `playSoundWhenDone`, `notifyOnTaskComplete`.
  새 설정은 추가하지 않는다.
- `blocked` 알림 제목은 "<프로젝트> · <터미널> 이(가) 기다립니다", 본문은 `kind` 에 따라
  "권한 승인 필요" / "질문에 답해 주세요" / "로그인 필요" 와 `msg`(있으면).
- `done` 알림은 기존 `octo-task-toast` 처리기를 재사용한다. 7501 터미널은 XTerminal 이
  `done` 전이 시점에 같은 이벤트를 쏜다(프롬프트·소요 시간 필드 포함).

### 5. 바꾸지 않는 것

- PTY 환경 구성(지금은 `pty_backend::build_shell_command`)과 Rust 쪽 코드. 7501 은 프론트에서 끝난다.
- 기존 `busyTerminals` 계산. 7501 이 없는 터미널의 표시는 지금과 같아야 한다.
- 설정 스키마. 새 키를 넣지 않는다.
- Telegram/Slack/Discord 미러, 브로커/devreview 흐름.

## 검증

- `npm run test:run` 에 `programStatus.test.ts` 추가: 질의 인식, 종결자 보존, 키 파싱,
  base64 msg 디코딩, 잘못된 state 무시, 중복 키 마지막 값, `clear`, 롤업 우선순위, 턴 증가.
- 알림 규칙은 순수 함수 `decideAgentAlert(prev, next, looking, firstReport)` 로 빼고
  표의 네 줄을 테스트로 고정한다.
- 실기 확인(macOS, Claude Code 2.1.316): Claude 탭에서 권한 프롬프트를 띄우면 탭이
  `blocked` 색으로 바뀌고, 다른 탭을 보고 있을 때 OS 알림이 오는지. 답하고 완료되면 `done`,
  탭을 보면 `idle` 로 내려가는지. 일반 zsh 탭은 이전과 똑같이 동작하는지.
  `printf '\e]7501;state=blocked:kind=permission:app=test\e\\'` 로 셸에서도 재현할 수 있다.

## 이후 과제

- OSC 133 (shell integration) 수신으로 프롬프트 복귀 시 `working` 자동 해제.
- 자동 입력 게이트: [AGENT_INPUT_GATE.md](AGENT_INPUT_GATE.md). `blocked` 상태인 탭에는
  자동 입력을 넣지 않는다.
- 외부 CLI(Codex, Gemini)가 7501 을 지원하면 추가 작업 없이 같은 경로를 탄다.

## 구현 메모

설계와 다르거나 설계가 정하지 않은 부분만 적는다.

- **lastCommand 수정**: `writeToPty` 는 입력을 `feedTerminalInput`(마지막 명령 배지)에도 넣는다.
  질의 응답 `ESC ] 7501;?:states=…` 이 그대로 들어가 다음 Enter 때 배지가 오염되므로
  `src/terminal/lastCommand.ts` 가 OSC 시퀀스(BEL 또는 `ESC \` 까지)를 건너뛰게 했다.
- **`error` 표시**: 탭 상태 4종에 `error` 가 없어서 `done` 으로 접는다(끝났고 확인 필요).
- **잘못된 `id`**: 쌍만 건너뛰면 자식 보고가 루트를 덮어쓰므로 보고 전체를 버린다.
- **턴 카운터**: 롤업 상태가 `working` 을 떠날 때 증가한다. 루트가 있으면 루트 기준과 같다.
- **레코드 256개 제한**: 가득 차면 새 id 는 버리고 기존 id 갱신은 받는다(루트 포함 계산).
- **알림 결정 위치**: `decideAgentAlert` 는 XTerminal 에서 부른다(`isActive` prop 을 알기 때문).
  App 의 `seenTurn` 갱신은 활성 프로젝트의 `activeTerminalId` 로 판단하고, 이벤트의 `looking`
  과 OR 한다. 기본 탭 화면에서는 둘이 같다.
- **처리기 등록**: 마운트별 알림 처리기는 `terminalStates` 필드가 아니라 모듈 맵
  (`programStatusHandlers`)에 둔다. 첫 마운트에서는 상태 항목이 뒤 effect 에서 생성되기 때문이다.
- **blocked 알림 세부**: 인앱 토스트는 `notifyOnTaskComplete` 와 무관하게 항상 띄운다(표의
  "blocked 는 항상 알림"). OS 알림은 `notifyWhenWaiting`/`playOsNotifySound`/`osNotifySoundName`
  을, 인앱 소리는 기존 `playSoundWhenDone` 비프를 따른다. 토스트는 15초 뒤 또는 `blocked` 를
  벗어나면 닫힌다(id `agent-blocked:<terminalId>`).
- **프로젝트 집계**: 점 컨테이너에 `agent-<state>` 클래스를 붙인다. 점마다 이미 터미널별 색이
  있어서 눈에 보이는 변화는 접힌 `+N` 표시의 색뿐이다.
- **탭 글리프**: tabs 모드 탭에 `blocked` 일 때 `?` 를 붙인다.
- **정리**: 터미널 dispose·재생성 때 App 의 항목을 지워(`cleared`) 기존 I/O 기반 표시로 돌린다.
- **필터·카운트**: 활동 필터(`isTerminalFiltered`)와 mix 화면의 running 개수도 같은 표시 상태를
  쓴다. 7501 이 없는 터미널은 기존 `busyTerminals` 결과와 같다.
- **재생(replay) 처리**: 재부착·팝아웃 복귀·웹뷰 새로고침 때 저장된 PTY 출력(최대 768 KB)을
  다시 그리는 동안 `replayingOutput` 을 켠다. 이때 받은 보고는 상태만 반영하고 모두 `firstReport`
  로 취급해 알림을 내지 않으며, 재생된 `?` 질의에는 응답하지 않는다(살아 있는 Claude 에 응답이
  다시 들어가는 것을 막는다). 수신 로직은 테스트를 위해 `src/terminal/programStatusHandler.ts`
  로 뺐다.
- **새 질의 = 새 세션**: 보고를 받은 적 있는 터미널에 `?` 가 다시 오면 저장소와 `reported` 를
  초기화한다. 이전 세션의 working → 새 세션 idle 전이가 가짜 done 알림이 되지 않는다.
- **낡은 working/blocked 정리**: 셸 안의 에이전트만 죽으면 pty-exit 가 없다. 1분마다 확인해
  루트 상태가 working/blocked 이고 마지막 보고와 PTY 출력(`pty_idle_ms`, 실패 시 프론트 활동
  시각)이 모두 10분 넘게 없으면 7501 상태를 버리고 `reported` 를 초기화한다(기존 표시·완료
  토스트로 복귀).
- **툴팁**: 점·탭 툴팁은 표시 상태에서 만든다(작업 중 / 입력 대기·권한 승인 필요 등 / 완료 / 대기).

### 알려진 한계

- 팝아웃된 터미널은 이벤트를 팝아웃 창에 보내는데 거기에는 듣는 쪽이 없다. 팝아웃 중에는
  blocked 알림이 사라진다.
- split/mix 화면에서는 `isActive` 인 창 하나만 "보고 있다" 로 친다. 화면에 보이는 다른 창의
  done 도 알림이 간다.
- 실기 확인(macOS + Claude Code)은 하지 않았다. 단위 테스트, `npm run build`, `npm run lint` 만 통과.
