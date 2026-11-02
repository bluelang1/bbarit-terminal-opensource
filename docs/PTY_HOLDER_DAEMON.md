# PTY 홀더 데몬: 앱을 꺼도 터미널이 살아 있게

작성일 2026-11-03. 상태: **설계 초안, 구현 전.** 결정 필요 항목은 맨 끝에 있다.

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
| PTY 생성 | `create_shell`(`main.rs:3361`), `create_cli_shell`(`:4928`) | `portable-pty 0.8`, 환경 구성이 두 함수에 중복 |
| 읽기 | `spawn_utf8_reader_thread`(`:2686`) → `sync_channel(1024)` + `output_buffer`(768 KiB, 앞 절반 버림) | `read_from_pty` 가 **pull** 로 64 KiB 씩 비움(`:3616`). 이벤트 없음 |
| 쓰기·크기 | `write_to_pty`(`:3596`), `resize_pty`(`:3648`) | |
| 종료 | `close_pty`(`:4237`): `kill_process_tree` → `child.kill` → `sweep_scope` | `RunEvent::Exit` 에서 전체 스코프 스윕(`:4044`) |
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
    함께 정리될 수 있다. launchd 실패 시 `setsid` + 분리 spawn 으로 폴백한다.
  - Linux: `systemd-run --user --collect --service-type=exec -p KillMode=process`. 실패 시
    `setsid` 폴백.
  - 홀더는 자기 pid 와 소켓 경로를 `<run>/pty-holder.<instance>.json` 에 쓴다.
- 홀더 종료 조건: 터미널이 하나도 없고 클라이언트도 없이 60 초가 지나면 스스로 끝난다.
  DRAIN 을 받으면 새 터미널을 거부하고 마지막 터미널이 끝날 때 종료한다.
- 홀더가 죽으면 그 안의 터미널은 죽는다(홀더가 부모다). 앱은 다음 연결에서 사라진 터미널을
  `holder_lost` 로 표시하고 "같은 폴더에서 다시 시작" 을 제안한다(기존 재시작 경로).
- 재부팅 뒤도 같다. 저장된 프로젝트의 터미널은 지금처럼 다시 만든다.

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
  실행은 소켓 이름으로 분리된다).

### 3.3 프로토콜 (herdr `holder_proto.rs` 를 단순화)

프레임: `[kind u8][handle u32 LE][len u32 LE][payload]`, payload 최대 16 MiB. 제어 프레임은
JSON, 데이터 프레임은 원시 바이트. `handle` 은 홀더가 배정하는 u32 이고, 빠릿 터미널 id
(문자열)는 SPAWN/WELCOME 의 JSON 안에서 `id` 로 대응한다.

| 방향 | kind | payload |
|---|---|---|
| app→holder | HELLO | `{version:1, client:"bbarit-app", pid, build:"1.1.60"}` |
| holder→app | WELCOME | `{version, instance, terminals:[{handle,id,cwd,pid,rows,cols,exited,exit_code,scope,started_at}]}` 이어서 터미널마다 TAIL |
| app→holder | SPAWN | `{id, program, args, cwd, env:{…}, rows, cols, scope}` (환경은 앱이 완성해서 보낸다) |
| holder→app | SPAWNED / SPAWN_FAILED | `{id, handle, pid}` / `{id, error}` |
| app→holder | INPUT(handle, bytes) | 터미널별 writer 스레드 큐로. 막힌 프로그램은 자기 스레드만 막는다 |
| holder→app | OUTPUT(handle, bytes) | |
| app→holder | RESIZE | `{rows, cols}` |
| app→holder | SIGNAL | `{sig:"TERM"|"KILL"|"HUP"|"INT"}`. 이미 거둔 터미널엔 보내지 않는다(pid 재사용 위험) |
| app→holder | RELEASE | 트리 kill + 스코프 스윕 + 제거. `close_pty` 가 이걸 보낸다 |
| holder→app | EXITED | `{code, signal}`. 거둔 뒤 200 ms 안에 남은 출력을 먼저 보낸다 |
| holder→app | TAIL(handle, bytes) | 재부착용 마지막 1 MiB |
| app→holder | GOODBYE | `{reason:"quit"|"handover"|"kill_all"}` |
| app→holder | DRAIN | 새 SPAWN 거부, 마지막 터미널 종료 시 홀더 종료 |
| 양방향 | PING/PONG | 10 초 간격, 30 초 무응답이면 연결 끊김으로 본다 |

흐름 제어: 클라이언트가 붙어 있을 때 보내지 못한 OUTPUT 이 8 MiB 를 넘으면 그 터미널의
pump 를 멈춘다(아무도 안 읽는 PTY 처럼 프로그램이 느려진다). **클라이언트가 없을 때는 멈추지
않고** tail 만 유지한다. 앱이 꺼진 사이 작업이 멈추면 안 되기 때문이다. 이 점이 herdr 와
다르다.

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
  tail 사본(768 KiB → 1 MiB 로 상향)에 넣는다. `read()` 는 그 채널을 비운다. 프런트가 보는
  동작(33 ms 폴링, 64 KiB 드레인, "PTY disconnected")이 지금과 같다.
- 선택: 설정 `terminal.ptyHolder: "off" | "on"`. 2단계까지 기본 `off`, 3단계에서 `on`.
  홀더 연결 실패(소켓 없음·버전 불일치·권한)는 **조용히 InProcess 로 폴백**하고 상태바에
  "터미널이 앱 안에서 실행 중" 을 표시한다.
- 환경 구성 함수 분리: `create_shell`/`create_cli_shell` 의 env 블록(PATH, nvm, `.env`,
  GH_TOKEN, `BBARIT_*`, Claude 마커 제거)을 `build_pty_env(...) -> Vec<(String,String)>` 로
  뽑아 두 백엔드가 공유한다. 이 리팩터링은 동작 변화가 없어야 하고 **1단계**에서 먼저 한다.

### 3.5 재부착 (앱 시작·재시작·업데이트 뒤)

1. 앱이 뜨면 `HolderBackend` 가 소켓을 찾아 HELLO. WELCOME 의 터미널 목록을
   `recoveredTerminals: Map<id, TerminalInfo>` 로 프런트에 넘긴다(새 커맨드 `pty_list_recovered`).
2. 프런트 `XTerminal` 초기화: 그 id 가 `recoveredTerminals` 에 있으면 `create_shell` 과 시작 명령
   주입을 **건너뛰고**, 기존 `restoredPty.ts` 경로(`check_pty_alive` → `read_pty_output_buffer`
   → `replayingOutput` 재생)로 화면을 복원한다. 이 경로는 팝아웃 재부착으로 이미 검증돼 있고,
   7501 재생 중 알림 억제도 이미 들어 있다.
   - `isRestored` 판정을 `!!terminal.lastWorkDir` 휴리스틱에서 "홀더에 살아 있음" 으로 바꾼다.
   - `deferStart`(비활성 복원 탭을 클릭 전까지 미룸)는 홀더 터미널에는 적용하지 않는다.
     이미 돌고 있으니 미룰 게 없다. 단 화면 재생은 탭 활성화 때 한다.
3. 저장된 프로젝트에 없는 홀더 터미널(프로젝트를 지웠거나 저장 전에 앱이 죽음)은 cwd 가
   일치하는 프로젝트에 "복구됨" 탭으로 붙이고, 없으면 "복구된 터미널" 가상 프로젝트에 보여
   준다. 자동으로 죽이지 않는다. 사용자가 닫으면 RELEASE 한다.
4. 7501 상태: 앱이 꺼진 동안의 전이는 못 본다. TAIL 재생이 마지막 보고를 복원하므로 탭 색은
   맞는다. 재생 중에는 알림이 나가지 않는다(`replayingOutput`). 재부착 직후 blocked 인 탭이
   있으면 한 번 요약 토스트("대기 중인 에이전트 N개")를 띄운다.
5. 에이전트 릴레이의 `agentLinks` 는 영속하지 않으므로 재부착 뒤 부모·자식 관계는 끊긴다.
   `agent wait` 는 계속 동작한다(상태 조회는 터미널 id 기준). 노트 전달만 멈춘다. 2차 과제로
   `agentLinks` 를 저장한다.

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
| **0** | `handleUpdate` 에 "작업 중 탭 N개" 확인 대화상자. 7501 상태로 바로 만든다 | PR 1개, 작음 | 없음. 홀더와 독립 |
| **1** | 리팩터링만: `PtyBackend` 트레이트 + `InProcessBackend`, `build_pty_env` 분리, 커맨드 함수는 백엔드에 위임. 동작 변화 0 | Rust ~600 줄, 테스트: env 빌더 스냅샷 | `create_cli_shell` 과의 중복 제거 중 누락 |
| **2** | 홀더 모드(`--mode pty-holder`), 프로토콜, `HolderBackend`, `setsid` 분리 spawn, 재부착(3.5), 종료 의미(3.6 의 quit/kill_all). 설정 기본 `off` | Rust ~2 k 줄, 프런트 ~300 줄. 통합 테스트: 홀더를 스레드로 띄워 `sh` 생성·입출력·tail·RELEASE | tail 재생 품질(TUI 전체화면), 느린 클라이언트 백프레셔 |
| **3** | launchd/systemd 등록, 업데이트 handover + DRAIN + 다중 홀더, 복구 탭 UI, 기본 `on` | Rust ~700 줄 | launchd 권한·coalition 실기 검증 |
| **4** | Windows 홀더 | 별도 설계 | ConPTY 소유권 이전 |

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
5. **웹 터미널(`web_terminal.rs`)** 도 홀더로 보낼지. 제안: 범위 밖, 별도 과제.
