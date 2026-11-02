# OSC 133 셸 통합: 프롬프트 복귀 감지

작성일 2026-11-03. 상태: 구현됨 ([CLAUDE_SESSION_HOOK.md](CLAUDE_SESSION_HOOK.md) 와 같은 PR). 실기 확인 전.

## 배경

OSC 7501 상태([AGENT_STATUS_OSC7501.md](AGENT_STATUS_OSC7501.md))는 에이전트가 죽거나
사용자가 Ctrl-C 로 끊으면 `working`/`blocked` 가 남는다. 지금은 10 분 무응답 폴백뿐이다.
Program Status 스펙은 "프로세스 종료나 **OSC 133 `A`**(새 프롬프트 시작)를 받으면 터미널은
`working`/`blocked` 를 버려야 한다" 고 한다. 셸 통합(OSC 133)을 받으면 에이전트가 끝나고 셸
프롬프트로 돌아온 순간 상태가 정리된다.

OSC 133 은 셸이 보내야 한다. zsh/bash/fish 는 기본으로 안 보내고, Ghostty·iTerm2·WezTerm
식 셸 통합 스크립트가 있어야 한다. 이번에는 **수신만** 구현한다. 셸 통합 주입은 하지 않는다.

## 설계

- `src/terminal/shellIntegration.ts` (순수): `parseOsc133(data)` → `{ mark: 'A'|'B'|'C'|'D',
  exitCode?: number }` 또는 null. `D;<n>` 의 n 은 0–255 정수만.
- `src/XTerminal.tsx`: OSC 52·7501 옆에 `registerOscHandler(133, ...)`.
  - `A`(프롬프트 시작): 7501 저장소의 `working`/`blocked` 루트·자식 레코드를 지운다
    (`done`/`error`/`idle` 은 남긴다. 스펙). 상태가 바뀌면 기존 `octo-agent-status` 이벤트로
    App 에 알린다. 알림은 내지 않는다(`firstReport` 와 같은 취급).
  - `C`(명령 실행 시작)/`D`(명령 끝): 기록만 한다. `terminalStates` 에 `lastPromptAt`,
    `lastCommandExitCode` 를 둔다. 표시는 이번 범위 밖이다.
  - `B` 는 무시.
- 입력 게이트: `queueAutoInput` 의 blocked 검사는 그대로. 추가로 `A` 를 받은 뒤
  `C` 가 아직 없는 터미널(프롬프트에 있음)은 "사람이 치는 중" 판정에 영향을 주지 않는다.
  바꾸지 않는다.
- 저장 출력 재생(`replayingOutput`) 중에는 133 도 상태만 갱신하고 이벤트·알림은 내지 않는다.

## 바꾸지 않는 것

- 셸 rc 파일, PTY 환경. 사용자가 셸 통합을 켠 경우에만 동작한다.
- 7501 의 10 분 폴백. 133 이 없는 셸에서는 여전히 그 폴백이 일한다.

## 검증

- `shellIntegration.test.ts`: `A`, `B`, `C`, `D;0`, `D;130`, `D;abc`(null), 빈 문자열.
- `programStatusHandler.test.ts` 에 "working 중 133 A → idle(레코드 제거), done 은 유지,
  재생 중엔 이벤트 없음" 추가.
- 실기(macOS): 셸 탭에서 `printf '\033]7501;state=working:app=x\007'` 로 working 을 만든 뒤
  `printf '\033]133;A\007'` 를 치면 탭 점이 idle 로 돌아오는지.

## 구현 메모

설계와 다르거나 설계가 정하지 않은 부분만 적는다.

- **위치**: 수신 로직은 `handleShellIntegrationOsc`(`src/terminal/programStatusHandler.ts`)에 두고
  XTerminal 은 `registerOscHandler(133)` 에서 그것만 부른다. 7501 과 같은 저장소를 만지기 때문이다.
- **재생 중 이벤트**: 설계는 "재생 중엔 이벤트 없음" 이었지만 상태 이벤트는 낸다(알림은 없음,
  `firstReport: true`). 재생된 7501 보고는 이미 이벤트를 내므로, 재생된 `A` 가 이벤트를 안 내면
  App 의 표시가 `working` 으로 남고, 저장소는 이미 idle 이라 10 분 폴백도 이를 고치지 못한다.
- **이벤트 조건**: `A` 는 7501 보고를 받은 적 있는 터미널에서만, 롤업 상태가 실제로 바뀔 때만
  이벤트를 낸다. 알림 처리기(`programStatusHandlers`)를 거치지 않고 `dispatchAgentStatus` 로 바로
  보내 알림 판단 자체를 건너뛴다. `reported` 는 그대로 둔다(기존 완료 토스트로 돌아가지 않는다).
- **필드 이름**: `lastPromptAt`, `lastCommandExitCode`(D 에 코드가 없으면 `null`) 외에 `C` 시각을
  `lastCommandStartAt` 으로 남긴다.
- **옵션 필드**: `A;cl=m;aid=…` 처럼 표식 뒤의 옵션은 무시한다. `D;1;aid=…` 는 두 번째 필드만
  종료 코드로 본다. 소문자 표식과 1024 자 넘는 페이로드는 버린다.
- 실기 확인(macOS)은 하지 않았다. 단위 테스트, `npm run build`, `npm run lint` 만 통과.
