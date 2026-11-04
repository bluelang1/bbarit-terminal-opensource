# PTY 홀더 데몬: 앱을 꺼도 터미널이 살아 있게

작성일 2026-11-03. 상태: **설계 2판(코드 대조 리뷰 반영). 0·1단계 완료, 2a(홀더·프로토콜·`HolderBackend`, Rust) 완료, 2b(프런트 재부착·agentLinks·종료 UX) 구현(실기 확인 전). 3a(launchd/systemd-run 분리 spawn, 홀더 SIGTERM 정리, Rust) 구현.** 결정 필요 항목은 맨 끝에 있다.

## 1. 문제

빠릿은 PTY 를 앱 프로세스(Rust 호스트)가 직접 쥔다. `AppState.ptys` 의 `PtyInstance` 가
`master`, `child`, `writer`, 읽기 스레드를 모두 가진다(`src-tauri/src/main.rs:130-147`).
그래서

- 앱을 종료하거나, 크래시하거나, **업데이트로 재시작하면** 모든 탭의 셸과 그 안의 에이전트가
  같이 죽는다. 재시작 뒤 보이는 "이어서" 는 Claude 대화 기록(`--resume`)을 다시 여는 것이지
  멈췄던 작업이 돌고 있던 게 아니다.
- 길게 도는 에이전트 작업(리뷰·테스트·마이그레이션)을 걸어 두고 앱을 닫을 수 없다.

herdr-core 는 이 문제를 "터미널은 작은 데몬(holder)이 쥐고, 앱은 클라이언트" 로 푼다. 같은
방향으로 가되, 빠릿의 프런트(`XTerminal.tsx` 의 pull 방식 읽기 루프)와 기존 Tauri 커맨드
인터페이스는 **그대로 두는** 것을 원칙으로 한다. 프런트가 모르는 사이 뒤에서 PTY 소유자만
바뀐다.

목표가 아닌 것(이번 설계 범위 밖):

- 재부팅 뒤 생존. herdr 도 못 한다. 재부팅 뒤에는 "같은 폴더에 새 셸" 로 복구한다.
- 원격 머신의 터미널. `web_terminal.rs` 의 웹 터미널 PTY 도 1차 범위 밖이다.
- Windows. ConPTY + 명명 파이프 + 잡 오브젝트가 필요해 4단계로 미룬다. 그때까지 Windows 는
  지금처럼 앱 내부 PTY 를 쓴다.

## 2. 오늘의 배선 (바꾸기 전 사실)

| 구성 | 위치 | 비고 |
|---|---|---|
| PTY 생성 | `create_shell`(`main.rs:3361`), `create_cli_shell`(`:4928`) | `portable-pty 0.8`. `CommandBuilder` 는 **앱 환경을 상속**하고 거기서 `env_remove` 로 지우는 방식(`:3446-3450`). 두 함수에 중복. `create_cli_shell` 은 프런트 호출자가 없다 |
| 읽기 | `spawn_utf8_reader_thread`(`:2686`) → `sync_channel(1024)` + `output_buffer`(768 KiB, 앞 절반 버림). 리더는 **절대 막히지 않고** 큐가 차면 버린다(`:2741-2751`). UTF-8 이어붙이기는 리더 안(`:2756-2780`) | `read_from_pty` 가 **pull** 로 64 KiB 씩 비움(`:3616`). main.rs 는 PTY 이벤트를 안 보냄(XTerminal 의 `pty-data-*` 리스너는 죽은 코드 대비 폴백) |
| 쓰기·크기 | `write_to_pty`(`:3596`), `resize_pty`(`:3648`) | |
| 종료 | `close_pty`(`:4237`): `kill_process_tree` → `child.kill` → `sweep_scope` | `RunEvent::Exit`(`:10826`)에서 `sweep_all_scopes_on_exit`(`:4045`). 비-macOS `CloseRequested`(`:10386-10405`)는 전체 트리 kill. 하네스 창은 pagehide 에서 PTY 를 닫음(`App.tsx:14614`) |
| 생존·복원 | `check_pty_alive`, `read_pty_output_buffer`, `pty_idle_ms`(`:8174-8200`) | 프런트 `restoredPty.ts` 가 팝아웃 재부착에 사용, `replayingOutput` 로 재생 |
| 프런트 루프 | `XTerminal.tsx:1025` `startReadLoop`, 33 ms 폴링, "PTY disconnected" 로 종료 감지 | |
| 영속 | `App.tsx:1836-1861` 터미널 id·cliType·lastWorkDir·claudeSessionId 등 | `startupCommand` 는 저장 안 함(런타임 파생) |
| 앱 시작 | 탭 마운트 시 `create_shell` + 시작 명령 주입(`XTerminal.tsx:3724-3870`). 비활성 복원 탭은 `deferStart` | |
| 업데이트 | `App.tsx:10306` `downloadAndInstall()` → `relaunch()`. 실행 중 탭 경고 없음 | |
| IPC | 전부 localhost TCP/HTTP/WS. 유닉스 소켓 없음 | `--mode rpc` 자식은 같은 exe + `BBARIT_AGENT_MODE=1` |

## 3. 목표 구조

```
┌──────────── BBARIT app (Tauri) ────────────┐      ┌──── pty-holder (같은 exe, --mode pty-holder) ────┐
│ XTerminal 읽기 루프 ──invoke──▶ PtyBackend │      │  터미널마다: openpty, 자식 spawn,               │
│   (create/read/write/resize/close/alive)   │◀────▶│  pump(읽기)·reap(종료 대기)·writer 스레드,       │
│ Holder 백엔드: 소켓 연결 1개, 터미널별 큐  │ unix │  1 MiB tail 링, 스코프 스윕                      │
│ InProcess 백엔드: 오늘 코드 (폴백)         │ sock │  정책 없음, 파싱 없음                            │
└────────────────────────────────────────────┘      └──────────────────────────────────────────────────┘
```

- **홀더는 멍청하다.** 셸을 띄우고, 바이트를 양방향으로 나르고, 꼬리(tail)를 보관하고,
  죽이고, 거둔다. 환경 구성·시작 명령·7501 파싱·알림은 전부 앱에 남는다.
- **앱은 클라이언트다.** 앱이 없어도 홀더는 계속 읽는다(프로그램이 멈추지 않게). 앱이 다시
  붙으면 WELCOME 으로 터미널 목록을, TAIL 로 마지막 1 MiB 를 받아 화면을 다시 그린다.
- **프런트 인터페이스는 그대로.** `create_shell` 등 Tauri 커맨드의 이름과 페이로드를 유지하고
  구현만 `PtyBackend` 트레이트 뒤로 넣는다. `XTerminal.tsx` 의 변경은 "이미 살아 있는
  터미널에는 시작 명령을 다시 넣지 않는다" 한 가지 판단뿐이다.

### 3.1 프로세스와 수명

- 바이너리: 같은 exe 를 `--mode pty-holder --socket <path>` 로 띄운다. `BBARIT_AGENT_MODE`
  게이트(`main.rs:10238`)와 같은 자리에서 분기한다. 별도 번들 산출물·서명이 늘지 않는다.
- 띄우는 쪽: 앱. 소켓 디렉터리에 살아 있는 홀더 소켓이 없을 때만 새로 띄운다.
  - macOS: `launchctl bootstrap gui/<uid>` 로 **일회성 launchd 잡**(`RunAtLoad=true`,
    `KeepAlive=false`, `AbandonProcessGroup=true`, 레이블 `com.bbarit.terminal.pty-holder.<instance>`).
    herdr 가 확인한 대로 `setsid` 만으로는 앱의 coalition 에 남아, 앱 종료·업데이트 재시작 때
    함께 정리될 수 있다. launchd 실패 시 `setsid` + 분리 spawn 으로 폴백한다. 세부(herdr
    `macos_launchd.rs` 에서 배운 것):
    - 레이블은 **실행마다 고유**(pid+시각). `KeepAlive=false` 잡도 끝난 뒤 로드된 채 남아,
      고정 레이블이면 다음 `bootstrap` 이 실패한다.
    - 낡은 잡 정리는 `launchctl list` 에서 PID 칸이 `-` 인 것만 `bootout` 한다. 살아 있는 홀더를
      bootout 하면 그 안의 모든 터미널이 SIGHUP 을 받는다.
    - `ProcessType=Interactive` 로 백그라운드 스로틀을 피한다.
    - launchd 는 앱 환경·rlimit 을 물려주지 않으므로 필요한 값은 HELLO/SPAWN 으로 넘긴다.
  - Linux: `systemd-run --user --collect --service-type=exec -p KillMode=process`. 실패 시
    `setsid` 폴백.
  - 홀더는 자기 pid 와 소켓 경로를 `<run>/pty-holder.<instance>.json` 에 쓴다.
- 홀더 종료 조건: 터미널이 하나도 없고 클라이언트도 없이 60 초가 지나면 스스로 끝난다.
  DRAIN 을 받으면 새 터미널을 거부하고 마지막 터미널이 끝날 때 종료한다.
- 홀더가 죽으면 그 안의 터미널은 죽는다(홀더가 부모다). 앱은 다음 연결에서 사라진 터미널을
  `holder_lost` 로 표시하고 "같은 폴더에서 다시 시작" 을 제안한다(기존 재시작 경로).
- 재부팅 뒤도 같다. 저장된 프로젝트의 터미널은 지금처럼 다시 만든다.
- **설정(3b)**: `terminal.ptyHolder` 는 릴리스 빌드에서 **기본 `on`** 이다(미설정 = on, `"off"` 만 끈다). 디버그 빌드는
  `keepRunningOnQuit` 와 같은 규칙으로 명시적 `"on"` 일 때만 쓴다(`pty_backend::pty_holder_wanted`, TS `effectivePtyHolder`).
  설정 화면의 "PTY 홀더 사용" 체크박스가 `"on"/"off"` 를 쓰고, 설명 줄에 지금 백엔드(종류 · spawnMethod · 폴백 이유)를
  보인다. 릴리스 빌드에서 홀더에 처음 붙으면 한 번만 안내 토스트("앱을 닫아도 터미널은 계속 실행됩니다 …")를 띄운다
  (KV `octo-pty-holder-intro-notice`). launchd/systemd 대신 setsid 로 띄웠으면 그 이유를 토스트로 보인다.

구현 메모: 3a(Rust) — `pty_holder/spawn.rs`(`spawn_holder_with`, `launchd`·`systemd` 하위 모듈, `describe`),
`server.rs`(SIGTERM/SIGINT), `proto.rs`(`HolderInfo` 필드), `pty_backend.rs`(`info()`). 위 계획과 다르게 간 점:
- **macOS launchd**: plist 는 `<run>/<prefix>.<instance>.plist`(0600), 레이블은 `com.bbarit.terminal.<prefix>.<instance>`
  (릴리스 `com.bbarit.terminal.pty-holder.<8hex>`, 개발 `….pty-holder.dev.<8hex>`. instance 는 spawn 마다 새 난수라
  레이블도 spawn 마다 고유하다). `ProgramArguments` = exe + `--mode pty-holder --socket <path> --spawn-method launchd
  --job <label>`. 뒤 두 쌍은 홀더가 정보 파일에 `spawnMethod`/`label` 을 쓰게 하려고 더했다. 그 밖의 키는 `RunAtLoad`,
  `KeepAlive=false`, `AbandonProcessGroup`, `ProcessType=Interactive`, `WorkingDirectory=/`, stdin/stdout `/dev/null`,
  `StandardErrorPath`=기존 홀더 로그다. env 는 `HOME`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, 그리고 앱에 있을 때만
  `BBARIT_PTY_HOLDER_IDLE_EXIT_MS` 를 넣는다. rlimit 은 넘기지 않는다(launchd 기본값).
  launchd 홀더는 `getsid == 1`(launchd 세션)이고 `pgid == pid` 다. setsid 홀더처럼 세션 리더는 아니다. 터미널은 각자
  세션을 만들므로 동작은 같다.
- **낡은 잡 정리**: 우리 접두사이면서 instance 에 점이 없는 레이블만 다룬다. 그래서 릴리스는 개발 잡을 건드리지 않고,
  개발도 릴리스 잡을 건드리지 않는다. (3b 수정) 레이블은 uid 마다 한 이름공간인데 plist 는 run 디렉터리마다 따로라,
  동시에 띄우는 다른 spawner(다른 worktree 의 dev 앱, live 테스트)의 막 bootstrap 한 잡(PID 아직 `-`)이나 쓰는 중인
  plist 를 지울 수 있었다. 그래서 정리는 **소켓이 열린 뒤 백그라운드 스레드**에서 하고(시작 경로에서 launchctl 대기 제거),
  `launchctl list` 를 `STALE_MIN_AGE`(= `SOCKET_WAIT` + 5 초 = 10 초) 간격으로 두 번 읽는다. 두 번 다 `-` 이고, 우리 plist 가
  있으면 그 mtime 이 10 초보다 오래된 레이블만 `bootout gui/<uid>/<label>` 한다. plist 는 10 초보다 오래됐고 잡이 돌고 있지
  않을 때만 지운다(`plan_cleanup`, `plists_in`).
  bootstrap 이 성공했는데 소켓이 `SOCKET_WAIT`(5 초, 그대로) 안에 열리지 않으면 그 레이블을 bootout 한다(늦게 뜬 홀더가
  남지 않게). (3b) 그 뒤 새 경로로 setsid 를 한 번 시도하고 이유(`launchd: job started but …`)를
  `spawnFallbackReason` 에 남긴다. Linux 도 같다: systemd-run 은 성공했는데 소켓이 안 열리면 `systemctl --user stop <unit>`
  (최선 노력) 후 setsid (`start_service`).
- **폴백**: launchd(macOS)·systemd-run(Linux)이 실패하면 2a 의 setsid 로 띄운다. 실패 원인은 도구 없음, 0 이 아닌 종료,
  5 초 타임아웃, UTF-8 이 아닌 경로, gui 도메인 없음(ssh 세션) 등이다. 이유는 `pty_backend_info.spawnFallbackReason` 에
  남는다(이 앱이 띄운 그 소켓일 때만). `BBARIT_PTY_HOLDER_SPAWN=setsid` 로 setsid 를 강제할 수 있다(디버깅·비교용).
- **Linux**: `systemd-run --user --collect --quiet --service-type=exec -p KillMode=process -p StandardError=append:<log>
  --unit bbarit-<prefix의 .을 -로>-<instance> [-E BBARIT_PTY_HOLDER_IDLE_EXIT_MS=…] -- <exe> … --spawn-method systemd --job <unit>`.
  `StandardError=append:` 는 systemd 240 이상이 필요하다. 그보다 오래된 systemd 에서는 실패해 setsid 로 간다.
  이 Mac 에서는 argv 테스트만 했고, 실제 systemd 실행과 Linux 빌드(`cfg(target_os="linux")` 분기)는 CI(ubuntu)가 처음 확인한다.
- **정보 파일·`pty_backend_info`**: `HolderInfo` 에 선택 필드 `spawnMethod`("launchd"|"systemd"|"setsid"|"manual"),
  `label`, `unit` 을 더했다. 2a/2b 파일도 그대로 읽힌다. `pty_backend_info`(holder)에는 `spawnMethod`, `label`/`unit`,
  `spawnFallbackReason` 이 붙는다. 프로토콜 버전은 그대로 1 이다.
- **홀더 SIGTERM/SIGINT**: `sigaction` 핸들러는 원자 변수 하나만 쓰고, 감시 스레드가 일반 종료 경로를 시작한다.
  새 접속을 받지 않고, `.sock`/`.json` 을 지운 뒤 `[pty-holder] exiting: SIGTERM` 을 남긴다. 터미널을 kill 하거나
  스윕하지 않는다(그것은 GOODBYE `kill_all` 의 일이다). 다만 홀더가 끝나면 PTY master 가 닫히므로 커널이 세션 리더에
  SIGHUP 을 보내고, 보통의 셸은 끝난다. 3.1 의 "홀더가 죽으면 터미널도 죽는다" 와 같은 결과다. 차이는 파일이 깨끗이
  지워진다는 점이다. 새 크레이트는 더하지 않았다(`libc` 만 씀). `kill_all` 뒤 launchd 잡은 `-  0  <label>` 로 남고,
  다음 spawn 의 정리에서 내려간다.
- **테스트**: `spawn::tests::{launchctl_list_rows_are_split_into_live_and_finished_jobs, launchd_plist_is_a_one_shot_interactive_job
  (plutil -lint), holder_env_carries_only_what_the_holder_reads, systemd_run_argv, describe_reads_the_info_file_and_the_fallback_reason}`,
  `proto::tests::holder_info_spawn_fields_are_optional_and_camel_case`,
  `integration_tests::sigterm_removes_socket_and_info_and_leaves_terminals_to_the_hangup`(테스트 바이너리를 실제 홀더 프로세스로
  띄우고 TERM 을 보낸다. 셸의 HUP 트랩으로 SIGHUP 종료를 확인한다). 수동(ignored) `live_spawn_detached_holder` 는 macOS 에서
  launchd 경로를 확인한다. `launchctl list` 의 live pid → `kill_all` 뒤 `-` → `cleanup_stale` 로 사라지고 plist 도 지워지는지
  본다. `BBARIT_PTY_HOLDER_SPAWN=setsid` 로는 setsid 경로를 확인한다.
- **실기(dev 앱, 2026-11-04)**: `pty_backend_info` = `kind:"holder"`, `spawnMethod:"launchd"`,
  `label:"com.bbarit.terminal.pty-holder.dev.<id>"`. `launchctl list` 에 live pid 로 보였다. 셸 탭에서 1 초 tick 루프를 돌리며
  앱을 `kill -TERM` 해도 홀더와 루프는 살아 있었고, 다시 띄운 앱이 같은 소켓에 붙어(`recovered` 2) tick 이 끊기지 않았다.
  `app_quit_kill_terminals` 뒤에는 홀더 로그가 `exiting: GOODBYE kill_all` 이었고 레이블은 `-  0` 으로 남았다. 다음 시작에서
  그 레이블은 bootout 되고 plist 도 지워졌다. 폴백은 실기에서 일어나지 않았다(강제 env 로만 확인).

### 3.2 소켓과 신뢰 경계

- 경로: `~/.config/octo/run/`(없으면 `$TMPDIR/bbarit-<uid>/`), 디렉터리 0700, 소켓 0600.
  dev 와 설치본은 다른 이름을 쓴다(`pty-holder.dev.*` / `pty-holder.*`). 브리지 포트
  19980/19981 분리와 같은 이유다.
- 인증: 같은 uid 만. 연결마다 `LOCAL_PEERCRED`(macOS)/`SO_PEERCRED`(Linux)로 uid 를 확인한다.
  TCP 는 열지 않는다. 그 이상의 토큰은 두지 않는다. 같은 계정의 다른 프로그램은 이미 셸을
  띄울 수 있으므로 신뢰 경계 안이다(herdr `docs/security.md` 와 같은 판단).
- 소켓으로 환경변수(GH_TOKEN 포함)가 지나간다. 0700 디렉터리 + uid 검사로 충분하다고 본다.
  tail 에는 터미널 출력이 들어 있으므로 `run/` 디렉터리는 비밀로 취급한다.
- 제어 클라이언트는 한 번에 하나다. 새 HELLO 가 오면 이전 연결에 BYE 를 보내고 끊는다
  (앱이 두 개 뜨는 경우 대비. `tauri-plugin-single-instance` 가 이미 막지만 dev/설치본 동시
  실행은 소켓 이름으로 분리된다). 이 규칙은 **같은 uid 의 어떤 프로그램(탭 안의 에이전트 포함)도
  앱을 밀어내고 다른 탭의 tail 을 읽을 수 있다**는 뜻이다. 브리지 19980 과 같은 신뢰 경계로
  받아들인다.
- 경로 규칙: macOS 는 `~/.config/octo/run/` 만 쓴다(`$TMPDIR` 는 주기 청소로 소켓이 지워질 수
  있다). Linux 는 `$XDG_RUNTIME_DIR/bbarit/` 을 우선, 없으면 `~/.config/octo/run/`. `sun_path`
  104바이트 제한을 넘는 경로는 거부한다.
- 홀더 로그(`run/pty-holder.<instance>.log`)에 env 와 터미널 바이트를 남기지 않는다.

### 3.3 프로토콜 (herdr `holder_proto.rs` 를 단순화)

프레임: `[kind u8][handle u32 LE][len u32 LE][payload]`, payload 최대 16 MiB. 제어 프레임은
JSON, 데이터 프레임은 원시 바이트. `handle` 은 홀더가 배정하는 u32 이고, 빠릿 터미널 id
(문자열)는 SPAWN/WELCOME 의 JSON 안에서 `id` 로 대응한다.

| 방향 | kind | payload |
|---|---|---|
| app→holder | HELLO | `{version:1, client:"bbarit-app", pid, build:"1.1.60"}` |
| holder→app | WELCOME | `{version, instance, terminals:[{handle,id,cwd,pid,rows,cols,exited,exit_code,scope,started_at,dropped_bytes,modes}]}` 이어서 터미널마다 TAIL. `modes` 는 홀더가 추적한 DECSET 상태(1049 alt-screen, 2004 bracketed paste, 1000–1006 마우스, CSI-u 키보드) |
| app→holder | SPAWN | `{id, argv, cwd, env:{…전체…}, rows, cols, scope}`. 홀더는 `env_clear()` 후 적용 |
| holder→app | SPAWNED / SPAWN_FAILED | `{id, handle, pid}` / `{id, error}` |
| app→holder | INPUT(handle, bytes) | 터미널별 writer 스레드 큐로. 막힌 프로그램은 자기 스레드만 막는다 |
| holder→app | OUTPUT(handle, bytes) | |
| app→holder | RESIZE | `{rows, cols}` |
| app→holder | SIGNAL | `{sig:"TERM"|"KILL"|"HUP"|"INT"}`. 이미 거둔 터미널엔 보내지 않는다(pid 재사용 위험) |
| app→holder | RELEASE | 트리 kill + 스코프 스윕 + 제거. `close_pty` 가 이걸 보낸다 |
| holder→app | EXITED | `{code, signal}`. 거둔 뒤 200 ms 안에 남은 출력을 먼저 보낸다 |
| holder→app | TAIL(handle, bytes) | 재부착용 마지막 1 MiB. 헤더 JSON `{seq_start}` 뒤 원시 바이트 |
| app→holder | GOODBYE | `{reason:"quit"|"handover"|"kill_all"}` |
| app→holder | DRAIN | 새 SPAWN 거부, 마지막 터미널 종료 시 홀더 종료 |
| 양방향 | PING/PONG | 10 초 간격, 30 초 무응답이면 연결 끊김으로 본다 |

흐름 제어: **어느 경우에도 pump 를 멈추지 않는다.** 지금 리더 스레드도 막히지 않고 버리는
방식이고(`main.rs:2741-2751`), herdr 식으로 연결 하나의 backlog 를 공유하면 한 탭의 폭주가 다른
탭까지 멈춘다. 대신 터미널별 1 MiB 링을 유지하고 넘친 바이트 수를 `dropped_bytes` 로 센다.
WELCOME/TAIL 에 그 값을 실어 앱이 "[앱이 꺼진 동안 N MB 생략]" 한 줄을 재생 앞에 보여 준다.
디스크에는 쓰지 않는다(출력에 비밀이 섞인다).

### 3.4 앱 쪽 `PtyBackend`

```rust
trait PtyBackend: Send + Sync {
    fn spawn(&self, req: SpawnRequest) -> Result<(), String>;          // create_shell/create_cli_shell 이 호출
    fn read(&self, id: &str) -> Result<Option<String>, String>;         // read_from_pty 의 pull 의미 유지
    fn write(&self, id: &str, data: &str) -> Result<(), String>;
    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String>;
    fn close(&self, id: &str) -> Result<(), String>;
    fn alive(&self, id: &str) -> bool;
    fn tail(&self, id: &str) -> String;                                 // read_pty_output_buffer
    fn idle_ms(&self, id: &str) -> u64;
    fn pid(&self, id: &str) -> Option<u32>;                             // get_pty_cwd(lsof)·has_child 용
    fn list(&self) -> Vec<TerminalInfo>;                                // 재부착용
}
```

- `InProcessBackend`: 오늘 코드를 그대로 옮긴 것. 폴백이자 Windows 기본.
- `HolderBackend`: 소켓 연결 스레드 하나가 OUTPUT 을 터미널별 `sync_channel(1024)` 과
  tail 사본(1 MiB 링)에 넣는다. `read()` 는 그 채널을 비운다. 프런트가 보는 동작(33 ms 폴링,
  64 KiB 드레인, "PTY disconnected")이 지금과 같다.
  - **중복 렌더 방지**: 바이트 스트림에 터미널별 단조 증가 `seq` 를 둔다. TAIL 은
    `{seq_start, bytes}` 로 오고, 재생이 끝난 지점의 seq 를 기록해 `read()` 는 그 뒤 바이트만
    돌려준다. 그렇지 않으면 연결 직후 들어온 OUTPUT 이 tail 과 채널 양쪽에 들어가 같은 바이트가
    두 번 그려진다.
  - UTF-8 이어붙이기(지금 `spawn_utf8_reader_thread` 안)는 홀더 pump 가 아니라 **앱 쪽 터미널별
    디코더**에서 한다. 홀더는 바이트만 나른다.
- 선택: 설정 `terminal.ptyHolder: "off" | "on"`. 2단계까지 기본 `off`, 3단계에서 `on`.
  홀더 연결 실패(소켓 없음·버전 불일치·권한)는 **조용히 InProcess 로 폴백**하고 상태바에
  "터미널이 앱 안에서 실행 중" 을 표시한다.
- 명령 구성 함수 분리: `create_shell` 의 셸 선택·env 블록(PATH, nvm, `.env`, GH_TOKEN,
  `BBARIT_*`, Claude 마커 제거)을 `build_shell_command(req, deps) -> CommandBuilder` 로 뽑는다.
  `Vec<(String,String)>` 이 아니라 **`CommandBuilder`** 인 이유: 지금 코드는 앱 환경을 상속한
  뒤 `env_remove` 로 지우는 방식이라, 추가 목록만으로는 "지우기" 를 표현할 수 없다. 홀더로
  보낼 때는 `get_argv`/`get_cwd`/`iter_full_env_as_str` 로 **완성된 전체 환경**을 꺼내 SPAWN 에
  싣고, 홀더는 `env_clear()` 뒤 그대로 적용한다. launchd 로 뜬 홀더의 기본 환경은 앱과 다르므로
  홀더가 자기 환경을 섞으면 안 된다. 같은 이유로 홀더 자신은 `BBARIT_TERM_SCOPE` 를 물려받지
  않아야 한다(dev 에서 앱을 빠릿 탭 안에서 띄우는 경우).
  - `deps` 로 `AppHandle` 의존(훅 파일 경로)과 비결정적인 `github_account_env` 결과를
    **주입**해 순수 함수로 만들고, 생성된 argv·cwd·env 키 집합을 스냅샷 테스트한다.
  - `create_cli_shell` 은 합치지 않고 **삭제를 제안**한다(호출자 없음). 삭제가 부담이면 같은
    빌더를 쓰게만 바꾼다.
  - 이 리팩터링은 동작 변화가 없어야 하고 **1단계**에서 먼저 한다.

### 3.5 재부착 (앱 시작·재시작·업데이트 뒤)

순서가 중요하다. 지금 코드는 `deferStart` 판정(`XTerminal.tsx:3944`)이 `restoredPty` probe 보다
먼저 일어나고, 비활성 복원 탭은 `startupDeferredIds`(`App.tsx:2236-2251`)에 들어가 클릭 전까지
아무것도 하지 않는다. 그리고 probe 는 버퍼가 `looksLikeAgentUiReady` 로 보일 때만 "이미 시작됨"
으로 표시하고, 아니면 `:3800-3803` 이 **실행 중인 에이전트에 시작 명령을 다시 친다.**

1. 앱이 뜨면 `HolderBackend` 가 HELLO → WELCOME. 결과를 `pty_list_recovered` 로 노출한다.
   **이 호출은 `applyRestoredProjects` 보다 먼저 끝나야 한다.** 복구 id 는 `startupDeferredIds`
   에서 뺀다(이미 돌고 있으니 미룰 게 없다). 화면 재생만 탭 활성화 때 한다.
2. `XTerminal` 초기화에서 그 id 가 복구 목록에 있으면 `create_shell` 과 시작 명령 주입을
   건너뛴다. `autoStartedCliType` 를 **무조건** 설정해 `:3800-3803` 경로가 돌지 않게 한다.
   화면은 기존 `restoredPty.ts` 경로(`check_pty_alive` → `read_pty_output_buffer` →
   `replayingOutput` 재생)로 복원한다. 팝아웃 재부착으로 검증된 경로이고 7501 재생 중 알림
   억제도 이미 들어 있다.
   - 재생 앞에 WELCOME 의 `modes` 를 DECSET 시퀀스로 붙인다. 1 MiB tail 이 alt-screen·bracketed
     paste·마우스 모드 설정 시점보다 뒤에서 잘리면 휠 브리지·붙여넣기·화면이 깨지기 때문이다.
   - 재생 뒤 `cols-1 → cols` 로 **강제 리사이즈**해 TUI 가 다시 그리게 한다. 크기가 같으면
     SIGWINCH 가 안 갈 수 있다(herdr 의 "nudge").
   - `isRestored` 판정을 `!!terminal.lastWorkDir` 휴리스틱에서 "복구 목록에 있음" 으로 바꾼다.
3. **앱이 꺼진 사이 끝난 터미널**(WELCOME 에 `exited:true`): `check_pty_alive` 가 false 라는
   이유로 tail 을 버리고 같은 id 로 `create_shell` 을 다시 돌리면 안 된다. tail 을 재생하고
   "종료됨 (code N)" 배너를 보여 준 뒤 RELEASE 한다. 새 셸은 사용자가 "다시 시작" 을 눌렀을 때만
   띄운다(기존 재시작 경로).
4. 저장된 프로젝트에 없는 홀더 터미널은 cwd 가 일치하는 프로젝트에 "복구됨" 탭으로 붙이고,
   없으면 "복구된 터미널" 가상 프로젝트에 보여 준다. 자동으로 죽이지 않는다.
5. 7501 상태: 꺼진 동안의 전이는 못 본다. TAIL 재생이 마지막 보고를 복원하므로 탭 색은 맞는다.
   재부착 직후 blocked 인 탭이 있으면 요약 토스트("대기 중인 에이전트 N개") 한 번.
6. **에이전트 릴레이**: `agentLinks` 는 지금 영속하지 않는다. 그대로 두면 재부착 뒤 `agent wait
   --children` 은 빈 목록을 영원히 기다리다 타임아웃(exit 3)으로 끝나고(`bbarit-ctl.mjs:358`),
   앱이 꺼진 동안에는 브리지 호출이 3번 연속 실패(약 6초, `:383`)하면 예외로 끝난다. 그래서
   2단계 최소 범위에 (a) `agentLinks` 영속, (b) ctl 이 브리지 부재 시 포기하지 않고 재시도하는
   변경을 넣는다. 부모·자식 노트 전달은 재부착 뒤 이어진다.
7. **SessionStart 훅**: 앱이 꺼진 사이 Claude 가 `/clear` 로 세션을 바꾸면 훅의 curl 이 조용히
   실패해 저장된 id 가 낡는다. 재부착 때 `claudeSessionDir` 로 transcript 를 다시 탐지해 최신
   jsonl 로 보정한다.

### 3.6 종료·업데이트 의미

- **Cmd-Q / 창 닫기**: 기본은 "앱만 종료, 터미널은 유지". GOODBYE `{reason:"quit"}`.
  메뉴에 "종료하고 모든 터미널 끝내기" 를 따로 둔다(`kill_all` → 홀더가 전부 RELEASE 후 종료).
  설정으로 기본값을 바꿀 수 있다(`terminal.keepRunningOnQuit`, 기본 true).
- **크래시**: 홀더는 모른다. 연결이 끊기면 클라이언트 없음 모드로 간다.
- **업데이트**: `handleUpdate` 가 GOODBYE `{reason:"handover"}` 를 보내고 `relaunch()`. 새 앱이
  붙는다. 홀더 바이너리는 **이전 버전**인 채 남는다.
  - 프로토콜 `version` 이 같으면 그대로 쓴다.
  - 다르면 새 앱은 이전 홀더에 DRAIN 을 보내고 새 홀더를 하나 더 띄운다. 새 터미널은 새
    홀더로, 기존 터미널은 이전 홀더에서 끝날 때까지. 그래서 소켓 이름에 `<instance>` 가 있고
    앱은 디렉터리를 글롭한다.
  - 지금은 경고가 없으니 1단계에서라도 `handleUpdate` 에 "작업 중(working/blocked)인 탭 N개"
    확인 대화상자를 넣는다. 이건 홀더와 무관하게 바로 가치가 있다.
- **스코프 스윕**(`docs/TERMINAL_SCOPE_SWEEP.md`): 탭 닫기 스윕은 홀더가 한다(부모이므로
  자연스럽다). 앱 종료 시 전체 스윕은 **없앤다**. 터미널이 살아 있어야 하기 때문이다.
  `kill_all` 종료에서만 전체 스윕을 한다.
- **다른 종료 경로도 백엔드로**: 비-macOS `CloseRequested` 의 전체 트리 kill(`main.rs:10386-10405`)
  은 `kill_all` 일 때만 한다. 하네스 창의 pagehide 에서 닫는 PTY(`App.tsx:14614`)는 의도대로
  RELEASE 한다(하네스 터미널은 창과 수명을 같이한다).

### 3.7 플랫폼 메모

- macOS TCC: 폴더 접근 권한 프롬프트의 주체가 홀더 프로세스가 된다. 같은 exe 라 번들
  id 는 같지만 launchd 잡으로 뜨면 "BBARIT Terminal" 로 보이는지 실기 확인이 필요하다.
- `get_pty_cwd` 는 `lsof -p <pid>` 를 쓴다. pid 를 홀더에서 받으면 그대로 동작한다.
- `pty_terminal_has_child` 도 pid 기반이라 그대로다.
- Linux `systemd-run` 이 없는 배포판은 `setsid` 폴백. `loginctl enable-linger` 는 하지 않는다
  (로그아웃 뒤 생존은 목표가 아니다).
- Windows(4단계): 명명 파이프 + `pipe_security`(현재 계정 + SYSTEM), ConPTY, 잡 오브젝트,
  `CREATE_BREAKAWAY_FROM_JOB`. herdr `platform/windows.rs`(1.2 k 줄)가 참고 구현이다.

## 4. 단계별 계획

| 단계 | 내용 | 산출물 | 위험 |
|---|---|---|---|
| **0** ✅ | `handleUpdate` 에 "작업 중 탭 N개" 확인 대화상자. 7501 상태로 바로 만든다 | PR 1개, 작음 | 없음. 홀더와 독립 |
| **1** ✅ | 리팩터링만: `PtyBackend` 트레이트 + `InProcessBackend`, `build_shell_command` 분리(의존성 주입), `create_cli_shell` 삭제 또는 빌더 공유, 커맨드 함수는 백엔드에 위임. 동작 변화 0 | Rust ~600 줄, 테스트: argv·cwd·env 키 스냅샷 | 숨은 env 차이(상속 + remove 의미) |
| **2a** ✅ | Rust 반쪽: 홀더 모드(`--mode pty-holder`), 프로토콜(seq·modes·dropped_bytes 포함), `HolderBackend`, `setsid` 분리 spawn, 설정 `terminal.ptyHolder`(기본 `off`) + 실패 시 InProcess 폴백, `pty_backend_info` 커맨드. 프런트 변경 없음 | Rust ~3.9 k 줄(테스트 포함). 통합 테스트: 홀더를 스레드로 띄워 `sh` 생성·입출력·tail·RELEASE·스코프 스윕·seq 중복 없음 | 모드 추적 누락 |
| **2b** ✅ | 프런트: 재부착(3.5 전체: 순서·exited 처리·modes 재생·nudge), `agentLinks` 영속 + ctl 재시도, 종료 의미(3.6: quit 시 터미널 유지, `kill_all` 메뉴) | 프런트 ~400 줄 + Rust 소량 | tail 재생 품질 |
| **3** ✅(3a·3b) | launchd/systemd 등록(고유 레이블·stale 정리·Interactive), 업데이트 handover + DRAIN + 다중 홀더, 복구 탭 UI, 기본 `on` | Rust ~800 줄 | 스파이크 완료(아래 "3단계 스파이크 결과"): setsid 홀더는 앱 coalition·responsible 에 남지만 앱 종료·재실행 뒤 생존·재부착됨, 새 inode 교체(cargo·mv·codesign)는 안전·제자리 덮어쓰기는 기동 중 프로세스 SIGKILL, launchd 기동 +20 ms·RSS 동일, 홀더 기동 59 ms/23 MB, TCC 주체는 홀더를 띄운 앱. **남은 미검증**: 설치 번들 교체 + `relaunch()` 뒤 생존, launchd 홀더의 TCC 항목 이름, 페이지 축출 뒤 제자리 덮어쓰기 영향 |
| **4** | Windows 홀더 | 별도 설계 | ConPTY 소유권 이전 |

구현 메모: 0단계 완료 — `src/terminal/busyAgentTabs.ts`(순수 함수, 셸 탭 제외) + `src/App.tsx` `handleUpdate` 의 `ask()` 확인(네이티브 업데이트 경로만).

구현 메모: 1단계 완료 — `src-tauri/src/pty_backend.rs`. 2절 표의 줄 번호는 1단계 이전 기준이다.
- `PtyBackend` + `InProcessBackend`. `PtyInstance`·`spawn_utf8_reader_thread` 는 그대로 옮겼다.
  `AppState.ptys` 는 `AppState.pty: Arc<dyn PtyBackend>` 가 됐고, PTY 커맨드는 이름·인자·
  반환형·오류 문자열("PTY not found", "PTY disconnected")을 유지한 채 위임만 한다.
- 3.4 스케치와 다른 시그니처: `tail`/`idle_ms` 는 `Result`(기존 커맨드가 "PTY not found" 를
  돌려주므로), `pid` 는 `Result<Option<u32>>`(없는 id 와 "OS 가 pid 를 안 줌" 을 구분해야
  `pty_terminal_has_child` 의 Err 와 `get_pty_cwd` 의 Ok(None) 을 그대로 낼 수 있다).
  `list()` 는 `TerminalInfo { id, pid, scope_token }`. `SpawnRequest` 에 `scope_token` 을 따로
  둔다(스윕은 env 를 다시 파싱하지 않는다).
- `build_shell_command(&ShellSpawnSpec, &ShellEnvDeps) -> Result<CommandBuilder, String>`.
  `Result` 인 이유는 Windows ssh:// 경로 파싱 실패(`build_ssh_pty_command`)다. `ShellEnvDeps` 는
  cwd(`resolve_shell_work_dir` 결과), 훅 경로, ctl 경로, username·home(`/Users/<id -un>`),
  nvm bin, `.env` 내용, GitHub 계정 env 를 주입받는다. Windows 의 `wsl_distribution_installed()`
  는 주입하지 않고 빌더 안에서 기존처럼 필요할 때 한 번만 부른다(미리 계산하면 PowerShell 탭마다
  `wsl.exe` 가 돈다). 테스트는 unix 만: argv·cwd·설정/제거 env 키 목록을 리터럴로 고정했다.
- `create_cli_shell` 은 삭제했다(호출자 없음). 함께 죽는 헬퍼는 없었다.
- 순서 차이(관찰 가능한 결과 동일): 명령을 먼저 만들고 `openpty` 를 나중에 한다. `openpty` 가
  실패하면 예전과 달리 GitHub 계정 조회가 이미 돈 뒤다. `get_pty_cwd` 는 `lsof` 동안 PTY 맵
  잠금을 쥐지 않는다. 잠금이 독(poison)이면 `CloseRequested` 가 패닉 대신 빈 목록으로 진행한다.
- 손대지 않은 것: `.env` 값이 따옴표 한 글자(`KEY="`)면 `&value[1..0]` 으로 패닉하는 기존 버그.

구현 메모: 2a 완료 — `src-tauri/src/pty_holder/{mod,proto,server,spawn,client}.rs`(+ `integration_tests.rs`),
`pty_backend.rs` 의 `PtySelection`, `main.rs` 의 모드 게이트·`pty_backend_info`. 3절과 다르게 간 점:
- **프레임**: 표 그대로에 `BYE`(17, holder→app) 하나를 더했다. 새 HELLO 가 이전 클라이언트를 밀어낼 때
  `{reason:"replaced"}`, 잘못된 HELLO(버전·클라이언트 이름)에 이유를 싣는다. TAIL 페이로드는
  `[json_len u32 LE][{seq_start, dropped_bytes}][원시 바이트]`. OUTPUT 에는 seq 를 싣지 않는다: 홀더가
  WELCOME 과 모든 TAIL 을 상태 잠금 안에서 큐에 넣고 그 뒤에 OUTPUT 이 오므로, 각 바이트는 TAIL 이나
  OUTPUT 중 정확히 한 번 온다. 클라이언트는 터미널별 `next_seq` 로 재연결 때 겹치는 TAIL 앞부분을 버리고,
  `seq_start > next_seq` 면 기존 "[output truncated]" 표식을 넣는다.
- **`modes`** 는 `{decset:[47|1047|1049|1000|1002|1003|1006|2004…], kitty_keyboard:<현재 플래그>}`.
  출력 바이트를 상태 기계로 훑는다(청크 경계에 걸친 시퀀스 포함, `ESC c` 는 전부 초기화, CSI-u 는
  `>f u` push·`<n u` pop·`=f;m u` set, `?u` 조회는 무시). alt/main 화면별 kitty 스택은 나누지 않았다.
- **`dropped_bytes`** 는 "링에서 밀려난 바이트 총수"(= TAIL `seq_start`)다. "앱이 꺼진 동안 생략된 양"은
  앱이 `seq_start - next_seq` 로 계산한다(2b 에서 배너 문구에 쓴다).
- **분리 spawn**: setsid 만(launchd/systemd 는 3단계). 같은 exe 를 `--mode pty-holder --socket <run>/<prefix>.<instance>.sock`
  으로, stdin/stdout `/dev/null`, stderr `<run>/<prefix>.<instance>.log`(0600), cwd `/`, `BBARIT_TERM_SCOPE`·
  `BBARIT_AGENT_MODE` 제거. 홀더도 시작 때 자기 환경에서 `BBARIT_TERM_SCOPE` 를 지운다. 정보 파일
  `<prefix>.<instance>.json` `{pid, socket, version, build, instance}` 은 홀더가 쓰고 정상 종료 때 소켓과 함께 지운다.
  앱은 json 을 글롭해 pid 가 살아 있고 버전이 같은 홀더에 붙고, 죽은 홀더의 json·소켓은 지운다. 버전이 다른
  홀더는 건너뛴다(DRAIN·다중 홀더는 3단계). 7일 넘은 고아 로그는 정리한다.
- **경로**: macOS 는 `~/.config/octo/run/` 만(3.2 의 `$TMPDIR` 대안은 쓰지 않음), Linux 는 `$XDG_RUNTIME_DIR/bbarit/`
  우선. 디렉터리 0700, 소켓 0600, 소켓 경로 100바이트 초과는 거부. `--socket` 으로 받은 경로의 부모가 이미 있으면
  권한을 바꾸지 않는다(`/tmp` 같은 공용 디렉터리를 0700 으로 만들지 않기 위해).
- **선택 시점**: 설정은 시작 때 읽지만 홀더 연결은 **지연**한다(`setup` 의 백그라운드 스레드, 첫 `create_shell`,
  또는 `pty_backend_info` 중 먼저). Tauri 빌더 전에 붙으면 single-instance 가 곧 끝낼 두 번째 실행이 HELLO 로
  실행 중인 앱을 밀어낸다. 연결 실패는 InProcess 로 폴백하고 이유를 `pty_backend_info().fallbackReason` 에 남긴다
  (상태바 표시는 2b). `pty_backend_info` 는 `{kind, socket?, recovered:[WELCOME 항목], fallbackReason?, lost?}`.
- **2a 의 종료 의미**: 앱 종료(`RunEvent::Exit`)는 GOODBYE `kill_all` 이다(홀더가 트리 kill + 스코프 스윕 후 종료).
  재부착 UI 가 없으므로 오늘과 같은 의미를 유지했다. 터미널이 살아남는 것은 크래시·강제 종료 때뿐이다.
  "종료해도 유지"(3.6)는 2b. 같은 id 로 `create_shell` 이 다시 오면 기존 터미널을 RELEASE(트리 kill + 스코프
  스윕)하고 새로 띄운다. InProcess 는 같은 id 를 맵에서 덮어쓸 뿐 이전 프로세스를 kill·스윕하지 않았다(master 가
  닫히며 SIGHUP 만 감). 홀더 쪽이 더 확실히 정리한다.
- **스윕**: RELEASE·`kill_all` 때만 한다(자연 종료 때는 하지 않음, InProcess 와 동일). `kill_process_tree`·
  `sweep_scope(s)` 는 `main.rs` 에 그대로 두고 홀더가 `crate::` 로 부른다(같은 바이너리).
- **흐름 제어**: pump 는 클라이언트를 기다리지 않는다. 클라이언트별 미전송 백로그가 32 MiB 를 넘으면 그 연결을
  끊는다. 앱은 재연결해 TAIL 로 따라잡는다(그 사이 1 MiB 를 넘게 놓쳤으면 truncation 표식).
- **재연결**: BYE 없이 끊기면 같은 소켓에 10 초 동안 100 ms→2 s 백오프로 다시 붙는다. BYE(다른 앱이 가져감)면
  다시 붙지 않고 모든 터미널을 끊김으로 표시한다. 다음 `create_shell` 이 홀더를 다시 찾거나 띄운다.
  끊긴 사이 닫은 터미널은 다음 WELCOME 에서 RELEASE 한다. 홀더가 닫는 중인 연결에 쓴 입력은 잃을 수 있다.
- **수명**: 유휴 종료는 "살아 있는(거두지 않은) 터미널 없음 + 클라이언트 없음" 60 초(`BBARIT_PTY_HOLDER_IDLE_EXIT_MS`
  로 조정, 테스트용). 끝났지만 RELEASE 안 된 터미널은 클라이언트가 없으면 홀더를 붙잡지 않는다.
  PING 10 초 / 읽기 타임아웃 30 초, HELLO 는 5 초 안에 와야 한다.
- **pid 수명**: 홀더는 프로그램이 끝나면 바로 거둔다(wait). 그 뒤 pid 는 OS 가 재사용할 수 있으므로
  `HolderBackend::pid()`·`list()` 는 EXITED(또는 홀더 상실) 뒤 pid 를 **None** 으로 돌려준다.
  `CloseRequested` 의 `kill_process_tree`, `pty_terminal_has_child`, `get_pty_cwd` 같은 pid 사용처는 None 을
  "프로세스 없음" 으로 다뤄야 한다. 홀더도 거둔 터미널에는 SIGNAL·트리 kill·`killer.kill()` 을 하지 않는다.
- **리뷰 반영(2a 수정 커밋)**: run 디렉터리는 lstat 로 확인해 심볼릭 링크·다른 소유자·0700 이 아닌 경우 거부한다
  (예전처럼 chmod 하고 넘어가지 않음). json 의 소켓이 run 디렉터리 밖이면 무시한다. 접속만 하고 HELLO 전인
  연결도 "클라이언트 있음" 으로 쳐서 유휴 종료가 앱의 탐침과 HELLO 사이에 끼지 않는다. 밀린 클라이언트는
  소켓을 직접 shutdown 한다. 핸들은 u32 가 한 바퀴 돌아도 쓰는 중인 값을 건너뛴다. 밀려난 클라이언트의
  프레임은 HELLO 교체와 같은 잠금 아래에서 버린다. 앱 쪽은 연결·채택을 한 뮤텍스로 직렬화하고 현재 세대가
  아닌 연결의 프레임을 버린다. 쓰기는 연결별 writer 스레드(쓰기 타임아웃 5 초)로 보내 메인 스레드 커맨드가
  소켓에 막히지 않는다. `release_later` 는 WELCOME 마다 비우고 같은 id 로 spawn 하면 지운다. 기다리는 쪽이
  없는 SPAWNED 는 RELEASE 하고, 응답을 잃은 SPAWN 은 다음 WELCOME 으로 해결한다. 모드 게이트는 `args_os`
  를 쓴다. CI(ubuntu)에 `cargo test … pty_holder` 단계를 더했다.
- **공용 헬퍼**: `pty_backend.rs` 의 UTF-8 이어붙이기·큐(드롭 + "[output truncated]")·64 KiB 드레인·출력 버퍼
  상한을 `Utf8Reassembler`/`OutputQueue`/`drain_output`/`append_output_buffer` 로 뽑아 두 백엔드가 같이 쓴다
  (InProcess 동작 동일). Windows 는 `pty_holder` 모듈을 컴파일하지 않고, 게이트는 오류를 찍고 2 로 끝난다.
- 실기(macOS, 디버그 바이너리): `octo-ui --mode pty-holder --socket /tmp/x.sock` → 클라이언트가 `sh` 생성 →
  클라이언트 `kill -9` → `sh` 가 홀더의 자식으로 생존 → 새 클라이언트가 WELCOME·TAIL 수신, 입력·출력 정상 →
  RELEASE 로 `sh` 소멸 → 유휴 종료로 소켓·json 정리. 앱 쪽 `spawn_holder` 로 띄운 홀더는 `getsid == pid` 이고
  환경에 `BBARIT_TERM_SCOPE` 가 없다. 앱 자체(Tauri)로 설정을 켠 실기는 2b 와 함께 한다.

구현 메모: 2b — `src/terminal/ptyRecovery.ts`(레지스트리 + 순수 함수), `XTerminal.tsx` 초기화, `App.tsx`
`applyRestoredProjects`·저장, `agentRelay.ts` 의 링크 직렬화, `bbarit-ctl.mjs` 재시도, `pty_backend.rs` 의
`ExitReason`/`exit_goodbye_reason`/`keep_running_on_quit`, `main.rs` 의 커맨드·메뉴·종료 처리. 3절과 다르게 간 점:
- `pty_list_recovered` 는 첫 WELCOME 의 터미널 + **이 앱이 띄워 아직 쥔 터미널**(웹뷰 새로고침)을 돌려준다.
  닫힌 것은 빼고 `exited`·`pid` 는 현재 값. InProcess 는 `[]` 이고 `isRestored` 는 예전 `!!lastWorkDir` 를 쓴다.
  프런트는 `pty_backend_info` → (holder 면) `pty_list_recovered` 를 부르고 결과를 레지스트리에 둔다. 한 번의 시도는 15 초
  상한이고, 실패·시간 초과는 in-process 로 보지 않고 백오프(0.5→10 초)로 다시 묻는다. 답이 올 때까지 프로젝트 복원
  (= `create_shell`)을 하지 않는다.
- 복구 터미널은 비활성 탭이어도 **마운트 때 바로** 재생·읽기 루프를 시작한다(3.5-1 의 "재생은 활성화 때" 와 다름):
  읽기 루프가 돌지 않으면 홀더 큐가 차서 잘린다.
- 꺼진 사이 끝난 터미널: tail + modes 재생, 모드 해제, `close_pty`(RELEASE), `octo-pty-exited`, 배너
  "종료됨 (code N)". 기존 "재시작" 경로가 프런트에 없어서 **Enter 를 누르면** 같은 탭에서 `initialize()` 를 다시
  돌린다(그 전 입력은 버림).
- `modes` 재생은 alt-screen 을 먼저, kitty 플래그는 `CSI > f u`. 생략 줄은 TAIL 의 `dropped_bytes`(링에서 밀린 총량)를
  쓴다. 새 앱의 xterm 에는 그만큼이 없으므로 "꺼진 동안" 양과 같지 않아도 화면에 없는 양은 맞다.
- 저장 안 된 홀더 터미널(팝아웃·pm2 로그·하네스 셸 포함)은 같은 폴더 프로젝트에 "복구됨" 탭, 없으면
  "복구된 터미널" 프로젝트(다음 저장부터 일반 프로젝트). 자동으로 죽이지 않는다.
- blocked 요약 토스트는 XTerminal 이 재생 뒤 보내는 `octo-pty-recovered` 를 2 초 모아 한 번. "처음 복구" 토스트는 KV
  `octo-pty-holder-recovered-notice` 로 한 번만. `fallbackReason` 은 토스트로 보인다(상태바 대신).
- 종료: `exit_goodbye_reason(keep, kill_all_flag, handover_flag)` — 메뉴/`app_quit_kill_terminals` > 업데이트
  (`pty_prepare_handover` 뒤 `relaunch()`) > `terminal.keepRunningOnQuit`(릴리스 기본 true, **디버그 빌드는 명시적 true
  일 때만**, 결정 9). 홀더 quit/handover 는 앱 스윕과 비-macOS `CloseRequested` 트리 kill 을 건너뛴다. 메뉴 항목은
  macOS 앱 메뉴에만 있다(ko/en 은 시작 때 `language`). 스키마 키는 선택적(미설정 = 빌드별 기본)이라 설정 저장이
  dev 기본값을 true 로 굳히지 않는다.
- 버전 불일치: 다른 프로토콜 버전의 홀더가 살아 있으면 두 번째 홀더를 띄우지 않고 InProcess 로 폴백하며 이유를
  `fallbackReason` 에 남긴다(3단계 DRAIN 전까지 이전 터미널을 보이지 않게 버려 두지 않기 위해).
- agentLinks: 자식·부모 id, 이름, cliType, `lastNotifiedTurn/State`, `lastSendTurn` 을 프로젝트 JSON(`agentLinks`)에
  저장하고, 로드 뒤 두 탭이 다 있는 링크만 되살린다. 노트를 보낼 때 저장을 한 번 예약한다. ctl `agent wait/run` 은
  브리지가 없거나 `__BBARIT_CTL__` 준비 전이면 3번 실패 규칙 없이 `--timeout` 까지 기다리고 stderr 에 한 줄을 찍는다.
- **리뷰 반영(2b 수정 커밋)**: `HolderBackend::spawn` 은 살아 있는 id 를 더는 RELEASE 하지 않고 `"PTY alive in holder"` 로
  거절한다(`create_shell` 의 `replace: true` 만 교체). 프런트는 이 오류를 받으면 붙는다. 끝났거나 잃은 id 는 예전처럼
  RELEASE 후 새로 띄운다. 목록에서 attach 였는데 마운트 때 죽어 있으면 exited 경로(tail + 배너 + Enter)로 간다. Enter
  대기 중인 탭은 모듈 수준 `awaitingRestart`(id → 배너)에 남아 재마운트가 배너만 다시 그린다. 재생 경로는
  `pty_attach_snapshot`(버퍼 복사 + 읽기 큐 비우기를 한 잠금 안에서, 두 백엔드)을 쓰고 `tail()` 의 1회성 드레인은 없앴다.
  재생 중 7501 이벤트는 `replaying` 으로 표시돼 에이전트 노트를 만들지 않고, 재생 뒤 `octo-pty-replayed` 로 링크의
  turn 을 맞춘다(저장된 turn 은 복원하지 않음: 실행마다 0 부터). `relaunch()` 실패 시 `pty_cancel_handover`.
  `find_or_spawn` 은 pid 만이 아니라 소켓 접속으로 홀더를 판정한다. ctl 은 `--port` 명시 때 예전처럼 3번 실패로 끝난다.
- **안 한 것**: 3.5-7(재부착 때 Claude transcript 재탐지 — `read_directory` 에 mtime 이 없어 "더 최신 jsonl" 판정을
  못 함), 비-macOS 의 "종료하고 모든 터미널 끝내기" UI(커맨드 `app_quit_kill_terminals` 만 있음), 앱 실기 검증.

### 3단계 스파이크 결과 (2026-11-04, macOS 27.0.1 (26A434), Apple Silicon arm64)

실험 대상은 `c312c0e` 의 디버그 바이너리(265 MB, ad-hoc·linker-signed)와 그 복사본이다. 측정 로그는 스파이크 세션의
스크래치 디렉터리(`E1.log`…`E6.log`)에 있고 리포에는 넣지 않았다. `launchctl procinfo` 는 root 가 필요해 쓰지 못했다.
coalition·responsible pid 는 대상 프로세스에 `kill -ABRT` 를 보내 생긴 크래시 리포트(`.ips` 의 `coalitionID`/
`coalitionName`/`responsiblePid`)와 `launchctl print gui/<uid>/<label>` 의 `resource coalition` 으로 읽었다.

**E1. 오늘의 `setsid` 홀더가 속한 coalition**
- 방법: dev 앱(`target/debug/octo-ui`)을 ① 설치본 탭 안의 셸에서 `tauri dev` 로, ② LaunchServices 실행을 흉내 낸
  일회성 launchd 잡(`spike.bbarit.devapp-…`)으로 띄우고, 앱이 `setsid` 로 띄운 홀더를 앱 종료 뒤 ABRT 로 확인했다.
- 결과: ② 에서 홀더(pid 5738, `getsid == pgid == 5738`, 앱 종료 뒤 ppid 1)는 **앱 잡의 coalition 그대로**였다
  (`coalitionID 58458`, `coalitionName spike.bbarit.devapp-…` = 앱 잡의 resource coalition, `responsiblePid 5726` = 이미 끝난
  앱 pid). 앱이 정상 종료된 뒤에도 그 coalition 은 `state = active` 로 남았고, 다시 띄운 앱도 같은 coalition(58458)에 들어갔다.
  ① 에서는 dev 앱과 홀더 모두 설치본의 coalition(`36490 com.bbarit.terminal.source`)에 있었다. 셸에서 띄운 프로세스는
  setsid·재부모화와 상관없이 그 앱의 coalition 을 물려받는다.
- 결과(생존): 두 경우 모두 앱 정상 종료(`plugin:process|exit`, `keepRunningOnQuit=true`) 뒤 홀더와 탭 셸은 살아 있었고,
  launchd 가 앱 잡을 끝낼 때 coalition 의 남은 프로세스를 정리하지는 않았다.
- 설계 결론: "setsid 만으로는 앱 coalition 에 남는다"는 사실로 확인됐다. 다만 이번 측정에서 그것 때문에 홀더가 죽지는
  않았다. 그러니 launchd 의 이유는 "생존"이 아니라 **귀속**이다. 앱 coalition 에 남은 홀더는 그 앱의 에너지·메모리·
  jetsam 집계에 묶이고, TCC 와 크래시 리포트도 끝난 앱 pid 를 responsible 로 가리킨다(E6). 3단계 launchd 잡은 그대로 진행한다.
  번들 교체가 coalition 을 거두는지는 E2 에서 보지 못했다(미검증).

**E2. 업데이트식 재시작**
- 방법: 홀더 on 인 launchd dev 앱의 셸 탭에서 `for i in $(seq 1 600); do echo tick $i; sleep 1; done` 를 돌리고
  ⓐ 정상 종료 → `launchctl kickstart` ⓑ `pty_prepare_handover` + `plugin:process|restart` ⓒ `kill -TERM` → kickstart.
- 결과: ⓐ·ⓒ 둘 다 새 앱이 `pty_backend_info` `kind:"holder"` 로 같은 소켓에 붙었다. `recovered` 3개(셸 2 + Claude 1)였고
  루프는 끊김 없이 이어졌다(tick 54 @18:43:17 → tick 89 @18:43:53 → tick 181 @18:45:25). ⓑ 는 `restart` 호출이 `null` 을
  돌려주고 앱이 그대로 떠 있었다. 그 뒤 같은 앱에서 `plugin:process|exit` 도 효과가 없어 `kill -TERM` 으로 끝냈다.
  launchd 잡 안의 dev 앱에서 Tauri `relaunch()` 경로는 재현하지 못했고, 원인은 조사하지 않았다.
- 설계 결론: 프로세스 수준의 "앱 교체 뒤 홀더 생존 + 재부착"은 확인됐다. 실제 `.app` 번들 교체(업데이터)와
  `relaunch()` 는 **미검증**이다. 설치 빌드로 다시 확인해야 한다.

**E3. 실행 중인 홀더의 실행 파일을 바꿀 때**
- 방법: 디버그 바이너리 복사본을 홀더로 띄우고(`--mode pty-holder`, setsid) 파이썬 클라이언트로 `sh` 를 SPAWN 했다.
  그다음 실행 파일을 (a) 새 파일 + `mv`, (b) 제자리 `cp`, (c) `codesign -s - -f` 로 바꿨다. 결과는 inode·생존·새 SPAWN 으로 확인했다.
- (a) `mv`: inode 32784308 → 32784487. 5 초 뒤 홀더 생존, 새 SPAWN 성공, 기존 자식 생존. **안전.**
- (b) 제자리 `cp`(inode 32784487 유지): **기동 중인**(exec 후 약 1 초, 아직 소켓 전) 홀더는 덮어쓰는 순간 SIGKILL 됐다
  (`SIGKILL (Code Signature Invalid)`, namespace CODESIGNING, "Invalid Page", 크래시 리포트 `holder-exe-…-173441.ips`).
  완전히 기동한 홀더는 코드 바이트가 다른 파일(`__text` 를 난수로 바꾼 같은 크기 사본)로 덮어써도 2 분 넘게 살았다.
  새 SPAWN·잘못된 HELLO·SIGNAL·RELEASE·RESIZE·GOODBYE kill_all 도 정상이었다. 같은 파일을 덮어쓴 뒤 `mmap` 한 `cmp` 는
  같은 사유로 두 번 SIGKILL 됐다. 페이지가 메모리에서 밀려난 뒤 다시 읽힐 때 실행 중인 홀더도 죽는지는 확인하지 못했다(`purge` 는 root 필요).
- (c) `codesign -f`: 새 파일로 바꿔 쓴다(inode 32785374 → 32785590). 홀더 생존, 새 SPAWN 성공. **안전.**
- cargo: `tauri dev` 재빌드 전후로 `target/debug/octo-ui` inode 가 32174038 → 32805762 로 바뀌었다(deps 산출물과
  하드링크도 아님). 새 파일을 쓰므로 (a) 와 같다. 재빌드 동안 dev 홀더(구 바이너리)는 영향이 없었다.
- 설계 결론: 홀더 exe 는 **반드시 새 inode 로 교체**되어야 한다. cargo·codesign·`mv`·번들 통째 교체는 안전하다.
  제자리 쓰기(`cp` 덮어쓰기, `dd conv=notrunc`, 일부 설치 도구)는 그 파일에서 기동 중이거나 새로 매핑하는 프로세스를
  죽이고, 실행 중인 홀더도 잠재적으로 위험하다. 업데이터 경로가 제자리 쓰기를 하지 않는지 3단계에서 확인한다
  (Tauri 업데이터는 `.app` 을 통째로 옮기는 방식이라 예상상 안전하지만 미검증).

**E4. 일회성 launchd 잡(3.1 계획)**
- 방법: 스크래치 plist(`RunAtLoad`, `KeepAlive=false`, `AbandonProcessGroup`, `ProcessType=Interactive`, env 는 HOME·PATH)를
  `launchctl bootstrap gui/501` 로 올렸다. 시간·coalition·환경·레이블 수명·bootout 동작을 측정했다.
- 시간: bootstrap 호출 5 ms, bootstrap → 소켓 생성 중앙값 **79.5 ms**(5회: 100/70/80/77/80). 같은 바이너리의 setsid 기동은
  59 ms(E5)라 약 20 ms 차이다. 새 파일 첫 실행은 두 방식 모두 1.7 s 였다(서명 검증·페이지 인). RSS 는 23.4 MB 로 setsid 와 같다.
- coalition: 잡마다 자기 resource/jetsam coalition 이 생긴다(`name = <label>`). 홀더 ABRT 리포트는 `coalitionName = <label>`,
  `responsiblePid = 없음`(자기 자신)이었다. jetsam priority 40, `spawn type = interactive (4)`, 메모리 한도 없음.
- 환경: launchd 가 `PATH`(plist 값)·`HOME`·`XPC_SERVICE_NAME=<label>`·`OSLogRateLimit=64`·`SSH_AUTH_SOCK` 만 준다.
  홀더가 띄운 자식의 env 는 SPAWN 이 준 것 + `SHELL`/`PWD`/`SHLVL` 뿐이었다. 2a 구조(SPAWN 이 전체 env 를 실어 보냄)로 충분하다.
- 레이블 수명: 유휴 종료 뒤에도 `launchctl list` 에 `-  0  <label>` 로 남는다. **같은 레이블 재-bootstrap 은 실패**한다
  (`Bootstrap failed: 5: Input/output error`). `launchctl kickstart gui/501/<label>` 은 남은 잡을 다시 띄운다.
  PID 칸이 `-` 인 잡의 `bootout` 은 rc 0 으로 깨끗이 내려간다.
- 살아 있는 잡 bootout: 홀더가 즉시 끝났다(로그에 "exiting" 없음, SIGTERM 핸들러 없음). 그 아래 셸 2개도 사라졌고,
  HUP 트랩을 건 셸은 `got-HUP` 을 남겼다.
- 설계 결론: 3.1 의 세부(고유 레이블, `-` 인 잡만 bootout, 살아 있는 잡 bootout = 모든 터미널 HUP)는 실측과 맞다.
  추가할 것: ① 홀더에 SIGTERM 핸들러(소켓·json 정리; 지금은 TERM 으로 죽으면 `.sock`/`.json` 이 남는다. 다음 `find_or_spawn` 이
  지우긴 한다) ② 고정 레이블 + `kickstart` 도 선택지지만, 버전별 다중 홀더(DRAIN)를 생각하면 고유 레이블이 단순하다.

**E5. 홀더 기동 비용(dylib 정적 초기화)**
- 방법: 스크래치 사본을 `--mode pty-holder` 로 5번 띄워 exec → 로그의 "listening" 줄까지 시간을 쟀고, 1 초 뒤 RSS 를 쟀다.
- 결과: 1회차 1707 ms(새로 복사한 파일의 첫 실행), 2~5회차 56/60/57/59 ms, **중앙값 59 ms**. 유휴 RSS **23.3 MB**.
  바이너리 265 MB(디버그), 링크된 dylib·프레임워크 24개(AppKit·WebKit·CloudKit·CoreData 등 GUI 프레임워크 포함).
- 설계 결론: 매번 드는 비용(약 60 ms·23 MB)은 문제없다. 업데이트·재빌드 직후 첫 기동은 서명 검증 때문에 약 1.7 s 가 걸린다.
  `SOCKET_WAIT` 5 s 는 여유가 있지만 2 s 아래로 줄이지 않는다. 별도 경량 바이너리는 필요 없다.

**E6. TCC 프롬프트 귀속(최선 노력)**
- 방법: launchd dev 앱(pid 5726)이 setsid 로 띄운 홀더 아래 셸 탭에서 `ls ~/Desktop`·`ls ~/Documents` 를 실행했다.
  ctl 스크린숏을 찍고 `log stream` 으로 `com.apple.TCC` 를 봤다.
- 결과: tccd 가 `AUTHREQ_PROMPTING service=kTCCServiceSystemPolicyDesktopFolder` 를 남겼다. 이때 responsible 은
  `identifier=octo_ui-…, pid=5726, responsible_path=…/target/debug/octo-ui` 로, 셸·홀더가 아니라 **홀더를 띄운 앱**이었다.
  약 1.9 s 뒤 `authValue=2`(허용)가 기록됐고 Documents 도 허용됐다. 두 `ls` 모두 rc 0 이었다.
  프롬프트 창은 웹뷰 스크린숏에 잡히지 않고, 누가 눌렀는지도 확인할 수 없어 대화상자 문구는 관찰하지 못했다.
- 설계 결론: setsid 홀더의 TCC 주체는 "홀더를 띄운 앱 프로세스"다. 앱이 끝난 뒤 홀더 셸이 새로 묻는 경우는 확인하지
  못했다(responsible pid 가 죽은 pid 를 가리킴). launchd 홀더는 responsible 이 자기 자신이라, 프롬프트와 권한 항목이 **홀더 exe
  (설치본에서는 번들 안의 같은 exe)** 기준이 된다. 설치 빌드에서 이 항목이 "BBARIT Terminal Source" 로 보이는지,
  앱에 준 권한을 그대로 쓰는지는 **미검증**이다(설치본에서 다시 확인).

**3단계에 반영할 것 요약**: launchd 잡은 coalition·responsible 분리를 위해 유지한다(생존 자체는 setsid 로도 이번엔
문제없었음). 홀더 SIGTERM 정리를 더한다. 실행 파일 교체는 새 inode 만 허용한다. 설치 빌드 실기(번들 교체 + `relaunch()`,
TCC 항목 이름)를 PR 체크리스트에 넣는다.

구현 메모: 3b — `pty_holder/multi.rs`(`HolderSet`), `proto.rs`(`protocol_version`, `ACK`), `spawn.rs`(`scan`/`Found`,
`pick_or_spawn`), `client.rs`(연결별 `version`, `drain`), `server.rs`(DRAIN ACK, drained 규칙). 3.6 과 다르게·자세히 간 점:
- **다중 홀더**: 앱은 시작 때 run 디렉터리의 정보 파일을 모두 본다(`spawn::scan`). 우리 프로토콜 버전의 홀더가 있으면
  그것이 primary, 없으면 새로 띄운다. **더 오래된** 버전(`MIN_ATTACH_VERSION`(1) ≤ v < 우리)의 살아 있는 홀더에는 **그
  버전으로** HELLO 해 붙고(지금까지 모든 버전은 프레임·페이로드가 같다) DRAIN 을 보낸다. 그 홀더의 터미널은 복구 목록에
  들어가 attach·write·resize·close 가 되지만 SPAWN 은 절대 보내지 않는다. `HolderSet` 이 터미널 id → 홀더 맵으로 호출을
  나눈다(맵에 없으면 primary). 이전 홀더에서 아직 도는 id 로 `create_shell` 이 오면 `"PTY alive in holder"`(프런트는 붙음),
  끝난 id 면 거기서 RELEASE 하고 primary 에 띄운다. 이전 홀더의 마지막 터미널을 닫으면 앱은 그 홀더에 GOODBYE quit 를
  보낸다(곧 drained 로 끝나므로 재접속하지 않게). 버전이 같으면 `HolderSet` 은 primary 하나뿐이고 모든 호출이 그대로 간다.
  **더 새로운** 버전(다운그레이드)만 있고 우리 버전이 없으면 예전처럼 in-process 로 폴백하고 이유를 남긴다.
- **DRAIN**: 홀더는 ACK 프레임(18, `{of:"DRAIN", terminals:n}`)으로 답한다. 3b 이전 홀더는 ACK 를 안 보내므로 앱은 기다리지
  않는다(`drainAcked` 로만 보인다). 여러 번 받아도 같다. **종료 조건을 "모든 터미널이 끝남"에서 "모든 터미널이 RELEASE 됨"으로
  바꿨다**: 꺼진 사이 끝난 터미널만 남은 이전 홀더가 DRAIN 받자마자 끝나면 새 앱이 tail·"종료됨" 배너를 못 보이고 새 셸을
  띄우기 때문이다. 아무도 RELEASE 하지 않는 끝난 터미널은 평소의 유휴 종료(클라이언트 없음 60 초)로 정리된다.
- **`pty_backend_info.holders`**: `[{socket, version, primary, draining, drainAcked, terminals, connected, spawnMethod, label?,
  unit?, spawnFallbackReason}]`. primary 가 먼저이고, 이전 홀더는 연결돼 있거나 터미널이 남아 있을 때만 나온다.
  `kind`/`socket`/`spawnMethod` 등 최상위 필드는 primary 를 가리킨다.
- **버전 흉내(디버그 빌드만)**: `BBARIT_PTY_HOLDER_PROTO_VERSION=<n>` 이면 앱과 그 앱이 띄우는 홀더가 버전 n 을 말한다
  (launchd/systemd 홀더 env 에도 넘김). 두 번째 빌드 없이 다중 홀더 경로를 실기로 확인하려는 것이다. 릴리스 빌드는 무시한다.
- **업데이트 재시작(스파이크 E2ⓑ 의 원인)**: 권한 문제가 아니다(`capabilities/default.json` 의 `process:default` 에
  `allow-exit`·`allow-restart` 가 들어 있다). `plugin:process|restart`/`exit` 는 `request_restart`/`exit` 가 이벤트 루프에
  `RequestExit` 를 **올려 두기만** 하고 unit 을 돌려주므로 `invoke` 는 곧바로 `null` 이다. 실제 종료(RunEvent::Exit → GOODBYE →
  재실행)는 루프가 그 메시지를 처리할 때 일어나는데, 백그라운드 dev 앱에서 3 초·13 초로 들쭉날쭉했다(첫 시도는 13 초 뒤에야
  새 pid). 스파이크는 그 전에 "안 됨"으로 봤을 가능성이 크다. 그래서 `app_relaunch_for_update`(async 커맨드)를 더했다:
  handover 표시 → **곧바로** 홀더에 GOODBYE handover → `request_restart()` → 8 초(`RELAUNCH_WATCHDOG`) 안에 안 끝나면 그
  스레드에서 `tauri::process::restart`(새 프로세스 + exit). `handleUpdate` 는 이 커맨드를 쓰고, 없으면 예전 `relaunch()` 경로.
  실기: 이 커맨드로 1 초 안에 새 pid, 같은 홀더(로그 `client attached` 만 늘어남), tick 루프 끊김 없음.
- **Windows**: `pty_holder_wanted(.., unix)` 는 unix 가 아니면 항상 false 라 `fallbackReason` 이 없고(폴백 토스트 없음), 설정 체크박스는 꺼짐·비활성(macOS/Linux 전용).
- **테스트**: `integration_tests::{an_older_holder_is_recovered_and_drained_while_new_terminals_go_to_ours,
  a_draining_holder_keeps_exited_terminals_until_they_are_released}`(스레드 홀더 둘: v1 은 draining·ACK·attach·입력·끝난 id 재사용,
  새 터미널은 v2, 마지막 RELEASE 뒤 v1 종료), `proto::tests::{version_override_is_debug_only_and_sane, ack_round_trip}`.

각 단계는 별도 PR 이고, 2단계부터는 개발 빌드 실기(앱 종료 → 재시작 → 탭 화면·입력·7501
상태 복원, 업데이트 재시작 시 Claude 작업이 계속 도는지)를 PR 체크리스트에 넣는다.

## 5. 검증 계획

- 단위: 프레임 인코딩·디코딩 라운드트립, 16 MiB 상한, 버전 불일치 거부, tail 링 상한,
  env 빌더가 오늘의 `create_shell` 과 같은 키 집합을 만드는지(스냅샷).
- 통합(cargo test, unix): 같은 프로세스 안에서 홀더 서버를 스레드로 띄우고 임시 소켓으로
  SPAWN `sh -c 'echo hi; sleep 30'` → OUTPUT 에 `hi` → 연결 끊고 재연결 → WELCOME 에 터미널
  1개 + TAIL 에 `hi` → RELEASE → 프로세스 없음. 스코프 토큰을 가진 이중 포크 자식도 함께
  사라지는지.
- 실기(macOS): Claude 탭에서 긴 작업 시작 → Cmd-Q → 30 초 뒤 앱 재실행 → 탭 화면이 이어지고
  Claude 가 그 사이 진행한 출력이 보이며 입력이 들어가는지. 같은 시나리오를 업데이트 버튼으로.
  `pgrep -f "mode pty-holder"` 가 앱 종료 뒤에도 살아 있는지. Activity Monitor 에서 홀더가
  어떤 이름으로 보이는지.

## 6. herdr 와 다르게 가는 점 (의도적)

- 홀더가 앱을 재시작하지 않는다. herdr 의 holder 는 core(데몬)를 되살리지만, 빠릿에서는
  앱이 UI 이므로 사용자가 다시 연다.
- 클라이언트가 없을 때 백프레셔로 프로그램을 멈추지 않는다.
- 터미널 식별자는 홀더의 일련번호가 아니라 빠릿 터미널 id(문자열)다. 저장된 프로젝트와
  바로 맞춘다.
- 소켓 프로토콜은 앱 전용이다. 외부 클라이언트(ctl, 에이전트)는 지금처럼 브리지 HTTP 와
  UI 커맨드 버스를 쓴다. 홀더 소켓을 공개 API 로 만들지 않는다.

## 7. 결정 필요

1. **종료 기본값**: Cmd-Q 가 터미널을 살려 두는 게 기본인가(제안: 예). 처음 한 번은 안내
   토스트를 띄운다.
2. **메뉴바 표시**: 앱이 꺼져 있어도 홀더가 돌고 있음을 사용자가 알 방법. 제안: 1차는
   없음(Activity Monitor 에 보임). 2차에 작은 메뉴바 아이콘 검토.
3. **단계 0 을 이번 릴리스 다음(1.1.61)에 바로 넣을지.** 제안: 예, 작고 독립적이다.
4. **설정 기본값 전환 시점**: 3단계에서 `on`. 그 전까지는 설정에서 켠 사용자만.
   → 결정·반영(3b): 릴리스 빌드 기본 `on`(`"off"` 로 끔). 디버그 빌드는 명시적 `"on"` 일 때만(결정 9 와 같은 이유).
5. **웹 터미널(`web_terminal.rs`)** 도 홀더로 보낼지. 제안: 범위 밖, 별도 과제.
6. **꺼진 사이 끝난 터미널 표시**: tail + "종료됨" 배너 후 사용자가 닫거나 재시작(제안) vs
   자동으로 같은 폴더에 새 셸.
7. **하네스(devreview) PTY 의 수명**: 창과 함께 끝남 유지(제안) vs 홀더에 남김.
8. **앱이 꺼진 동안의 ctl / `agent wait` 의미**: 브리지가 없으니 ctl 은 대기·재시도만 가능.
   홀더 소켓을 ctl 에 열지는 않는다(제안).
9. **dev 홀더 정책**: 재빌드 때마다 홀더 바이너리가 바뀐다. dev 에서는 앱 종료 시 홀더도
   함께 끝내는 옵션을 기본으로 둘지(제안: dev 는 `kill_all` 기본).
10. **링 크기 설정**: 1 MiB 고정(제안) vs 설정.
