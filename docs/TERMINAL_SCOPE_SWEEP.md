# 탭 종료 시 스코프 토큰 스윕

작성일 2026-11-03. 상태: 설계 확정, 구현 중. 같은 PR 에서 입력 게이트의 버튼 클릭 경로
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
- `create_shell` 과 `create_cli_shell` **둘 다**에서 `cmd.env(...)` 로 심는다(두 곳에서 PTY
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
