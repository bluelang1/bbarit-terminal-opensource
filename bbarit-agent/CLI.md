# bbarit-agent — 코드에이전트/프로그램에서 부리는 법

빠릿에이전트를 사람이 아닌 **프로그램(Claude Code, Codex, 스크립트)** 이 제어할 때의 공식 인터페이스. 이 문서 하나만 보면 된다.

## 빌드 / 위치

```bash
cd bbarit-agent && cargo build          # → target/debug/bbarit
```

앱에 내장된 릴리즈 빌드는 BBARIT Terminal이 스폰한다. 독립 실행 시에는 항상 `BBARIT_AGENT_MODE=1`을 붙인다.

## 1) 원샷 실행 — `--print` (가장 간단)

```bash
BBARIT_AGENT_MODE=1 bbarit --print --no-pick --no-session \
  --provider anthropic --model claude-sonnet-5 \
  "이 저장소의 빌드 방법을 한 줄로 답해"
```

**stdout/stderr 계약 (파이프 시):**

- **stdout** — 최종 어시스턴트 답변 **한 덩어리만**. 내레이션·thinking· `⚙ tool` 활동 라인은 절대 섞이지 않는다.
- **stderr** — 라이브 토큰 스트림과 활동 라인 (진행 관찰용, 파싱 금지).

따라서 소비자는 `2>/dev/null` 후 stdout 전체를 답변으로 쓰면 된다.

주요 플래그: `--no-pick`(폴더 픽커 생략) · `--no-session`(세션 파일 안 남김) · `--no-tools` · `-t bash,read,edit`(도구 화이트리스트) · `--thinking low|medium|high` · `--persona <id>` · `--append-system-prompt "..."`.

## 2) 구조화 이벤트 — `--mode json`

한 턴을 실행하며 stdout에 JSON Lines를 흘린다:

```
{"type":"session","id":...,"cwd":...}
{"type":"agent_start"} {"type":"turn_start"}
{"type":"message_update","delta":{"type":"text_delta","text":"..."}}   # --stream 시
{"type":"message_end","message":{...}}                                  # user/assistant/tool 각각
{"type":"turn_end","message":<최종 메시지>,"toolResults":[...]}
{"type":"agent_end","messages":[전체 히스토리]}
```

```bash
BBARIT_AGENT_MODE=1 bbarit --mode json --no-pick --no-session "task..."
```

## 3) 장수명 세션 — `--mode rpc`

stdin/stdout으로 JSON 프레임을 주고받는 양방향 모드. BBARIT Terminal의 AgentPanel이 쓰는 것과 동일한 프로토콜. 요청은 `{"type":"...","id":<임의>}`, 응답은 같은 `id`가 달려 온다.

| type | 설명 |
| --- | --- |
| `prompt` | `{"message":"..."}` 턴 실행 (진행 이벤트 스트림) |
| `steer` / `follow_up` | 실행 중 턴에 지시 주입 / 다음 턴 예약 |
| `abort` | 실행 중 턴 취소 (stdin에서 즉시 처리됨) |
| `get_state` / `get_messages` / `get_session_stats` | 상태 조회 |
| `set_model` / `cycle_model` / `get_available_models` | 모델 제어 |
| `set_thinking_level` / `cycle_thinking_level` | thinking 제어 |
| `compact` / `set_auto_compaction` / `set_auto_retry` | 컨텍스트 관리 |
| `bash` | 에이전트 cwd에서 셸 실행 |
| `new_session` / `switch_session` / `fork` / `clone` | 세션 관리 |
| `get_last_assistant_text` | 마지막 답변 텍스트만 |
| `export_html` | 세션을 HTML로 내보내기 |

## 4) 병렬 서브에이전트 — `--orchestrate`

```bash
BBARIT_AGENT_MODE=1 bbarit --orchestrate "task A" "task B" "task C"
```

각 positional input을 독립 프로세스 서브에이전트로 병렬 실행하고 결과를 모은다.

## 환경 변수

| 변수 | 의미 |
| --- | --- |
| `BBARIT_AGENT_MODE=1` | 에이전트 모드 (독립 실행 시 필수) |
| `BBARIT_SUBAGENT=1` | 서브에이전트 표시 — auto-memory 추출 등 재귀 동작 차단 |
| `BBARIT_AUTO_CONTEXT=0` | 턴 시작 auto-RAG(코드 컨텍스트 주입) 비활성 — 코드와 무관한 작업이면 끄는 게 빠르다 |
| `BBARIT_AUTO_MEMORY=0` | auto-memory recall/extract 비활성 |
| `BBARIT_PERSONA=<id>` | 시작 페르소나 지정 |

## 성능 메모

- 코드 컨텍스트 인덱스(semble)는 **프로세스 전역 캐시**다. 시작 시 백그라운드로 프리웜되고, 파일 변경 도구 실행 후 60초 디바운스로 백그라운드 재빌드된다. 턴을 블로킹하지 않는다 — 첫 턴은 인덱스가 준비 전이면 컨텍스트 없이 나간다.
- 원샷 `--print` 프로세스는 인덱스가 준비되기 전에 끝나는 게 보통이므로, 코드 검색이 필요하면 모델이 `code_search` 도구를 호출한다(이때만 블로킹 빌드).

## 레이턴시 스모크 테스트

```bash
time (BBARIT_AGENT_MODE=1 target/debug/bbarit --print --no-pick --no-session \
  "Reply with exactly: pong" 2>/dev/null)
# 기대: stdout == "pong", 벽시계 ≈ LLM 왕복 (~3s), CPU < 2s
```