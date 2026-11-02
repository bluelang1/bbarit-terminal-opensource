# 탭 종료 시 스코프 토큰 스윕

작성일 2026-11-03. 상태: 구현됨(아래 "구현 메모"). 같은 PR 에서 입력 게이트의 버튼 클릭 경로
정리([AGENT_INPUT_GATE.md](AGENT_INPUT_GATE.md) "이후 과제")도 함께 한다.

## 배경

탭을 닫으면 `close_pty`(`src-tauri/src/main.rs`)가 `kill_process_tree(pid)` 로 셸의 자손을
죽이고 셸을 kill 한다. 프로세스 **트리**를 따라가므로, 트리에서 빠져나간 프로세스는 남는다.

- 에이전트가 `setsid`/`nohup`/`&` + `disown` 으로 띄운 개발 서버, 워처, 브라우저 드라이버.
- 부모가 먼저 죽어 launchd(1) 로 재부모화된 자식.
- tmux 안에서 띄운 것(tmux 서버는 별도 세션).

결과로 포트를 잡은 좀비 서버가 남고, 다음 탭에서 "포트 사용 중" 이 난다.

herdr-core 의 `sweep.rs` 와 같은 방식으로 푼다. 터미널마다 고유 토큰을 환경변수로 심고,
닫을 때 그 토큰을 가진 프로세스를 전부 찾아 죽인다. 환경변수는 자식에게 상속되므로
트리를 벗어나도 남는다.

## 설계

### 1. 토큰

- 이름 `BBARIT_TERM_SCOPE`, 값 `<unix_ms>-<random 8 hex>`. 예 `1793700000000-9f3a1c2e`.
- 당시에는 `create_shell` 과 `create_cli_shell` **둘 다**에서 `cmd.env(...)` 로 심었다(지금은 `pty_backend::build_shell_command` 한 곳. 두 곳에서 PTY
  환경을 따로 만든다. CLAUDE.md 참고).
- `PtyInstance` 에 `scope_token: String` 을 보관한다.
- 토큰 생성·검증은 순수 함수로 두고 단위 테스트한다: `new_scope_token()`,
  `scope_token_matches(environ_entry, token)` (정확히 `BBARIT_TERM_SCOPE=<token>` 일 때만 참).

### 2. 스윕

- `sweep_scope(token: &str, skip: &[u32])`: `sysinfo` 로 전체 프로세스를 훑어
  `process.environ()` 에 `BBARIT_TERM_SCOPE=<token>` 이 있는 프로세스를 모은다. 자기 자신
  (`std::process::id()`)과 `skip` 은 제외한다.
- 모인 프로세스에 먼저 SIGTERM, 300 ms 뒤 살아 있으면 SIGKILL (Windows 는 `kill()` 한 번).
  기존 `kill_process_tree` 의 플랫폼 처리를 재사용한다.
- 토큰의 타임스탬프보다 **먼저 시작된** 프로세스는 건너뛴다(`process.start_time()` 비교).
  환경을 통째로 복사해 간 무관한 프로세스를 잘못 죽이지 않기 위한 안전장치다.
- 한 번의 스윕에서 죽인 pid 수를 `log::info!` 로 남긴다.

### 3. 호출 시점

- `close_pty`: 기존 `kill_process_tree(pid)` → `child.kill()` 뒤에 `sweep_scope(token)` 을
  같은 백그라운드 스레드에서 한다. 스윕은 전체 프로세스 목록을 읽으므로 메인 스레드에서
  하지 않는다.
- 앱 종료(`RunEvent::Exit`): 열려 있는 모든 PTY 의 토큰으로 한 번씩 스윕한다. 기존
  `agent_rpc_stop_all()` 옆에 둔다. 시간이 오래 걸리면 안 되므로 전체 2 초 상한을 둔다.
- 터미널 재시작(같은 terminalId 로 PTY 를 다시 만드는 경우)은 새 토큰을 받는다. 이전
  토큰은 `close_pty` 가 이미 스윕했다.

### 4. 바꾸지 않는 것

- `kill_process_tree` 자체. 스윕은 그 뒤에 더해지는 안전망이다.
- 사용자가 의도적으로 남긴 데몬. 그런 용도는 `env -u BBARIT_TERM_SCOPE` 로 토큰을 빼고
  띄우면 된다. 이 탈출구를 `docs/BBARIT_CLI.md` 와 이 문서에 적는다.
- 브로커/devreview 워크트리 정리(`git_cleanup_broker_worktrees`)와는 무관하다.

### 5. 플랫폼

- macOS/Linux: `sysinfo` 의 `environ()` 은 같은 사용자 프로세스에서 동작한다. 다른
  사용자(sudo 로 띄운 것)는 읽히지 않으며 건너뛴다.
- macOS 실측(macOS 27.0.1): 커널이 Apple 플랫폼 바이너리(`/bin/sh`, `/bin/zsh`, `/bin/sleep` 등)의
  환경 변수를 다른 프로세스에 보여 주지 않는다. 그래서 스윕은 node, python(python.org/Homebrew),
  Homebrew 도구 같은 비플랫폼 바이너리는 잡지만 `/bin/sleep` 같은 시스템 바이너리는 못 잡는다.
  실제 대상은 개발 서버·워처·브라우저 드라이버라 받아들인다(구현 메모 참고).
- Windows: `sysinfo` 가 환경을 읽지 못하는 프로세스가 있다. 읽히는 것만 처리하고, 실패는
  조용히 무시한다. 실기 검증은 하지 않았다.

## 버튼 클릭 쓰기 경로 정리 (입력 게이트 후속)

[AGENT_INPUT_GATE.md](AGENT_INPUT_GATE.md) 구현 메모에 남겨 둔 "사용자가 그 자리에서 누른
버튼" 경로를 모두 `queueAutoInput(..., { source: 'button', submit, force: true })` 로 옮긴다.
사용자가 방금 클릭했으므로 blocked 검사와 3 초 대기는 건너뛰지만(`force`), 직렬 큐,
bracketed paste, Enter 분리, 사람 키 보류는 적용된다. 그래야 같은 터미널에 두 버튼을 연달아
눌러도 바이트가 섞이지 않는다.

대상: `src/App.tsx` 의 직접 `invoke('write_to_pty')` 호출(프롬프트 라이브러리, 스킬 실행,
저장된 명령, PAKE 패널 등), `src/pages/HarnessPage.tsx`, `src/pages/ScrumPage.tsx`,
`src/notes/GenerateNoteModal.tsx`, `src/components/TerminalPersonaButton.tsx`,
`src/components/TerminalAssistBar.tsx`, `src/pm2/Pm2LogViewer.tsx`.

- `AutoInputSource` 에 `'button'` 을 추가한다.
- 텍스트 뒤에 직접 `\n` 이나 `\r` 을 붙이던 호출은 그 접미사를 떼고 `submit: true` 로 바꾼다.
  `\n` 만 붙이던 곳은 에이전트 TUI 에서 제출되지 않던 동작이 제출로 바뀌므로 구현 메모에
  적는다.
- 사용자 붙여넣기(`writePasteChunked`)와 드롭, 터미널 쿼리 응답(`\x1b[..R`)은 자동 입력이
  아니므로 그대로 둔다.
- 이 정리가 끝나면 `write_to_pty` 를 직접 부르는 프런트 코드는 `inputGate.ts`,
  `XTerminal.tsx` 의 사람 입력 경로, 터미널 쿼리 응답뿐이어야 한다. `grep -rn "write_to_pty" src/`
  로 확인한다.

## 검증

- Rust: `cargo test --manifest-path src-tauri/Cargo.toml --locked` 에 토큰 생성·검증,
  `environ` 항목 매칭(접두 일치 거부, 정확 일치만) 테스트 추가. 가능하면 실제 자식
  프로세스(`sh -c 'sleep 30'`, 토큰 env 설정)를 띄워 `sweep_scope` 가 죽이는지 확인하는
  통합 테스트 1 개(`#[cfg(unix)]`).
- 프런트: `npm run test:run`, `npm run build`, `npm run lint`,
  `python3 -B scripts/export-opensource.py --audit`.
- 실기(macOS, 개발 빌드): 셸 탭에서 `setsid sleep 600 &` 와 `nohup python3 -m http.server 18099 &`
  를 띄운 뒤 탭을 닫고 `pgrep -f "sleep 600"`, `lsof -i :18099` 가 비는지 확인한다.
  `env -u BBARIT_TERM_SCOPE setsid sleep 600 &` 로 띄운 것은 남아야 한다.

## 구현 메모

### 스윕 (`src-tauri/src/main.rs`)

- 토큰은 `create_shell`·`create_cli_shell` 의 `PAGER`/`GH_PAGER` 바로 뒤에서 `cmd.env` 로 심고
  `PtyInstance.scope_token` 에 둔다. 순수 함수는 `new_scope_token`, `parse_scope_token_ms`,
  `scope_env_matches` 다. 설계의 `scope_token_matches` 대신 `scope_env_matches(entry, token)` 이라는
  이름을 썼다.
- `sweep_scope(token, skip)` 는 `sweep_scopes(&[token], skip)` 의 얇은 래퍼다. 공유
  `sysinfo_system()` 대신 매번 새 `System` 을 만들어 `ProcessRefreshKind::nothing().with_environ(Always)`
  로 한 번 훑는다(다른 코드가 쓰는 공유 락을 오래 잡지 않고, 캐시된 environ 을 믿지 않기 위해).
- 형식이 틀린 토큰(빈 문자열 포함)은 아무것도 죽이지 않는다. `BBARIT_TERM_SCOPE=` 만 있는 항목이
  빈 토큰에 걸리는 것을 막는다.
- 시작 시각 비교는 `scope_start_ok(start_secs, token_secs)`(`start_secs + 2 >= token_secs`)다.
  `sysinfo` 의 `start_time()` 은 초 단위로 내림(Linux 는 btime + ticks/hz)이라 토큰과 같은 초에
  시작한 프로세스가 1 초 이르게 읽힐 수 있어 2 초 여유를 둔다. 그보다 먼저 시작한 것만 건너뛴다.
- Linux 의 스레드 항목(`process.thread_kind().is_some()`)은 건너뛴다. 프로세스에만 신호를 보낸다.
- **상주 데몬 제외 목록**(`SCOPE_SWEEP_EXCLUDES`, `scope_sweep_excluded`): 탭에서 한 번 띄워 계속
  쓰는 데몬은 토큰이 있어도 죽이지 않는다. `tmux`, `PM2`/`pm2`, `Electron`, `Code`, `Code Helper`,
  `colima`, `limactl`, `qemu-system*`, `gpg-agent`, `ssh-agent`, `docker`, `com.docker.*`, `ollama`.
  대소문자를 무시하고 프로세스 이름, exe 파일 이름, argv[0](및 그 파일 이름)에 맞춘다. `*` 로 끝나면
  접두 일치, 아니면 이름 전체가 같거나 이름 뒤에 공백이 이어질 때 일치한다. argv[0] 과 "뒤에 공백"
  규칙은 리뷰 지시(이름·exe)에 더한 것이다: PM2 God 데몬은 exe 가 `node` 이고 제목을
  `PM2 v5.3.0: God Daemon (...)` 으로 바꾸며, VS Code 헬퍼는 `Code Helper (Renderer)` 같은 이름이다.
  목록에 없는 데몬은 `env -u BBARIT_TERM_SCOPE <명령>` 으로 띄우면 스윕되지 않는다.
- 신호는 `kill_process_tree` 처럼 `kill` 명령을 띄우지 않고 `libc::kill` 을 직접 부른다(SIGTERM →
  300 ms → `kill(pid, 0)` 로 살아 있으면 SIGKILL). Windows 는 `sysinfo` 의 `Process::kill()` 한 번.
- 로그는 이 파일의 관례대로 `safe_eprintln!("[scope-sweep] ...")` 다(`log` 크레이트는 의존성에 없다).
- 앱 종료: `sweep_all_scopes_on_exit` 가 열린 PTY 토큰을 모아 **한 번의** 프로세스 훑기로 처리하고,
  별도 스레드 + `recv_timeout(2 s)` 로 상한을 둔다. 이때는 셸 자신도 토큰을 가지므로 함께 정리된다.
- **macOS 한계(실측, macOS 27.0.1):** 커널이 Apple 플랫폼 바이너리(`/bin/sh`, `/bin/zsh`,
  `/bin/sleep` 등)의 환경 변수를 다른 프로세스에 보여 주지 않는다(`KERN_PROCARGS2` 가 인자만 준다).
  그래서 macOS 에서는 `nohup sleep 600 &` 같은 시스템 바이너리는 스윕되지 않는다. node, python.org/
  Homebrew python, cargo 로 빌드한 바이너리 등 비플랫폼 바이너리는 보이며 스윕된다(개발 서버·
  워처·브라우저 드라이버가 주 대상이라 목적은 지킨다). 그래서 실기 검증은 `sleep` 대신
  `nohup python3 -m http.server 18099 &`(비플랫폼 python) 로 해야 한다. 셸 자체는 원래대로
  `kill_process_tree` 가 정리한다.
- 통합 테스트의 희생 프로세스는 Drop 에서 kill 하는 가드로 감싸 단언이 실패해도 30 초짜리가 남지 않는다.
- 통합 테스트(`sweep_scope_kills_detached_child_with_token`)는 같은 이유로 `sh -c 'sleep 30'` 대신
  테스트 바이너리 자신(`scope_sweep_sleeper` 테스트, 환경 변수가 있을 때만 30 초 대기)을 희생자로
  띄우고, 다른 토큰을 가진 프로세스는 살아 있는지도 확인한다.
- **tmux 자동 시작(결정됨):** `tmuxAutoStart` 는 앱이 꺼져도 세션이 살아남게 하려고 있으므로 tmux
  서버가 토큰을 물려받으면 안 된다(물려받으면 서버를 처음 띄운 탭을 닫거나 앱을 끌 때 서버와 **모든**
  세션이 스윕된다). XTerminal 의 자동 시작 명령을 `src/terminal/tmuxAutoStart.ts` 의
  `tmuxAutoStartCommand(session)` 로 만들고, unix 에서는 `env -u BBARIT_TERM_SCOPE tmux new-session -A -s <session>`
  로 띄운다(Windows 는 그대로). 서버가 이미 앞 탭에서 떠 있으면 그 서버에 붙을 뿐이라 따로 할 일이 없다.
  tmux 세션 안에서 띄운 프로세스도 토큰이 없으므로 탭 스윕 대상이 아니다(세션과 함께 유지된다).
  사용자가 직접 친 `tmux` 는 여전히 토큰을 물려받는다.
- 사람의 실기 검증(탭 닫기 후 `lsof -i :18099` 가 비는지, `env -u` 로 띄운 것은 남는지)은 하지 않았다.

### 버튼 클릭 경로

- 공통 함수 `src/terminal/buttonInput.ts` 의 `queueButtonInput(terminalId, text, { submit, submitDelayMs? })`
  를 추가했다. `queueAutoInput(..., { source: 'button', submit, force: true, quietMs: 0 })` 에
  `fallbackWrite`(직접 `write_to_pty`)를 붙인다. 설계대로 "3 초 대기도 건너뛰기" 위해 `quietMs: 0`
  을 넘긴다(게이트의 `force` 는 blocked 검사만 건너뛴다). 별도 창(Scrum/Harness 페이지, 노트
  모달이 띄운 리서치 창)과 팝아웃 터미널에는 이 창의 writer 가 없으므로 fallback 이 필요하다. 직접
  쓰기가 실패하면(PTY 없음) 결과가 `no-writer` 다. 본문 직접 쓰기가 거부되면 다음 fallback 호출이
  던져 게이트가 `disposed` 로 끝나므로 따로 보내는 Enter 는 나가지 않는다(빈 입력창에 Enter 만 들어가지
  않게). 프롬프트 라이브러리는 이 `no-writer` 를 보고 명령을 남겨 두었다가 다시 보낸다.
- 셸이 대상인 곳은 `submitDelayMs: MIN_SUBMIT_DELAY_MS`(App 은 `gateSubmitDelayFor(cliType)`)로
  Enter 지연을 200 ms 로 둔다. 대상 cliType 을 모르는 곳(프롬프트 라이브러리, Harness 페이지의
  기존 터미널)은 기본값(에이전트 TUI 기준, 최소 1.2 초)이다.
- 프롬프트 라이브러리: 대기 명령은 `no-writer` 면 남겨 두고 onReady/1.5 초 타이머가 다시 보낸다
  (예전의 "invoke 실패 시 보류" 와 같다). 타이머와 onReady 가 겹쳐 두 번 보내지 않도록 터미널별
  진행 중 표시를 둔다.
- Scrum 페이지·노트 모달의 `writeAndSubmit` 은 예전 간격(본문 → 500 ms → Enter → 300 ms → Enter)을
  지킨다. 첫 Enter 는 게이트(`submitDelayMs: 500`), 두 번째는 300 ms 뒤 `'\r'` 을 `submit: false` 로 보낸다.
- 화면 캡처 경로 붙여넣기, 페르소나 브리프, 어시스트 바, 음성 입력(자동 Enter 꺼짐)은 `submit: false`
  라 바이트 그대로 쓴다(예전과 같음).
- **`\n` 이 실제 제출로 바뀐 곳**(예전엔 Claude 같은 에이전트 TUI 에서 줄바꿈만 들어가고 제출되지
  않았다. 셸에서는 같다): 프롬프트 라이브러리 전송, 스킬 우클릭 실행·명령 선택기의 writer 미마운트
  경로, 사이드바·스킬 상세의 셸 스킬 실행, PAKE 빌드, 빠른 명령 버튼, Harness 페이지의 콘솔 전송.
  PM2 뷰어와 Scrum `startCli` 는 셸 대상이라 체감 변화가 없다. 음성 입력은 원래 `\r` 이었다.
- 바꾸지 않은 것: XTerminal 의 사람 입력·마우스/휠 브리지·쿼리 응답, `terminalStates.ts` 의 쿼리
  응답, 앞 단계(입력 게이트)에서 이미 게이트를 타는 경로의 `fallbackWrite`(App.tsx, devReviewPair.ts).
  XTerminal 내부의 스킬 가로채기 `\x15`, `/clear` 단축, 시작 명령·tmux 자동 시작은 이번 대상 목록에
  없어 그대로 두었다.
