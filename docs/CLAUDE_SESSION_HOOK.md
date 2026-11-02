# Claude 세션 ID 훅 (정확한 --resume)

작성일 2026-11-03. 상태: 구현됨, 실기 확인 전. 같은 PR 에서 [OSC 133](SHELL_PROMPT_OSC133.md) 도 한다.

## 배경

Claude 탭은 두 종류다.

- "Claude 새 대화" 탭: 앱이 uuid 를 만들어 `--session-id <id>` 로 띄우고, 다음부터 `--resume <id>`.
  `TerminalInstance.claudeSessionId` 에 저장된다(`src/App.tsx` 의 `freshClaudeSession`).
- 일반 Claude 탭: id 가 없다. `src/terminal/claudeSessionDir.ts` 가 `~/.claude/projects/<cwd 인코딩>/`
  에 `*.jsonl` 이 있으면 `--continue` 를 붙인다. `--continue` 는 "그 디렉터리의 가장 최근 세션"
  이라, 같은 프로젝트에 탭이 둘이면 다른 탭의 대화를 이어받는다. `CLAUDE_CONFIG_DIR` 로
  옮긴 세션은 못 찾는다. `/clear` 뒤에 바뀐 id 도 모른다.

Claude Code 는 `SessionStart` 훅으로 `session_id`, `transcript_path`, `source`(startup |
resume | clear | compact) 를 알려 준다. 훅이 이 값을 앱에 보고하면 **모든** Claude 탭이 자기
세션 id 를 알게 되고, 다음 실행은 항상 `--resume <id>` 가 된다. herdr 의
`herdr-agent-state.sh` + `pane.report_agent_session` 과 같은 방식이다.

## 설계

### 1. 훅 설치: 사용자 설정을 건드리지 않는다

`~/.claude/settings.json` 을 편집하지 않는다. Claude Code 의 `--settings <file>` 플래그로
앱이 번들한 설정 파일을 추가로 읽게 한다(`claude --help`: "--settings ... Load additional
settings from a JSON file"). Claude 탭 실행 인자에만 붙는다.

- 번들 파일: `src-tauri/resources/claude-hooks/bbarit-session.json`

      {
        "hooks": {
          "SessionStart": [
            { "matcher": "startup|resume|clear|compact",
              "hooks": [ { "type": "command", "command": "sh \"$BBARIT_CLAUDE_HOOK\"" } ] }
          ]
        }
      }

- 훅 스크립트: `src-tauri/resources/claude-hooks/session-start.sh`. stdin 의 JSON 에서
  `session_id`, `transcript_path`, `source`, `cwd` 를 꺼내 로컬 브리지에 POST 한다.
  `agent_id` 가 있으면(서브에이전트) 아무것도 안 한다. `node`·`python` 에 의존하지 않고
  `curl` 만 쓴다. 두 파일 모두 `tauri.conf.json` `resources` 와 `opensource/manifest.json`
  에 추가한다. 실패해도(브리지 없음, curl 없음) 조용히 0 으로 끝난다. Claude 세션을 막으면
  안 된다.

      curl -s -m 2 -X POST "http://127.0.0.1:${BBARIT_BRIDGE_PORT}/api/claude-session" \
        -H 'Content-Type: application/json' \
        -d "{\"terminalId\":\"$BBARIT_TERMINAL_ID\",\"sessionId\":\"$sid\",\"transcriptPath\":\"$tp\",\"source\":\"$src\"}"

  JSON 파싱은 `sed` 로 키별 값을 뽑는다(값은 uuid·경로·단어라 단순 정규식으로 충분).
  Windows 는 이번 범위에서 훅을 붙이지 않는다(`sh` 없음). 실기 검증도 하지 않는다.

### 2. PTY 환경 (create_shell, create_cli_shell **둘 다**)

- `BBARIT_TERMINAL_ID=<terminalId>`: 훅이 어느 탭인지 알리는 데 쓴다. 지금은 스코프 토큰만
  있고 터미널 id 환경변수가 없다.
- `BBARIT_BRIDGE_PORT=<19980|19981>`: `browser_bridge::BRIDGE_PORT` 값.
- `BBARIT_CLAUDE_HOOK=<리소스 절대경로>/session-start.sh`.
- 상속된 Claude 마커 제거: `CLAUDECODE` 는 이미 지운다. `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_ENTRYPOINT` 도 지운다. 개발 앱을 Claude Code 안에서 띄우면 탭의 Claude 가
  "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" 를 내고 세션을
  저장하지 않는다(2026-11-02 실기에서 확인). 이러면 훅으로 받은 id 로도 resume 이 안 된다.

### 3. 브리지 엔드포인트: `POST /api/claude-session` (`src-tauri/src/browser_bridge.rs`)

- 바디 `{ terminalId, sessionId, transcriptPath?, source }`. `sessionId` 는 uuid 형식만 받고,
  `terminalId` 는 비어 있으면 거부한다.
- `with_local_guard` 안에 있으므로 Origin 없는 네이티브 호출만 통과한다(curl 은 Origin 을
  안 보낸다).
- 처리: Tauri 이벤트 `claude-session-reported` 를 payload 그대로 emit 한다. 상태는 프런트가
  갖는다. 응답 `{ ok: true }`.

### 4. 프런트 (`src/App.tsx`, `src/terminal/claudeSessionDir.ts`)

- `claude-session-reported` 리스너: 해당 `terminalId` 의 `TerminalInstance.claudeSessionId`
  를 `sessionId` 로 바꾸고 기존 저장 경로(`:1836` 부근)로 영속한다. 모르는 terminalId 는
  무시한다. `source === 'clear'` 로 id 가 바뀌는 경우도 같은 처리다.
- `resolveClaudeSessionArgs` 는 그대로 둔다. id 가 있으면 이미 `--resume`(jsonl 있음) /
  `--session-id`(없음) 로 분기한다. 훅이 준 id 는 항상 jsonl 이 있으므로 `--resume` 이 된다.
  단, `CLAUDE_CONFIG_DIR` 가 설정돼 있으면 탐색 경로를 그 밑으로 바꾼다(`~/.claude` 대신).
  환경변수는 `get_env`(없으면 새 Tauri 커맨드 `read_env_var`)로 읽는다.
- Claude 실행 인자에 `--settings "<번들 json 경로>"` 를 붙인다(`src/XTerminal.tsx` claude
  분기, `--model` 옆). 사용자가 이미 `--settings` 를 넣었으면 붙이지 않는다.
- 탭 이름은 바꾸지 않는다. "Claude 새 대화" 흐름도 그대로다(uuid 를 앱이 만들고, 훅 보고가
  오면 같은 값이라 변화 없음).

### 5. 바꾸지 않는 것

- `~/.claude/settings.json`, 프로젝트 `.claude/settings*.json`.
- `--continue` 폴백. 훅 보고가 한 번도 없던 탭(구버전 Claude, Windows)은 지금과 같다.
- ssh:// 프로젝트 분기.

## 검증

- 셸 테스트: `scripts/` 가 아니라 리소스 폴더의 `session-start.sh` 를 `echo '{"session_id":"...","transcript_path":"/x/y.jsonl","source":"startup","cwd":"/p"}' | BBARIT_BRIDGE_PORT=1 BBARIT_TERMINAL_ID=t sh session-start.sh` 로 돌려 exit 0 과 curl 호출 인자를 확인하는 vitest(child_process 로 실행) 1개. `agent_id` 가 있으면 curl 을 안 부르는 것도.
- Rust: 엔드포인트 바디 검증 단위 테스트(uuid 아님 → 400, terminalId 없음 → 400).
- 프런트: 리스너가 `claudeSessionId` 를 바꾸고 영속하는지 순수 함수(`applyReportedClaudeSession(terminals, payload)`)로 빼서 테스트. `CLAUDE_CONFIG_DIR` 경로 분기 테스트.
- 실기(macOS 개발 빌드): 일반 Claude 탭을 열고 `claude` 가 뜬 뒤 `~/.config/octo` 에 저장된
  터미널의 `claudeSessionId` 가 채워지는지(또는 `ctl term list` 확장으로 노출), 탭을 닫고
  같은 프로젝트에서 터미널을 재시작했을 때 명령줄이 `--resume <그 id>` 인지, `/clear` 뒤 id 가
  갱신되는지.

## 구현 메모

설계와 다르거나 설계가 정하지 않은 부분만 적는다.

- **훅 명령**: `sh "$BBARIT_CLAUDE_HOOK"` 대신 `[ -z "$BBARIT_CLAUDE_HOOK" ] || sh "$BBARIT_CLAUDE_HOOK"`.
  변수가 없는 PTY(리소스를 못 찾음, 구버전 앱이 만든 PTY)에서도 훅이 0 으로 끝난다.
- **스크립트 세부**: stdin 을 `sed` 로 한 줄로 합친 뒤 키별로 뽑는다(여러 줄 JSON 도 처리).
  `"agent_id"` 키가 있으면 끝낸다. `BBARIT_BRIDGE_PORT`/`BBARIT_TERMINAL_ID`/`session_id` 가 없으면
  curl 을 부르지 않는다. curl 출력은 `-o /dev/null` 과 리다이렉트로 버린다: SessionStart 훅의
  stdout 은 대화 컨텍스트에 들어가기 때문이다.
- **리소스 경로**: `claude_hooks_dir` 가 `resources/claude-hooks` 를 `BaseDirectory::Resource` 로
  찾고, 개발 빌드는 `CARGO_MANIFEST_DIR/resources/claude-hooks` 도 본다. 두 파일이 다 있어야 쓴다.
  `--settings` 경로는 새 커맨드 `claude_hook_settings_path`(Windows 는 항상 `null`)로 받는다.
- **PTY 환경**: 두 셸 생성 함수가 같은 헬퍼 `apply_bbarit_terminal_env` 를 부른다. 리소스를 못
  찾으면 `BBARIT_CLAUDE_HOOK` 만 빠진다. 세 변수는 Windows 에도 들어간다(쓰는 곳 없음, 무해).
- **브리지 검증**: `terminalId` 는 비어 있지 않고 128 자 이하·제어문자 없음, `sessionId` 는 uuid,
  `transcriptPath` 는 4096 자 이하·제어문자 없음(빈 값은 생략), `source` 는 32 자 이하
  `[A-Za-z0-9_-]`(빈 값 허용). 잘못된 바디와 JSON 이 아닌 바디는 모두 400 이다(axum 기본 422 대신).
  emit 하는 payload 는 검증을 거친 값이다(`sessionId` 소문자화, 빈 `transcriptPath` 생략).
- **`read_env_var`**: 허용 목록(`CLAUDE_CONFIG_DIR`)만 읽는다. 웹뷰가 임의 환경변수(키 등)를 읽지
  못하게 하기 위해서다. 앱 프로세스 환경과 `~/.config/octo` env 파일만 본다. 셸 rc 에서만
  export 한 값은 보이지 않아 그때는 `~/.claude` 를 본다.
- **리스너 위치**: App 의 `claude-session-reported` 리스너는 하네스 창에서는 등록하지 않는다.
  하네스 창은 자기 projects 사본을 저장하므로 메인 창의 최신 상태를 덮어쓸 수 있다.
  `cliType === 'claude'` 인 탭에만 적용한다(셸 탭에서 손으로 띄운 claude 는 저장하지 않는다).
  순수 함수는 `src/terminal/claudeSessionReport.ts` 에 있다.
- **재시작 방지**: `claudeSessionId` 를 XTerminal 시작 effect 의 의존성에서 빼고 ref 로 읽는다.
  훅 보고로 id 가 바뀔 때 effect 가 다시 돌면 실행 중인 탭이 재초기화되기 때문이다. 지금까지
  id 는 탭 생성 때만 정해져서 동작 차이는 없다.
- **`--settings` 조건**: 로컬 작업 폴더이고 Windows 가 아닐 때만 붙인다(ssh:// 은 원격에서 그
  경로가 없다). 사용자가 `--settings` 를 넣었으면 붙이지 않는다.
- **id 출처와 `resumeLastSession`** (설계 변경): `TerminalInstance.claudeSessionSource` 에
  `'app'`("Claude 새 대화"가 만든 id) / `'hook'`(훅이 보고한 id)을 저장한다. `'hook'` id 는
  `resumeLastSession` 이 켜져 있을 때만 `--resume`/`--session-id` 가 되고, 꺼져 있으면 플래그 없이
  새 세션으로 띄운다(id 없는 일반 탭과 같다). `'app'` id 는 지금처럼 항상 이어간다. 출처가 없는
  예전 저장값은 `'app'` 으로 읽는다. "Claude 새 대화" 탭에 `/clear` 로 새 id 가 보고돼도 `'app'` 을
  유지한다(전용 탭 성격 유지). 탭 이름 번호 계산도 `'app'` 탭만 "새 대화" 로 센다.
- 실기 확인(macOS 개발 빌드)은 하지 않았다. 단위 테스트와 빌드·린트·감사만 통과.
