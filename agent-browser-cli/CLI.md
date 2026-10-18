# BBARIT Browser CLI

이 파일이 내장 BBARIT Browser CLI 사용법의 기준 문서입니다. `AGENTS.md`나 `CLAUDE.md`에는 명령 목록을 복붙하지 말고 이 파일 위치만 안내합니다.

## 위치

- 기준 문서: `agent-browser-cli/CLI.md`
- CLI 엔트리: `agent-browser-cli/bin/bbarit-browser-control.mjs`
- npm 스크립트: `npm run browser:open`, `npm run browser`, `npm run browser:assert`

## 기본 실행

```bash
npm run browser:open -- --url http://localhost:5175 --project "$PWD" --terminal 1 --tree 1 --packets 1
npm run browser -- status
npm run browser -- screenshot --file .octo-tmp/browser.png
npm run browser -- record-start --fps 2
npm run browser -- record-status
npm run browser -- record-stop --file .octo-tmp/browser-rec.mp4
npm run browser:assert
npm run browser:platform-audit
npm run browser:verify
npm run browser-agent:verify
npm run mac:browser-agent:report-check
```

BBARIT Browser는 **Tauri WebView/WebView2 내장 브라우저**입니다. 앱 안에서 직접 렌더링하며, 별도 데스크톱 Chrome 창은 띄우지 않습니다.

> 앱 UI: 툴바의 브라우저(🌐) 버튼은 이제 **에디터 임베드가 아니라 프로젝트별 별도 BBARIT Browser 창**(`/browser`)을 엽니다. 같은 프로젝트면 기존 창에 포커스합니다.

앱이 Tauri WebView/WebView2를 직접 내장하므로 별도 Chromium 런타임 다운로드, 외부/숨김 Chrome 프로세스, 전용 Chrome 프로필이 없습니다. `--chrome` 모드 선택도 없습니다. WebView 브라우저는 에이전트 제어용 CDP를 `127.0.0.1:9666`에 노출하며, CLI/에이전트가 여기에 attach합니다.

macOS와 Windows는 같은 React/Rust 브라우저 소스를 사용합니다. 별도 `BrowserPage.windows.tsx`나 `BrowserPage.macos.tsx` 같은 플랫폼별 브라우저 복사본을 만들지 않고, Tauri의 같은 `devUrl`/`frontendDist`에서 실행한 뒤 OS 네이티브 WebView 엔진만 macOS `WKWebView`, Windows `WebView2`로 분기합니다.

Windows 설치본은 `src-tauri/tauri.windows.conf.json`에서 `webviewInstallMode.type = "downloadBootstrapper"`를 사용합니다. 그래서 사용자의 Windows에 WebView2 런타임이 없으면 설치 과정에서 Microsoft WebView2 부트스트래퍼를 통해 런타임을 확보합니다.

## 런타임 검증

```bash
npm run browser:platform-audit
npm run browser:assert
npm run browser -- assert --url https://example.com --file .octo-tmp/browser-assert.json
npm run browser -- control-audit --url https://www.naver.com --query "빠릿 브라우저 테스트" --session naver-audit --file .octo-tmp/browser-control-audit.json
npm run browser:verify
npm run browser-agent:verify
npm run win:prereq
npm run win:install-prereq
npm run win:verify
npm run browser -- cleanup
```

`assert`는 WebView 내장 브라우저를 열고 에이전트 제어 표면 전체를 한 번에 감사합니다: DOM/네트워크 로딩 감사, 콘솔/예외/네트워크 패킷 관측 감사, exchange/HAR/composer/security 패킷 도구 감사, AutoResponder/breakpoint interception 감사, CDP 스크린샷 렌더링 감사, 뷰포트/터치/다크모드 에뮬레이션 감사, User-Agent/timezone 환경 제어 감사, 스토리지/쿠키 제어 감사, permission/geolocation 제어 감사, 다운로드 제어 감사, 클립보드 제어 감사, 네트워크 offline/throttle 제어 감사, 클릭/입력/폼/값입력/체크상태/포커스/붙여넣기/파일업로드/다이얼로그/포인터/HTML5 드래그드롭/키보드/스크롤 상호작용 감사, 탭 생성/전환/닫기 감사, back/forward/reload 히스토리 감사. 실패하면 non-zero로 종료합니다.

`about:blank`은 origin-bound API가 일부 비어 있어서 감사용으로 쓰지 않습니다. 기본 assert URL은 `https://example.com`입니다.

## 화면 녹화

`record-start`는 브라우저 화면 녹화를 시작합니다(`--fps 1~8`, 기본 2). 스크린샷 프레임 루프를 canvas + MediaRecorder로 인코딩하므로 macOS(WKWebView)와 Windows(WebView2)에서 같은 명령으로 동작하며, 컨테이너는 WebView가 지원하는 포맷(mp4 또는 webm)을 따릅니다. `record-status`는 진행 상태(프레임 수, 길이, mime)를 반환합니다. `record-stop`은 녹화를 끝내고 `--file` 경로에 비디오 파일을 저장합니다 — 확장자는 실제 컨테이너에 맞추는 것이 안전합니다(`record-stop` 출력의 `ext` 참고). 파일 쓰기는 30MB 상한이 있어 기본 비트레이트(4Mbps) 기준 약 60초 이내로 끊어 녹화합니다. 브라우저 툴바의 ⏺ Record 버튼도 같은 엔진을 사용하며, 정지 시 `<project>/.octo-tmp/browser-recordings/`에 저장합니다. 에이전트는 `browser` 도구의 passthrough로 `record-start`/`record-status`/`record-stop`을 그대로 사용할 수 있습니다.

스크린샷 렌더링 감사는 PNG를 직접 분석해 viewport 크기와 일치하는지, 비어 있거나 거의 단색/투명 화면이 아닌지 확인합니다. `Page.captureScreenshot`가 응답하지 않는 경우 DOM raster fallback으로 같은 viewport 크기의 PNG를 생성하므로, 스크린샷 실패가 뒤따르는 입력 CDP 제어를 멈추지 않습니다. 기본 색 다양성 기준은 `4`라서 `https://example.com`처럼 의도적으로 단순한 페이지도 통과하면서 완전한 빈 화면은 잡습니다. 필요하면 `--min-visual-colors <num>`으로 기준을 조정합니다.

DOM/네트워크 로딩 감사는 `body` 준비 상태, body text 길이, HTML 길이, 성공 응답 패킷, document 또는 same-host 패킷을 확인합니다. 필요하면 `--min-dom-text <num>`와 `--min-html-bytes <num>`로 기준을 조정합니다.

콘솔/패킷 관측 감사는 페이지 안에서 고유 marker를 가진 `console.log`, `console.warn`, `console.error`, 비동기 exception, same-origin `fetch`를 발생시키고 `console`, `network`, `packets` 표면이 각각 그 이벤트를 캡처하는지 확인합니다. 이 감사 전에 `clearNetwork()`는 화면 이벤트와 패킷 레코드를 모두 비워 깨끗한 캡처 기준을 보장합니다.

패킷 도구 감사는 관측 감사에서 잡힌 실제 request id로 `exchange`, `har`, `security`, `composer`를 호출합니다. `exchange`는 요청/응답 헤더와 body 조회, fetch/curl replay snippet을 반환하고, `har`는 HAR 1.2 형식으로 캡처된 레코드를 내보내며, `composer`는 Tauri HTTP 프록시로 CORS 제한 없이 임의 요청을 보냅니다. `security`는 캡처된 문서 응답 헤더, 콘솔 오류, 실패 네트워크, mixed content 같은 방어적 신호를 요약합니다.

Interception 감사는 `respond` 규칙으로 매칭 요청을 mock status/body로 fulfill하고, `breakpoint` 규칙으로 매칭 요청을 실제로 일시정지한 뒤 `breakpoint --resume`으로 이어서 완료되는지 확인합니다. Fetch interception은 평소에는 꺼져 있고, 활성 규칙이 있을 때만 켜지며 매칭되지 않는 요청은 즉시 통과합니다.

뷰포트 에뮬레이션 감사는 CDP device metrics override로 모바일 크기, DPR, 터치, 다크모드 media query를 적용하고 `innerWidth`, `innerHeight`, `devicePixelRatio`, `navigator.maxTouchPoints`, `matchMedia` 결과를 확인한 뒤 데스크톱 크기로 복원합니다.

환경 제어 감사는 User-Agent override가 `navigator.userAgent`에 실제 반영되는지 확인하고 기본 UA로 복구한 뒤, timezone override가 `Intl.DateTimeFormat().resolvedOptions().timeZone`에 반영되고 다시 기본 timezone으로 복구되는지 확인합니다.

권한 제어 감사는 현재 origin에서 permission override를 초기화한 뒤 `geolocation` 권한을 부여하고 CDP geolocation override를 적용합니다. 이후 페이지 내부의 `navigator.geolocation.getCurrentPosition()`이 요청한 좌표를 실제로 반환하는지 확인하고 permission override를 다시 초기화합니다.

쿠키 제어 감사는 현재 origin에 고유 쿠키를 CDP로 직접 설정하고 `cookies --include-secrets` 표면에서 값이 보이는지 확인한 뒤, 같은 쿠키를 삭제해 더 이상 남지 않는지 확인합니다.

다운로드 감사는 전용 다운로드 폴더를 지정하고, 페이지 안에서 Blob 다운로드를 발생시킨 뒤 Browser download event, 완료 상태, suggested filename, 실제 파일 존재와 내용을 모두 확인합니다.

클립보드 감사는 page-native clipboard API가 focus 제약으로 막히는 상황까지 포함해 검증합니다. BBARIT Browser는 가능한 경우 `navigator.clipboard`를 쓰고, 실패하면 Tauri 시스템 클립보드로 fallback합니다. 감사는 쓰기/읽기, 클립보드 텍스트를 selector에 붙여넣기, selector 텍스트를 다시 클립보드로 복사하기를 확인합니다.

네트워크 상태 감사는 CDP 네트워크 에뮬레이션으로 현재 탭을 오프라인으로 만들고 fetch 실패를 확인한 뒤, 온라인으로 복구해 같은 페이지 fetch가 다시 성공하는지 확인합니다.

상호작용 감사는 페이지에 임시 버튼과 입력창을 만들고, CDP mouse event와 text insertion으로 실제 click/input 이벤트가 DOM에 반영되는지 확인한 뒤 테스트 노드를 제거합니다. 폼 감사는 textarea, contenteditable, select 제어가 값과 input/change 이벤트를 올바르게 바꾸는지 확인합니다. 값입력 감사는 range, number, date, color input을 직접 설정하고 input/change 이벤트와 최종 값을 확인합니다. 체크상태 감사는 checkbox, radio, ARIA switch를 원하는 checked 상태로 맞추고 input/change 이벤트를 확인합니다. 포커스/붙여넣기 감사는 focus/focusin 이벤트, textarea/contenteditable paste 이벤트, clipboardData, input 이벤트, 최종 값을 확인합니다. 파일 업로드 감사는 `input[type=file]`에 실제 로컬 파일을 주입하고 change 이벤트, 파일명, 크기를 확인합니다. 다이얼로그 감사는 prompt를 입력값으로 accept하고 confirm을 dismiss해서 alert 계열 JS 다이얼로그가 컨트롤 루프를 막지 않는지 확인합니다. 포인터 감사는 hover, right-click context menu, double-click, drag-like mouse move가 실제 DOM 이벤트로 들어오는지 확인합니다. HTML5 드래그드롭 감사는 `DataTransfer`와 `dragstart/dragenter/dragover/drop/dragend` 이벤트, drop payload를 확인합니다. 키보드 감사는 Arrow/Home/End/Backspace/Delete 같은 실제 key event가 입력값과 커서 위치를 올바르게 바꾸는지 확인합니다. 스크롤 감사는 휠 명령이 실제 scrollTop 변화를 만들고 오프스크린 렌더러 프레임도 갱신되는지 확인합니다. 탭 감사는 `data:` 페이지를 새 탭으로 열고, 활성 탭 전환과 닫기 후 목록 복원을 확인합니다.

히스토리 감사는 같은 렌더러 세션에서 두 URL을 순서대로 열고, `Page.getNavigationHistory`와 현재 URL을 기준으로 `back`, `forward`, `reload`가 올바른 entry를 유지하거나 이동하는지 확인합니다.

`control-audit`는 네이버처럼 복잡한 실제 사이트에서 에이전트가 브라우저를 끝까지 제어할 수 있는지 확인하는 실사용 감사입니다. 기본값은 `https://www.naver.com` 기준으로 검색 입력칸 찾기, 실제 포인터 클릭, 한글 텍스트 입력, 검색 버튼 클릭 또는 Enter 키 입력, 뒤로가기/앞으로가기, 외부 링크 또는 새 탭 링크 클릭, 새 탭 세션 유지까지 한 번에 검증합니다. 페이지에 보이는 외부/새 탭 링크가 없으면 감사 전용 링크를 DOM에 잠시 추가해 `https://example.com/` 새 탭과 세션 브릿지를 결정적으로 검증합니다. 다른 사이트는 `--input-selector`, `--submit-selector`, `--external-selector`, `--external-url`, `--query`로 같은 흐름을 지정합니다. 실패하면 JSON 리포트를 먼저 쓰고 non-zero로 종료합니다.

`browser:platform-audit`는 런타임 감사 전에 macOS/Windows 공통 코드 경로가 유지되는지 정적으로 확인합니다. 단일 브라우저 소스/동일 frontend entry, 엔진 라벨(WebView2/WKWebView), 세션 유지, Windows 경로 정규화, 네이티브 WebView popup/외부링크 브릿지, 문서/스크립트 게이트를 검사하고 `.octo-tmp/browser-platform-audit.json`에 결과를 씁니다.

`browser:verify`는 macOS와 Windows에서 같은 검증 게이트로 사용합니다. 내부적으로 `browser:platform-audit`, `browser:assert`, `browser:control-audit`를 순서대로 실행하며, Windows에서는 WebView2, macOS에서는 WKWebView 기반 내장 브라우저가 같은 CLI 제어 표면을 통과해야 성공합니다.

브라우저, 빠릿에이전트, 탭/세션, 외부 링크/새 창, 뒤로가기/앞으로가기, WebView/WebView2 관련 변경은 Windows 실기 검증이 필수입니다. macOS에서 통과했더라도 Windows에서 `npm run win:verify` 전체 리포트와 `npm run win:browser-agent:verify` 브라우저/에이전트 리포트가 없으면 Windows 검증 완료로 보지 않습니다.

`browser-agent:verify`는 현재 OS에서 개발 앱이 꺼져 있으면 `tauri:dev`를 백그라운드로 띄운 뒤, 플랫폼 감사, WebView 제어 감사, 네이버 실사용 제어 감사, 빠릿에이전트 브라우저 단위 테스트, 브라우저 통합 Vitest, 프론트엔드 빌드를 실행하고 OS별 리포트를 남깁니다. 리포트를 쓴 직후 `browser-agent-report-check`도 자동 실행하므로, 리포트 판정까지 통과해야 `verify`가 성공합니다. macOS는 `.octo-tmp/mac-browser-agent-verify.json`, Windows는 `.octo-tmp/win-browser-agent-verify.json`을 씁니다.

`win:verify`는 Windows 최종 전체 검증입니다. 내부에서 `win:browser-agent:verify`를 먼저 돌린 뒤 frontend lint, 전체 Vitest, UI mojibake 검사, app bootstrap smoke, bbarit-agent Rust 테스트, Tauri Rust 테스트를 실행하고 `.octo-tmp/win-full-verify.json`을 씁니다. Windows 동작 보장이나 릴리즈 판단은 이 리포트까지 있어야 합니다.

Windows ARM64(Parallels Windows 11 ARM 등)에서는 GUI 검증 전에 Visual Studio Build Tools의 `MSVC v143 - VS 2022 C++ ARM64/ARM64EC build tools`와 Windows 11 SDK가 필요합니다. `npm run win:prereq`는 이 조건만 빠르게 확인하고 `.octo-tmp/win-prereq.json`을 씁니다. 누락되면 검증기는 Tauri dev를 길게 빌드하지 않고 `Hostarm64\arm64\link.exe` 또는 `Hostx64\arm64\link.exe`, `lib\arm64\msvcrt.lib`, `um\arm64\kernel32.lib` 누락을 리포트합니다. Windows 안에서 자동 설치를 시도할 때는 `npm run win:install-prereq`를 실행합니다.

이 리포트에는 실행 결과뿐 아니라 git head/branch/dirty 상태, package/Tauri 버전, 공통 frontend entry, OS별 WebView 엔진, Windows WebView2 설치 모드, 검증 범위가 함께 들어갑니다. Windows 실기 검증을 공유할 때는 이 JSON 하나로 어떤 소스와 설정이 통과했는지 확인할 수 있습니다.

플랫폼을 강제해서 확인할 때는 아래 명령을 기준으로 씁니다.

```powershell
npm run mac:browser-agent:verify
npm run win:browser-agent:verify
```

Windows PowerShell 환경에서 직접 실행해야 할 때는 `npm run win:browser-agent:verify:ps1`도 사용할 수 있습니다. 이 명령은 같은 `scripts/browser-agent-verify.mjs` 검증기를 호출하는 래퍼라서 검증 기준이 갈라지지 않습니다.

검증 리포트만 다시 판정할 때는 아래 명령을 씁니다.

```powershell
npm run mac:browser-agent:report-check
npm run win:browser-agent:report-check
npm run browser-agent:compare-reports
npm run browser-agent:report-check:self-test
```

`win:browser-agent:report-check`는 Windows 실기 리포트에서 `ok: true`, 모든 단계 exit code 0, WebView2 런타임 발견, WebView2 bootstrapper 번들 설정, 네이버 제어 감사, 빠릿에이전트 브라우저 테스트 결과, 프론트엔드 빌드 실행 결과를 함께 확인합니다. 네이버 제어 감사는 열기, 로드, 스크린샷, 검색 입력 찾기, 입력, 제출, 뒤로가기, 앞으로가기, 외부 링크 찾기, 외부 링크/새 탭 열기, 세션 유지 단계가 모두 있어야 통과합니다. `browser-agent:compare-reports`는 macOS 리포트와 Windows 리포트를 각각 플랫폼 기준으로 검증한 뒤, 같은 git head, 같은 앱 버전, 같은 frontend entry에서 나온 결과인지도 검사합니다.

`mac:browser-agent:report-check`는 개발 중 빠른 macOS 확인을 위해 `--allow-skip-build`를 명시적으로 붙입니다. Windows 최종 판정과 `browser-agent:compare-reports`는 이 플래그를 쓰지 않으므로 빌드가 빠진 리포트는 실패합니다.

`browser-agent:report-check:self-test`는 report-check 도구 자체가 핵심 실패를 잡는지 확인합니다: WebView2 없는 Windows 리포트 실패, 빌드가 빠졌는데 명시 허용이 없는 리포트 실패, 외부 링크 감사가 빠진 리포트 실패, git head가 다른 macOS/Windows 비교 실패, 정상 macOS/Windows 비교 성공.

`cleanup`은 현재 CLI 라벨의 BBARIT Browser 창을 닫습니다.

## 화면 제어

```bash
npm run browser -- tabs
npm run browser -- new-tab https://example.com
npm run browser -- switch-tab <tab-id>
npm run browser -- close-tab <tab-id>
npm run browser -- navigate https://example.com
npm run browser -- back
npm run browser -- forward
npm run browser -- reload
npm run browser -- stop
npm run browser -- home
npm run browser -- home --url https://example.com
npm run browser -- find "needle"
npm run browser -- find "needle" --backward
npm run browser -- zoom 150
npm run browser -- zoom reset
npm run browser -- resize --width 1440 --height 980
npm run browser -- emulate-viewport --width 390 --height 740 --device-scale-factor 2 --mobile --touch --color-scheme dark
npm run browser -- emulate-viewport --reset
```

## 요소 조작

```bash
npm run browser -- wait --selector body
npm run browser -- box --selector "main h1"
npm run browser -- click-selector "button[type=submit]"
npm run browser -- focus-selector "input[name=q]"
npm run browser -- type-selector "input[name=q]" --text "hello" --clear
npm run browser -- paste-selector "textarea[name=body]" --text "hello"
npm run browser -- set-value-selector "input[type=range]" --value 42
npm run browser -- click --x 120 --y 80
npm run browser -- type --text "hello"
npm run browser -- key --key Enter
npm run browser -- key --key ArrowLeft
npm run browser -- key --key Ctrl+A
npm run browser -- drag --selector ".card" --to-selector ".lane"
npm run browser -- drag-drop-selector ".card" --to-selector ".lane" --text "payload"
npm run browser -- select-selector "select[name=kind]" --value article
npm run browser -- check-selector "input[type=checkbox]" --checked
npm run browser -- check-selector "input[type=checkbox]" --unchecked
npm run browser -- upload-selector "input[type=file]" --upload-file ./fixture.txt
npm run browser -- dialog
npm run browser -- handle-dialog --dismiss
npm run browser -- wheel --x 400 --y 300 --deltaY 600
npm run browser -- scroll --to bottom
```

`wheel`과 `scroll`은 현재 세션의 WebView 탭에서 실행됩니다. 긴 페이지나 내부 스크롤 영역의 끝까지 내려야 할 때는 `scroll --to bottom`을 사용합니다.

## 검사와 산출물

```bash
npm run browser -- eval --code "document.title"
npm run browser -- text --selector body --file .octo-tmp/browser-text.txt
npm run browser -- html --selector html --file .octo-tmp/browser.html
npm run browser -- guide
npm run browser -- guide --file .octo-tmp/browser-cli-guide.json
npm run browser -- info
npm run browser -- console
npm run browser -- clear-console
npm run browser -- network-conditions
npm run browser -- offline
npm run browser -- online
npm run browser -- network-throttle --profile slow-3g
npm run browser -- network-conditions --latency-ms 250 --download-kbps 750 --upload-kbps 250 --connection-type cellular3g
npm run browser -- environment
npm run browser -- user-agent --user-agent "Mozilla/5.0 ..."
npm run browser -- clear-user-agent
npm run browser -- timezone --timezone America/New_York
npm run browser -- clear-timezone
npm run browser -- cdp Runtime.evaluate --params '{"expression":"document.title"}'
npm run browser -- cdp-fire Input.dispatchMouseEvent --params '{"type":"mouseMoved","x":120,"y":80,"button":"none"}'
```

`cdp`는 CDP 응답을 기다리는 진단용입니다. `cdp-fire`는 응답 ack가 느린 입력 이벤트처럼 “보내는 것” 자체가 중요한 제어용이며, 내부적으로도 mouse/click/drag 명령은 이 경로를 사용해 Tauri JS bridge timeout에 걸리지 않게 합니다.

## 세션 패킷 분석

```bash
npm run browser -- network
npm run browser -- packets --file .octo-tmp/browser-packets.json
npm run browser -- packet --request-id <id>
npm run browser -- request-body --request-id <id>
npm run browser -- packet-body --request-id <id> --file .octo-tmp/packet-body.txt
npm run browser -- exchange --request-id <id> --file .octo-tmp/exchange.json
npm run browser -- replay --request-id <id> --include-secrets --repeat 3 --delay-ms 500
npm run browser -- composer --url https://httpbin.org/get
npm run browser -- composer --method POST --url https://httpbin.org/post --headers '{"Content-Type":"application/json"}' --body '{"test":1}' --file .octo-tmp/composer.json
npm run browser -- storage
npm run browser -- storage --include-secrets
npm run browser -- cookies
npm run browser -- cookies --include-secrets
npm run browser -- set-cookie --name bbarit_test --value hello --same-site Lax
npm run browser -- delete-cookie --name bbarit_test
npm run browser -- clear-storage
npm run browser -- clear-storage --cache
npm run browser -- permissions
npm run browser -- grant-permissions geolocation,notifications
npm run browser -- grant-permissions --permissions clipboard-read --origin https://example.com
npm run browser -- reset-permissions
npm run browser -- geolocation --latitude 37.5665 --longitude 126.9780 --accuracy 20
npm run browser -- clear-geolocation
npm run browser -- download-behavior --download-dir .octo-tmp/downloads
npm run browser -- downloads
npm run browser -- wait-download --timeout-ms 30000
npm run browser -- clear-downloads
npm run browser -- cancel-download --guid <guid>
npm run browser -- clipboard-read --include-secrets
npm run browser -- clipboard-write --text "hello"
npm run browser -- clipboard-paste-selector "textarea"
npm run browser -- copy-selector "main h1"
npm run browser -- respond --url-pattern "https://api.example.com/*" --status 200 --body '{"mock":true}'
npm run browser -- respond --url-pattern "^https://api.example.com/users$" --regex --status 200 --body '[]'
npm run browser -- respond --list
npm run browser -- respond --clear
npm run browser -- breakpoint --url-pattern "https://api.example.com/*" --phase request
npm run browser -- breakpoint --list
npm run browser -- breakpoint --resume
npm run browser -- breakpoint --abort
npm run browser -- har --file .octo-tmp/browser.har
npm run browser -- clear-network
```

`composer`는 Fiddler의 Composer처럼 임의 HTTP 요청을 작성해 전송합니다. `--headers`는 JSON 객체 또는 `Name: value` 줄을 받습니다. 응답은 status, headers, body, durationMs를 포함한 JSON으로 반환합니다.

`respond`는 AutoResponder 기능입니다. URL 패턴(와일드카드 또는 `--regex`)에 매칭되는 요청에 대해 지정한 status/headers/body로 모의 응답을 반환합니다. `--list`, `--clear`, `--active`, `--inactive`로 규칙을 관리할 수 있습니다.

`breakpoint`는 Fiddler의 Breakpoints처럼 브라우저 네트워크 요청을 일시 중지합니다. `--url-pattern`으로 규칙을 추가하고, `--phase request|response|both`로 중지 지점을 지정합니다. `request`는 요청 전, `response`는 응답 헤더 수신 후, `both`는 두 지점 모두에서 멈춥니다. 요청이 멈추면 `--resume`으로 진행하거나 `--abort`로 중단할 수 있습니다. AutoResponder(`respond`)는 요청 단계에서만 모의 응답을 반환합니다.

패킷/교환/HAR/body/composer 출력은 기본적으로 `Authorization`, `Cookie`, `Set-Cookie`, token, password, api key, session 계열 값을 `[redacted]`로 마스킹합니다.

원문 쿠키/토큰/바디가 꼭 필요할 때만 명시적으로 `--include-secrets`를 붙입니다.

```bash
npm run browser -- exchange --request-id <id> --include-secrets --file .octo-tmp/exchange.raw.json
npm run browser -- har --include-secrets --file .octo-tmp/browser.raw.har
```

`exchange`는 하나의 request/response를 CLI로 뽑아 URL, method, status, timing, request headers/body, response headers/body, replay용 fetch/curl 데이터를 한 JSON으로 저장합니다. 기본 출력의 fetch/curl도 마스킹된 값으로 생성됩니다.

## 보안 점검

```bash
npm run browser -- security --file .octo-tmp/security.json
npm run browser -- cert
```

`security`는 본인이 소유하거나 허가받은 사이트의 방어적 점검용입니다. HSTS, CSP, MIME sniffing 방지, clickjacking 방어, referrer/permissions policy, 쿠키 속성, 민감 query, CORS, mixed content, 콘솔 오류, 폼/스토리지 신호를 수동 분석 리포트로 정리합니다.

`cert`는 로컬 분석용 BBARIT CA 파일을 생성합니다. 시스템 신뢰 저장소에 몰래 설치하거나 시스템 전체 트래픽을 자동 가로채지 않습니다.

## 프로젝트 패널

```bash
npm run browser -- tree on
npm run browser -- tree off
npm run browser -- terminal on
npm run browser -- terminal off
npm run browser -- project "$PWD"
```

## 화면 우선 루프

브라우저 프로젝트는 `open -> wait -> inspect -> edit -> screenshot` 루프를 기준으로 완료 판단합니다. 화면, DOM 텍스트, 콘솔, 네트워크, 패킷, 스크린샷을 확인하기 전에는 UI 작업을 완료로 보지 않습니다.
