# 편집기 제어 브릿지 (Editor Control Bridge)

터미널에서 실행 중인 코드 에이전트(Claude Code 등)가 CLI로 실행 중인 BBARIT Terminal의
내장 편집기를 제어한다. 엑셀(XLSX)은 시트/셀 단위로, 머메이드·HTML·마크다운·텍스트 계열은
파일 내용 단위로 열기·읽기·쓰기·저장할 수 있다.

## 전제 조건

- BBARIT Terminal이 실행 중이어야 하며 로컬 편집기 브릿지 HTTP 서버가 열려 있어야 한다.
  - 설치본: `http://127.0.0.1:19980`
  - 개발 앱(`tauri:dev`): `http://127.0.0.1:19981`
  - 주소가 다르면 `OCTO_BRIDGE_URL` 환경변수로 지정한다.
  - ⚠️ **PTY 셸에는 `OCTO_BRIDGE_URL`이 자동 주입되지 않는다.** CLI 기본값은 설치본(19980)이므로,
    **개발 앱(`tauri:dev`)의 터미널**에서 실행할 때는 반드시
    `OCTO_BRIDGE_URL=http://127.0.0.1:19981` 를 앞에 붙여라. 안 붙이면 설치본이 떠 있는 경우
    조용히 그쪽 문서를 열고/편집/저장해 엉뚱한 인스턴스가 바뀐다.
    예: `OCTO_BRIDGE_URL=http://127.0.0.1:19981 node scripts/editor-control.mjs status`
- 로컬 전용, 인증 없음(기존 브라우저 브릿지와 동일한 신뢰 모델). 요청당 30초 타임아웃.
- 아키텍처: `POST /editor` → Rust axum(`browser_bridge.rs`)가 `editor-bridge-request` Tauri
  이벤트 emit → App.tsx가 처리 → `editor_bridge_respond` 명령으로 oneshot 채널에 응답 → HTTP 응답.
  `xlsx.*` 명령은 App.tsx가 `octo-xlsx-command` CustomEvent로 활성 XlsxEditor에 위임한다.

## 실행

```bash
npm run editor-ctl -- <command> [options]
# 또는
node scripts/editor-control.mjs <command> [options]
```

출력은 항상 한 줄 JSON이다. 성공은 `{"ok":true,...}`, 실패는 `{"ok":false,"error":"..."}` 이며
실패 시 종료 코드 1을 반환한다. `--wait <초>`(기본 10)는 `open` 직후 편집기 로드 지연 동안
명령을 폴링 재시도한다.

## 범용 명령 (텍스트 계열: text / markdown / mermaid / html)

```bash
# 열려 있는 파일 목록과 활성 파일
node scripts/editor-control.mjs status

# 파일을 편집기 패널에 연다 (뷰 전환 + 접힘 해제 포함)
node scripts/editor-control.mjs open --file /abs/path/diagram.mmd

# 내용 읽기 (--file 생략 시 활성 탭)
node scripts/editor-control.mjs get-content --file /abs/path/diagram.mmd

# 내용 교체 (열린 탭만, modified=true). --content / --content-file / stdin
node scripts/editor-control.mjs set-content --file /abs/path/diagram.mmd --content "graph TD; A-->B"
node scripts/editor-control.mjs set-content --file /abs/path/diagram.mmd --content-file new.txt
echo "graph TD; X-->Y" | node scripts/editor-control.mjs set-content --file /abs/path/diagram.mmd

# 디스크에 저장 (write_file, modified=false)
node scripts/editor-control.mjs save --file /abs/path/diagram.mmd
```

- `setContent`는 탭이 열려 있어야 한다. 안 열려 있으면 먼저 `open` 하라는 에러를 반환한다.
- 바이너리/자체 저장 편집기(xlsx, pptx, docx, pdf, image 등)는 텍스트 명령(`get-content`/`set-content`) 대상이 아니다.
  xlsx는 `xlsx-*`, docx는 `docx-*`, pptx는 `pptx-*` 전용 명령을 사용한다(아래 참조).

## 엑셀 명령 (XLSX, 셀 단위)

엑셀은 반드시 먼저 `open` 으로 열어야 하며, 화면에 렌더 중인 XlsxEditor가 응답한다.
open 직후에는 로드 지연이 있으므로 `--wait`(기본 10초) 폴링이 자동 적용된다.

```bash
# 시트 이름 목록 + 활성 시트 인덱스
node scripts/editor-control.mjs xlsx-sheets --file /abs/x.xlsx

# 셀 읽기 (value/formula/display). --sheet 생략 시 활성 시트
node scripts/editor-control.mjs xlsx-get --file /abs/x.xlsx --range A1:C10
node scripts/editor-control.mjs xlsx-get --file /abs/x.xlsx --range A1:C10 --sheet Sheet2

# 셀 쓰기 (undo 1회 + modified). "=" 로 시작하면 수식으로 저장
node scripts/editor-control.mjs xlsx-set --file /abs/x.xlsx \
  --cells '[{"ref":"A1","value":"hello"},{"ref":"B1","value":"=SUM(1,2)"}]'

# 서식 적용 (부분 병합: bold/italic/color/bgColor/align/numberFormat/fontSize/border)
node scripts/editor-control.mjs xlsx-format --file /abs/x.xlsx --range A1:B2 \
  --format '{"bold":true,"bgColor":"#ffee00"}'

# 시트 추가 / 저장
node scripts/editor-control.mjs xlsx-add-sheet --file /abs/x.xlsx --name Summary
node scripts/editor-control.mjs xlsx-save --file /abs/x.xlsx
```

## 워드 명령 (DOCX)

DOCX도 반드시 먼저 `open` 해야 하며, 화면에 렌더 중인 DocxEditor가 응답한다.
문서를 통째로 새로 만드는 작업은 대신 `scripts/office-edit.mjs`를 쓴다(아래 참고 주의).

```bash
# 본문 텍스트 추출(최대 30000자) / HTML 추출(최대 80000자)
node scripts/editor-control.mjs docx-get-text --file /abs/doc.docx
node scripts/editor-control.mjs docx-get-html --file /abs/doc.docx

# 문서 끝에 내용 덧붙이기 (heading/paragraph/bullets/html 조합). 빈 줄 2개로 문단 분리.
node scripts/editor-control.mjs docx-append --file /abs/doc.docx \
  --heading "Next Steps" --paragraph "First paragraph.\n\nSecond paragraph." \
  --bullets '["Owner","Due date"]'
# 표/서식은 raw HTML로 (로컬 신뢰 에이전트 전용)
node scripts/editor-control.mjs docx-append --file /abs/doc.docx --html "<table>…</table>"

# 디스크에 저장(.docx 재패키징)
node scripts/editor-control.mjs docx-save --file /abs/doc.docx
```

## 파워포인트 명령 (PPTX)

PPTX도 먼저 `open` 해야 하며, 렌더 중인 PptxEditor가 응답한다. `--slide` 생략 시 현재 슬라이드.
좌표(`--x/--y/--w/--h`)는 슬라이드 대비 0~100 백분율이다.

```bash
# 슬라이드 목록 + 현재 인덱스
node scripts/editor-control.mjs pptx-slides --file /abs/deck.pptx

# 슬라이드 추가(제목/본문). 본문에 \n 있으면 불릿 처리
node scripts/editor-control.mjs pptx-add-slide --file /abs/deck.pptx \
  --title "Roadmap" --body "Q1 Discovery\nQ2 Delivery"

# 텍스트 상자 추가
node scripts/editor-control.mjs pptx-add-text --file /abs/deck.pptx --slide 1 \
  --text "Key metric" --x 8 --y 40 --w 60 --h 12 --fontSize 24 --bold --color "#111827"

# 도형 추가 (rect/circle/triangle/star/arrow/line)
node scripts/editor-control.mjs pptx-add-shape --file /abs/deck.pptx --slide 1 \
  --shape rect --x 10 --y 55 --w 24 --h 18 --fillColor "#2563eb"

# 현재 슬라이드 이동 / 디스크 저장
node scripts/editor-control.mjs pptx-goto --file /abs/deck.pptx --slide 2
node scripts/editor-control.mjs pptx-save --file /abs/deck.pptx
```

- 이 `docx-*`/`pptx-*` 명령은 **열린 편집기의 라이브 문서**를 조작하므로 레이아웃·이미지·서식을 보존한다.
  반면 `scripts/office-edit.mjs`의 pptx 텍스트 편집은 덱을 재생성해 서식을 잃을 수 있으니, 열린 문서에는 이 브릿지 명령을 우선한다.

## 에이전트 사용 예시

머메이드 다이어그램을 열어 내용을 갈아끼우고 저장:

```bash
node scripts/editor-control.mjs open --file /work/flow.mmd
node scripts/editor-control.mjs set-content --file /work/flow.mmd --content "graph LR; 사용자-->API-->DB"
node scripts/editor-control.mjs save --file /work/flow.mmd
```

엑셀 셀을 채우고 서식을 준 뒤 저장:

```bash
node scripts/editor-control.mjs open --file /work/report.xlsx
node scripts/editor-control.mjs xlsx-set --file /work/report.xlsx \
  --cells '[{"ref":"A1","value":"Item"},{"ref":"B1","value":"Total"},{"ref":"B2","value":"=SUM(B3:B10)"}]'
node scripts/editor-control.mjs xlsx-format --file /work/report.xlsx --range A1:B1 --format '{"bold":true}'
node scripts/editor-control.mjs xlsx-save --file /work/report.xlsx
```

## HTML 빌더 (터미널 빌더)

비주얼 빌더(Build 모드)와 같은 블록 라이브러리·요소 모델을 CLI로 조작한다.
파일이 앱에 열려 있으면 라이브 캔버스에 바로 반영되고(`save`로 저장), 닫혀 있으면 디스크 파일에 직접 쓴다.

요소 지정(`--target`)은 `html-outline`이 주는 인덱스 경로(`"[1,0]"`) 또는 body 기준 CSS 선택자.

```bash
node scripts/editor-control.mjs html-blocks                       # 블록 목록
node scripts/editor-control.mjs html-outline --file /work/page.html
node scripts/editor-control.mjs html-insert  --file /work/page.html --block hero
node scripts/editor-control.mjs html-insert  --file /work/page.html --block pricing --target "[0]" --position after
node scripts/editor-control.mjs html-set-text  --file /work/page.html --target "section h1" --text "새 헤드라인"
node scripts/editor-control.mjs html-set-style --file /work/page.html --target "[1]" --style '{"background":"#0f172a","color":"#fff"}'
node scripts/editor-control.mjs html-set-attr  --file /work/page.html --target "a" --attr href --value https://example.com
node scripts/editor-control.mjs html-move      --file /work/page.html --target "[2]" --delta -1
node scripts/editor-control.mjs html-remove    --file /work/page.html --target "[3]"
node scripts/editor-control.mjs save --file /work/page.html       # 열린 탭이면 저장 필요
```

랜딩 페이지를 통째로 만드는 예:

```bash
F=/work/landing.html
node scripts/editor-control.mjs html-insert --file $F --block navbar
node scripts/editor-control.mjs html-insert --file $F --block hero
node scripts/editor-control.mjs html-insert --file $F --block features
node scripts/editor-control.mjs html-insert --file $F --block cta
node scripts/editor-control.mjs html-insert --file $F --block footer
node scripts/editor-control.mjs html-set-text --file $F --target "section h1" --text "제품 이름"
```

## 트러블슈팅

- `cannot reach bridge ...`: BBARIT Terminal이 꺼져 있거나 포트가 다르다. `OCTO_BRIDGE_URL` 확인.
- `editor bridge timed out (30s)`: 앱은 떠 있으나 프론트가 응답하지 못함. 창이 보이는지 확인.
- `xlsx editor not open ...`: 해당 .xlsx를 `open` 하지 않았거나 아직 렌더 전. `--wait` 를 늘린다.
- `file not open — call open first`: 텍스트 명령은 탭이 열려 있어야 한다. 먼저 `open`.
