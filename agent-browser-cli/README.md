# agent-browser-cli

아무 웹 프로젝트에서나 브라우저를 CLI로 띄우고 확인하는 독립 도구입니다.
BBARIT, Tauri, MCP 서버에 의존하지 않고 Playwright만 사용합니다.

BBARIT 안에서는 이 폴더를 `browser` 프로젝트 종류로 사용합니다. 에이전트용 내장 브라우저는 가짜 미리보기가 아니라 Chrome 렌더링과 Chrome DevTools Protocol 입력을 기준으로 동작해야 합니다.

## Install

로컬 개발:

```bash
cd agent-browser-cli
npm install
npx playwright install chromium
npm link
```

다른 프로젝트에서:

```bash
agent-browser check http://127.0.0.1:5175
agent-browser open http://127.0.0.1:3000
```

## Commands

- `agent-browser check [url]`: 페이지를 열고 리포트, 스크린샷, 텍스트, 콘솔 로그를 저장합니다.
- `agent-browser open [url]`: 실제 브라우저 창을 띄웁니다.
- `agent-browser screenshot [url] --file shot.png`: 스크린샷을 저장합니다.
- `agent-browser text [url]`: body 텍스트를 출력합니다.
- `agent-browser eval [url] --code "document.title"`: 페이지 안에서 JS를 실행합니다.
- `agent-browser servers`: 흔한 개발 포트에서 실행 중인 로컬 서버를 찾습니다.
- `agent-browser doctor`: Playwright/Chromium 실행 가능 여부를 확인합니다.
- `agent-browser smoke`: 임시 페이지를 띄워 end-to-end 검증합니다.

BBARIT Terminal 안의 내장 브라우저를 제어할 때는 상위 프로젝트에서 `npm run browser:*`를 사용합니다. 이 명령은 이 폴더의 `bin/bbarit-browser-control.mjs`로 연결됩니다. 내장 브라우저의 탭은 UI 상태만 흉내낸 것이 아니라 Tauri WebView/WebView2의 실제 브라우저 탭입니다.

최신 내장 BBARIT Browser CLI 사용법은 `agent-browser-cli/CLI.md` 한 곳에만 유지합니다. 앱 안에서는 BBARIT Browser 툴바의 문서 버튼 또는 `npm run browser -- guide`로 같은 문서를 다시 볼 수 있습니다.

`browser:open`은 `--project`를 생략하면 기본으로 이 `agent-browser-cli` 폴더를 왼쪽 파일 트리에 보여줍니다.

URL을 생략하면 `5173, 5175, 3000, 4173, 8080` 같은 흔한 개발 포트를 자동 탐색합니다.

내장 브라우저는 Tauri WebView/WebView2 브라우저라서 별도 Chromium 런타임 설치나 외부 데스크톱 Chrome 창이 필요 없습니다. BBARIT Browser 창 안에서 렌더링하며, 에이전트 제어용 CDP는 `127.0.0.1:9666`에 노출됩니다.

## Screen-First Browser Development

BBARIT 브라우저 프로젝트는 에디터 상상도가 아니라 실제 브라우저 화면을 기준으로 개발합니다. 기본 루프는 항상 `open -> wait -> inspect -> edit -> screenshot`입니다.

```bash
npm run browser:open -- --url "file://$PWD/agent-browser-cli/examples/screen-first-landing/index.html" --project "$PWD" --terminal 1 --packets 1
npm run browser -- status
npm run browser -- wait --selector h1
npm run browser -- text --selector body --file .octo-tmp/screen-first-landing/body.txt
npm run browser -- screenshot --file .octo-tmp/screen-first-landing/screen.png
```

화면 우선 개발 규칙:

- 브라우저 화면, DOM 텍스트, 콘솔, 네트워크, 스크린샷을 확인한 뒤 수정합니다.
- `click-selector`, `type-selector`, `wait`, `box`, `text`, `screenshot`을 좌표 기반 조작보다 먼저 씁니다.
- 브라우저 프로젝트는 파일 트리와 터미널을 켜둔 상태가 기본입니다.
- 세션 요청 분석은 `--packets 1`, `packets`, `packet-body`, `har`로 브라우저 안에서 확인합니다.
- 완료 전에는 데스크톱과 모바일 폭을 모두 `resize` 후 스크린샷으로 확인합니다.

새 예제 프로젝트:

```bash
agent-browser-cli/examples/screen-first-landing/
├── index.html
├── AGENTS.md
└── CLAUDE.md
```

## Agent Workflow

```bash
# 1. 앱 개발 서버 실행
npm run dev

# 2. 브라우저 검증
agent-browser check --out .agent-browser

# 3. 산출물 확인
cat .agent-browser/summary.json
open .agent-browser/screenshot.png
```

기본 산출물:

- `.agent-browser/summary.json`
- `.agent-browser/screenshot.png`
- `.agent-browser/text.txt`
- `.agent-browser/page.html`
- `.agent-browser/console.json`

## Options

```bash
--out <dir>              산출물 디렉토리
--file <path>            screenshot/text 출력 파일
--timeout-ms <number>    navigation timeout
--wait-ms <number>       로드 이후 추가 대기
--viewport <WxH>         예: 1440x980
--headless               창 없이 실행
--headed                 실제 창 표시
--fail-on-console        console error가 있으면 실패 처리
--json                   JSON만 출력
```

## Examples

```bash
agent-browser check http://localhost:5175 --fail-on-console
agent-browser check http://localhost:3000 --headed --wait-ms 1500
agent-browser text http://localhost:5175 --file page.txt
agent-browser eval http://localhost:5175 --code "document.querySelector('h1')?.innerText"
agent-browser open http://localhost:5175 --keep-open-ms 30000
```

## Why

코드 에이전트에게 필요한 것은 “브라우저가 진짜로 열렸고, 화면과 콘솔과 텍스트가 이렇다”는 재현 가능한 증거입니다.
이 CLI는 어느 저장소에서든 일반 터미널 명령만으로 그 증거를 만들도록 설계했습니다.
