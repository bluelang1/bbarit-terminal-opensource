# 자동 입력 게이트 (사람이 치는 중엔 끼어들지 않기)

작성일 2026-11-02. 상태: 구현됨(아래 "구현 메모"). [AGENT_STATUS_OSC7501.md](AGENT_STATUS_OSC7501.md) 위에 올라간다.

## 배경

빠릿은 사람 말고도 여러 경로가 사용자 터미널에 글자를 써 넣는다.

| 경로 | 위치 | 지금 방식 |
|---|---|---|
| 로컬 제어 `terminal.write` (bbarit-ctl, 브리지 UI 커맨드) | `src/App.tsx` `case 'terminal.write'` | 텍스트 쓰고 `terminalSubmitDelayMs` 뒤 `\r` |
| 스케줄러 잡 | `src/App.tsx` `runSchedulerJob` | `command + '\n'` 즉시 |
| Telegram 수신 | `src/App.tsx` `writeToTerminalWhenReady` | 줄마다 `\r`, 80 ms 간격 |
| Discord / Slack 수신 | `src/App.tsx` Discord·Slack 폴러 | 명령 텍스트 쓰고 타이머 뒤 `\r`. `ctrl+c`/`esc`/`enter` 는 사용자가 명시한 커맨드일 때만 `\x03`/`\x1b`/`\r` |
| 개발/리뷰어 쌍 릴레이 | `src/devreview/devReviewPair.ts` `throwToTerminal`, `submitTerminalInput` | 텍스트, 지연 뒤 `\r`. 6 초마다 |
| 허브 항목 → 에이전트 터미널 | `src/App.tsx` 허브 주입 | setTimeout 으로 `\r` |
| 에디터 → 터미널 프롬프트 | `src/App.tsx` `onTerminalPrompt` | 텍스트, 500 ms, `\r` |
| 칸반 → 콘솔 | `src/App.tsx` `onSendToConsole` | `prompt + '\n'` |
| 브리지 HTTP `write_to_pty` 직접 호출 | `src-tauri/src/browser_bridge.rs` | Rust 에서 PTY 로 바로 씀 |

공통 문제:

- **사람이 치는 도중에 끼어든다.** 사용자가 프롬프트를 입력하는 중에 Telegram 명령이나
  릴레이 텍스트가 섞여 들어가면 두 입력이 한 줄에 합쳐진다.
- **대기 중인 다이얼로그에 답을 해 버린다.** Claude Code 가 권한 승인(`y/n`)을 기다리는데
  자동 입력이 `\r` 을 보내면 그게 승인이 된다.
- **bracketed paste 를 안 쓴다.** 여러 줄 텍스트가 줄마다 제출되거나, 텍스트 안의 특수
  시퀀스가 입력 상태를 바꾼다. 사람이 붙여넣을 때만 `writePasteChunked` 가 bracketed paste
  를 쓴다.
- **큐가 없다.** 두 경로가 동시에 쓰면 바이트가 섞인다.

herdr-core 의 `input.rs` 가 같은 문제를 푼 방식을 따른다: 터미널마다 하나의 큐, 사람이
3 초 조용할 때까지 대기, bracketed paste, Enter 는 따로 200 ms 뒤, blocked 상태면 거부.

## 설계

### 1. 새 모듈 `src/terminal/inputGate.ts`

```ts
export type AutoInputSource =
  | 'ctl' | 'scheduler' | 'telegram' | 'discord' | 'slack'
  | 'devreview' | 'hub' | 'editor' | 'kanban' | 'other';

export interface AutoInputOptions {
  submit?: boolean;        // 기본 true. 텍스트 뒤에 Enter 를 보낸다
  force?: boolean;         // blocked 상태여도 쓴다 (사용자가 직접 누른 버튼 등)
  quietMs?: number;        // 기본 QUIET_MS = 3000
  maxWaitMs?: number;      // 기본 MAX_WAIT_MS = 20000
  source: AutoInputSource;
}

export type AutoInputResult =
  | { ok: true; waitedMs: number }
  | { ok: false; reason: 'blocked' | 'typing' | 'no-writer' | 'disposed' };

export function noteHumanInput(terminalId: string, at?: number): void;
export function isHumanTyping(terminalId: string, quietMs?: number, now?: number): boolean;
export function queueAutoInput(terminalId: string, text: string, opts: AutoInputOptions): Promise<AutoInputResult>;
```

동작 (터미널마다 직렬, 프라미스 체인으로 구현):

1. **쓰기 함수 확보.** `terminalWritersRef`/`terminalStates` 의 `writeToPty` 가 없으면 최대
   7 초(기존 Telegram 재시도 시간과 같음) 기다렸다가 `no-writer` 로 끝낸다.
2. **blocked 검사.** 그 터미널의 7501 상태가 `blocked` 이고 `force` 가 아니면 `blocked`
   로 즉시 끝낸다. 호출자가 사용자에게 "에이전트가 승인을 기다리는 중이라 보내지 않음"
   을 알린다.
3. **조용할 때까지 대기.** 마지막 사람 입력에서 `quietMs` 가 지날 때까지 100 ms 간격으로
   확인한다. `maxWaitMs` 를 넘으면 `typing` 으로 끝낸다. 쓰지 않는다.
4. **본문 쓰기.** xterm 의 `term.modes.bracketedPasteMode` 가 켜져 있으면
   `\x1b[200~` + 본문 + `\x1b[201~` 로 감싼다. 본문 안의 `\x1b[201~` 는 먼저 제거한다.
   4096 자 단위 청크와 서로게이트 보호는 기존 `writePasteChunked` 의 규칙을 그대로 쓴다
   (공통 함수로 뽑는다).
5. **Enter.** `submit` 이면 200 ms 뒤 `\r` 하나를 따로 쓴다. 에이전트 TUI 는 큰 붙여넣기
   뒤 입력창을 다시 그리는 시간이 필요하므로 `terminalSubmitDelayMs(text)` 와 200 ms 중
   큰 값을 쓴다.
6. **사람 키 보류.** 4–5 단계가 진행되는 동안 들어온 사람 키 입력은 보류했다가 끝난 뒤
   순서대로 PTY 에 보낸다. `sendToPty` 가 `inputGate.isWriting(terminalId)` 를 보고
   `inputGate.holdHumanInput(terminalId, data)` 로 넘긴다. 보류 시간은 길어야 1–2 초다.
   `\x03`(Ctrl-C) 은 보류하지 않고 즉시 보낸다. 사용자가 멈추려는 것이기 때문이다.

### 2. 사람 입력 시각 기록

- `src/XTerminal.tsx` 의 `sendToPty` (xterm `onData`/`onBinary` 가 부르는 곳) 에서
  `noteHumanInput(terminalId)` 를 부른다.
- IME 오버레이 입력 경로(`inputValue` 를 `writeToPty` 로 보내는 곳)에서도 부른다.
- 마우스·휠 시퀀스는 기록하지 않는다. 스크롤은 "치는 중" 이 아니다.
- 드롭·붙여넣기는 사람이 한 행동이므로 기록한다.

### 3. 호출 경로 교체

아래는 모두 `queueAutoInput` 으로 바꾼다. 각 경로의 기존 `\r` 타이머와 줄 분할 로직은
제거하고 게이트에 맡긴다.

| 경로 | source | submit | force |
|---|---|---|---|
| `terminal.write` ctl 커맨드 | `ctl` | 커맨드의 `submit` 값 | `false` (`force` 옵션을 커맨드에 추가해 명시할 때만) |
| 스케줄러 | `scheduler` | `true` | `false` |
| Telegram / Discord / Slack 수신 | 각각 | `true` | `false`. 거부되면 같은 채널로 "에이전트가 대기 중이라 보내지 않았습니다" 회신 |
| devreview 릴레이 | `devreview` | `true` | `false`. 거부되면 다음 틱에 재시도 |
| 허브 주입, 에디터 프롬프트, 칸반 전송 | 각각 | `true` | `true` (사용자가 방금 클릭했다) |

Discord·Slack·Telegram 의 `ctrl+c`/`esc`/`enter` 커맨드는 사용자가 명시적으로 보낸 것이므로
게이트를 `submit: false, force: true` 로 통과시킨다. 원격에서 권한 프롬프트에 Enter 로 답하는
경로를 막지 않기 위해서다. (초안에는 "선행 제어문자를 없앤다" 고 썼으나 그런 코드는 없었다.)

단순 버튼 클릭(스킬 실행, 저장된 명령, PM2 뷰어, 페르소나 브리프 등)은 사용자가 그 자리에
있으므로 이번에는 바꾸지 않는다. 다음 단계에서 `force: true` 로 옮길 수 있다.

### 4. 브리지의 Rust 직접 쓰기

`browser_bridge.rs` 가 `write_to_pty` 를 Rust 에서 바로 PTY 로 넘기는 경로는 프런트
게이트를 거치지 않는다. 이번 범위에서는 **바꾸지 않고** 제한으로 적는다. 브리지 클라이언트
(`bbarit-ctl`, `tauri-dev-screen`)는 UI 커맨드 `terminal.write` 를 쓰도록 안내한다.
Rust 쪽 게이트가 필요해지면 `write_to_pty` 에 `origin` 을 추가하는 별도 문서로 다룬다.

### 5. 바꾸지 않는 것

- 사람 키 입력 자체의 지연. 보류는 자동 쓰기 중 1–2 초뿐이다.
- `write_to_pty` Tauri 커맨드 시그니처와 Rust 코드.
- 기존 사람 붙여넣기 `writePasteChunked` 의 동작(공통 함수로 추출만).
- 설정 스키마. `QUIET_MS` 는 상수로 둔다.

## 검증

- `src/terminal/inputGate.test.ts` (가짜 타이머, 가짜 writer):
  - 사람이 1 초 전에 쳤으면 쓰지 않고 기다렸다가 3 초가 지나면 쓴다.
  - 계속 치면 `maxWaitMs` 뒤 `typing` 으로 끝나고 아무것도 쓰지 않는다.
  - blocked 면 `blocked`, `force` 면 쓴다.
  - bracketed 모드에서 `\x1b[200~…\x1b[201~` 로 감싸고 본문 안 `\x1b[201~` 를 제거한다.
  - `submit` 이면 본문과 `\r` 이 두 번의 쓰기로 나뉘고 간격이 200 ms 이상이다.
  - 같은 터미널에 두 요청을 동시에 넣으면 바이트가 섞이지 않고 순서대로 쓴다.
  - 쓰는 동안 들어온 사람 키는 끝난 뒤 순서대로 나가고, `\x03` 은 즉시 나간다.
- `npm run test:run`, `npm run build`, `npm run lint`.
- 실기: Claude 탭에 프롬프트를 치는 도중 `bbarit-ctl` 로 `terminal.write` 를 보내 3 초 뒤에
  들어오는지. 권한 프롬프트가 떠 있을 때 보내면 거부되는지. Telegram 으로 여러 줄을 보냈을
  때 한 번에 붙여넣기 되는지.

## 이후 과제

- 브리지 Rust 경로 게이트(`origin` 필드).
- 버튼 클릭 경로를 `force: true` 로 통일.
- OSC 133 수신 후 "셸 프롬프트에 있을 때만 제출" 같은 더 정확한 상태 기반 제출.

## 구현 메모

구현: `src/terminal/inputGate.ts`, `src/terminal/pasteChunks.ts`(사람 붙여넣기에서 추출, 동작 동일),
테스트 `inputGate.test.ts`, `pasteChunks.test.ts`.

연결 방식:

- writer 해석 순서: XTerminal 이 모듈 로드 시 `setInputGateHost` 로 등록한 호스트(XTerminal 의
  `terminalStates` 의 `writeToPty`) → App 이 `setInputGateFallbackWriter` 로 등록한
  `terminalWritersRef` → 호출자가 넘긴 `fallbackWrite`. 실제 살아 있는 상태 맵은
  `src/terminal/terminalStates.ts` 가 아니라 XTerminal 안의 맵이다(앞 파일은 타입만 쓰인다).
- blocked 상태: XTerminal 이 내보내는 `getTerminalAgentState(terminalId)` (7501 저장소를
  `rollupAgentState` 로 계산, 보고가 없으면 undefined). 상태를 따로 복제하지 않는다.
- 사람 입력: `sendToPty` 의 마지막 PTY 쓰기와 IME 입력 막대·붙여넣기 이벤트·컨텍스트 메뉴
  경로가 모두 `writeHumanInput()` 를 거친다. 마우스(SGR/X10)·포커스 보고·터미널 질의 응답
  (CPR, DA, DECRPM, OSC/DCS)은 "치는 중" 으로 기록하지도 보류하지도 않는다. 그래서
  `\x1b[1;2R` 같은 Shift/Ctrl+F3 키도 CPR 과 바이트가 같아 비입력으로 취급된다(알려진 한계).
  XTerminal 의 마우스·휠 브리지는 `invoke('write_to_pty')` 를 직접 불러 보류를 거치지 않는다.
- 보류 시간: 자동 쓰기의 본문~Enter 동안이다. Enter 지연이 `terminalSubmitDelayMs` 라 약
  8.8K 자 텍스트부터 상한 5 초까지 늘어난다(설계의 "1–2 초" 보다 길 수 있다).
- Ctrl-C: 자동 쓰기 중 사람이 누르면 바로 보내고, 보류한 키를 버리고, 남은 자동 Enter 를
  취소한다(결과 `cancelled`).

설계와 다른 점:

- `AutoInputOptions.fallbackWrite` 추가. ctl 의 팝아웃 터미널, 허브·에디터·칸반·devreview 의
  기존 `invoke('write_to_pty')` 직접 쓰기를 마운트되지 않은 터미널용 마지막 수단으로 남긴다.
  이 경우 blocked/bracketed 정보는 없다.
- 키 입력 판정: 제어 문자·이스케이프 시퀀스로만 된 텍스트나 한 글자(`\x03`, `\x1b`, `\r`, `y`
  등)는 bracketed paste 로 감싸지 않고 그대로 보낸다. 감싸면 키가 아니라 글자로 붙여넣어진다.
  `submit: false`(ctl `write-raw`) 도 바이트 그대로 보낸다 — 안에 든 `\r` 은 예전처럼 제출된다.
- bracketed 모드에서는 본문 줄바꿈을 사람 붙여넣기와 같이 `\r` 로 바꾼다.
- blocked 는 대기 전과 조용해진 뒤 두 번 검사한다. 쓰기 직전과 Enter 직전에 writer 를 다시
  찾고, 없으면 `disposed`.
- `AutoInputOptions.submitDelayMs` 추가. 기본은 설계대로 `max(200, terminalSubmitDelayMs(text))`
  (에이전트 TUI). ctl `terminal.write`, 스케줄러, Telegram/Discord/Slack 은 대상이 일반 셸
  (`!isInteractiveAgentTerminal(cliType)`)이면 200 ms 를 넘긴다.
- **Discord·Slack 의 "선행 `\x03`/`\x1b`" 는 코드에 없었다.** 있던 것은 사용자가 `ctrl+c`/`esc`/
  `enter` 를 명시적으로 보낸 키 명령이다. 지우지 않고 Telegram 의 같은 버튼과 함께 게이트로
  보낸다(`submit: false, force: true`; 원격 승인용 Enter 가 blocked 에 막히면 안 되므로).
  일반 명령은 `submit: true, force: false` 이고 예전 35 ms 뒤 `\r` 타이머는 지웠다.
- Telegram 은 줄마다 80 ms 간격 루프를 지우고 전체 텍스트를 한 번의 붙여넣기로 보낸다.
  거부되면 같은 채팅/채널로 `autoInputRefusalMessage()` 문구를 회신한다.
- devreview: 거부되면 하네스별·터미널별 순서 큐에서 6 초(릴레이 틱) 뒤 다시 시도한다. 대상이
  `blocked` 면 하네스가 멈출 때까지(`stop()` 포함) 횟수 제한 없이 기다리고, `typing`/`no-writer`
  는 20 회에서 포기하며 `emit` + `escalateToHuman` 으로 사람에게 넘긴다(조용히 버리지 않는다).
  첫 시도는 하네스가 멈춘 직후에도 한 번은 나간다(병합 완료 안내). 이 큐 때문에 리뷰 요청이 앞
  메시지의 Enter 뒤로 밀려 기존 테스트 4 개에 3 초 대기를 더했다. 추가 CR(1.5/3.5/6 초)은
  Kimi 에게만 보내고, 릴레이 Enter 뒤에 사람이 입력했으면 건너뛴다.
- 스케줄러는 동기 반환이라 "실행" 알림은 큐에 넣은 시점에 나간다. 거부되면 실패 알림을 한 번 더 낸다.
- 에디터 프롬프트는 예전에 `\r` 두 번(500 ms, 800 ms)을 보냈다. 이제 한 번이다.
- ctl 응답은 게이트 결과를 기다린다. 앞 요청 대기 + 최대 20 초 + 제출 지연이 브리지 UI 커맨드
  타임아웃(30 초, `agent_gateway.rs`)을 넘을 수 있다. `bbarit-ctl term write` 의 응답 타임아웃은
  그보다 긴 40 초가 기본이다(`--timeout` 으로 바꿀 수 있다). 브리지가 30 초에 먼저 끊으면 ctl 은
  타임아웃 오류를 받지만 쓰기는 앱에서 계속 진행된다. `--force` 는 `force: true` 로 넘어간다.
- 칸반 → 콘솔: 예전 `prompt + '\n'` 은 Claude 에서 줄바꿈만 넣고 제출하지 않았다. 이제 게이트가
  Enter 를 따로 보내 자동 제출된다.

이번에 바꾸지 않은 쓰기(다음 단계에서 `force: true` 로 옮길 후보):

- XTerminal: 스킬 가로채기의 `\x15`, `/clear` 단축(`\x15/clear\r`), 입력 지우기(`\x05\x15`),
  시작 명령·재시도·tmux 자동 시작, SSH 수정 재주입, DSR/7501 응답.
- App: 스킬 실행, 저장된 명령/프롬프트 라이브러리, PM2 뷰어, 페르소나 브리프, 어시스트 바,
  Scrum/Harness 페이지, 노트 모달 등 버튼 클릭 경로(`terminalWritersRef.current[...]` 직접 호출).

알려진 제한: 브리지 HTTP `write_to_pty`(`src-tauri/src/browser_bridge.rs`)는 Rust 에서 PTY 로
바로 써서 게이트를 거치지 않는다. Rust 코드는 바꾸지 않았다(4 절).
