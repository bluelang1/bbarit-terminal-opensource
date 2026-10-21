# BBARIT Terminal · 빠릿터미널 (bluelang1 포크)

Tauri 2, Rust, React 19, TypeScript로 만든 데스크톱 AI 개발 환경입니다. 실제 PTY 터미널, 여러 프로젝트, AI CLI 연동, 코드·문서 편집기, 내장 브라우저, 에이전트와 작업 패널을 제공합니다. 이전 제품명은 Octo Terminal입니다.

이 저장소는 원작자의 [johunsang/bbarit-terminal-opensource](https://github.com/johunsang/bbarit-terminal-opensource)(MIT)를 포크해 보안 수정과 기능 개선을 더하고, **macOS 설치 파일과 자동 업데이트를 직접 배포**하는 저장소입니다. 원작자의 공식 배포판이 아니며 원작자는 이 포크를 지원하지 않습니다.

## 이 포크 설치하기

현재 **macOS Apple Silicon(M1 이상)**용 설치 파일만 제공합니다. Intel Mac과 Windows는 아래 [네이티브 앱 개발과 로컬 빌드](#네이티브-앱-개발과-로컬-빌드)로 직접 빌드해야 합니다.

1. [Releases 최신 버전](https://github.com/bluelang1/bbarit-terminal-opensource/releases/latest)의 **Assets**에서 `BBARIT-Terminal-Source_<버전>_aarch64.dmg`를 받습니다.
2. DMG를 열고 `BBARIT Terminal Source`를 `Applications` 폴더로 끌어 넣습니다.
3. 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면 Finder에서 앱을 **우클릭 → 열기**를 누릅니다. 또는 터미널에서 다음을 실행합니다.

   ```sh
   xattr -dr com.apple.quarantine "/Applications/BBARIT Terminal Source.app"
   ```

   Apple 개발자 인증서 대신 로컬(ad-hoc) 서명을 쓰기 때문에 뜨는 경고입니다. 자동 업데이트 파일은 별도의 서명 키로 검증합니다.
4. 이후 새 버전이 나오면 상단 버전 배지가 알려 주고, **업데이트 버튼을 누를 때만** 내려받아 교체·재시작합니다. 자동으로 설치되지는 않습니다.

알아 둘 점

- 앱 이름은 `BBARIT Terminal Source`, 식별자는 `com.bbarit.terminal.source`입니다. 원작자 앱(`BBARIT Terminal`, `com.octo.terminal`)과 따로 설치되며, 원작자 앱은 이 포크의 업데이트를 받지 않습니다.
- 프로젝트 목록·설정·대화 기록은 `~/.config/octo`, `~/.bbarit`를 원작자 앱과 함께 씁니다. 같은 데이터를 보므로 옮겨 오는 작업은 필요 없지만, 두 앱을 동시에 쓰면 서로의 변경이 보입니다.
- 채팅·라운지·Thread·제품 공지 같은 서버 기능은 지금도 원작자의 서버(`bbarit.com`)에 연결합니다. 끄거나 바꾸려면 [엔드포인트 설정](#엔드포인트-설정)을 보세요.
- AI CLI(Claude Code, Codex 등)와 외부 서비스는 각자 설치하고 본인 계정·키로 연결합니다.

### 원작자 버전과 다른 점

- 로컬 브리지(19980/19985)와 제어 WebSocket에 출처 검사를 넣어, 일반 웹페이지가 앱을 조종하지 못하게 했습니다. 웹뷰에 CSP를 적용하고 Git 명령 인자 주입도 막았습니다.
- 자체 서명 키와 GitHub Releases로 자동 업데이트를 제공합니다.
- 같은 프로젝트에서 대화가 섞이지 않는 "Claude 새 대화" 탭을 추가하고, 처음 여는 프로젝트에서 `claude --continue`가 실패하던 문제를 고쳤습니다.
- Finder 파일 드롭을 고쳤습니다. 이제 드롭하면 경로만 입력되고 Enter는 누르지 않습니다. 여러 줄 입력을 한 번에 지우는 버튼도 추가했습니다.
- 툴바에 내 로컬 대시보드를 띄우는 Dashboard 버튼을 추가했습니다(주소는 설정 > Hub). 프로젝트 목록 드래그도 개선했습니다.

전체 변경 내역은 [Releases](https://github.com/bluelang1/bbarit-terminal-opensource/releases)와 [커밋 기록](https://github.com/bluelang1/bbarit-terminal-opensource/commits/main)에 있습니다.

### 소스 배포본에 대해

원작자의 공개 저장소는 **MIT 라이선스의 소스 배포본**입니다. 운영 키, 사용자 데이터, 서명 인증서, 비공개 Git 이력을 포함하지 않습니다. 이 포크도 같은 원칙을 지키며, 설치 파일만 GitHub Releases에 따로 올립니다. 외부 AI·GitHub·SNS 서비스는 사용자가 자신의 계정이나 키로 연결합니다.

## 소스 기준

원본 최신 `main` 커밋 `e8515d22`(원작자 릴리즈 `v1.1.50`/Windows `v1.1.51`)를 기준으로 준비했습니다. 이 포크는 자체 릴리스를 내므로 버전은 `scripts/bump-version.mjs`로 모든 플랫폼을 함께 올립니다. 현재 버전은 `package.json`·`src-tauri/tauri.conf.json`을 기준으로 합니다.

## 준비할 도구

- Node.js **22.12 이상**, npm **10 이상**. 의존성은 `package-lock.json`으로 고정합니다.
- 네이티브 앱은 최신 stable Rust/Cargo, 해당 OS의 [Tauri 2 필수 도구](https://v2.tauri.app/start/prerequisites/)가 필요합니다. 내장 에이전트가 Rust 2024 edition을 사용하므로 오래된 Rust는 사용할 수 없습니다.
- macOS: Xcode Command Line Tools, C/C++ 빌드 도구, CMake, LLVM/libclang. Rust 의존성인 RocksDB·tokenizers·Whisper의 네이티브 컴파일에 사용합니다.
- Windows: Visual Studio C++ Build Tools, 대상 아키텍처에 맞는 MSVC 도구, Windows SDK, WebView2, CMake, LLVM/libclang. ARM64는 C++ ARM64/ARM64EC 도구가 추가로 필요합니다.
- AI CLI, Git, FFmpeg, 외부 모델·서비스는 사용하는 기능에 따라 별도로 설치하거나 설정합니다.

Rust 네이티브 의존성은 빌드 시간이 길고 많은 디스크 공간을 사용합니다. 프런트엔드만 빌드하는 것과 네이티브 앱을 빌드하는 것은 별도 단계입니다.

## 설치와 프런트엔드 검사

소스를 내려받은 뒤 저장소 루트에서 실행합니다.

```sh
git clone https://github.com/johunsang/bbarit-terminal-opensource.git
cd bbarit-terminal-opensource
```

```sh
npm ci
npm run build
npm run test:run
npm run test:source-build
```

`npm run build`는 TypeScript 검사와 Vite 프런트엔드 번들만 생성합니다. 네이티브 Rust 앱, 설치 파일 또는 실제 터미널 동작을 검증하는 명령은 아닙니다. `npm run lint`로 ESLint 검사를 실행할 수 있습니다.

```sh
npm run dev
```

Vite 화면을 `http://127.0.0.1:5175`에서 확인합니다. 이 모드에는 Tauri 백엔드가 없어 PTY·파일 시스템·네이티브 브라우저 기능을 온전히 사용할 수 없습니다.

## 네이티브 앱 개발과 로컬 빌드

```sh
npm run tauri -- info
npm run tauri:dev
```

`tauri:dev`는 Vite와 Rust 개발 앱을 함께 시작합니다. 같은 포트의 기존 개발 서버가 있다면 먼저 해당 서버를 확인하세요.

```sh
npm run tauri:build
```

프런트엔드와 Rust 앱을 컴파일하고 현재 OS의 번들을 `src-tauri/target/release/bundle` 아래에 만듭니다. Windows 대상이나 Cargo target을 지정하면 출력 경로에 target 이름이 추가됩니다. 컴파일만 필요하면 다음 명령을 사용합니다.

```sh
npm run tauri:build -- --no-bundle
```

위 npm 명령은 [공개 소스용 Tauri 설정](src-tauri/tauri.opensource.conf.json)을 적용합니다.

- 앱 이름은 `BBARIT Terminal Source`, 식별자는 `com.bbarit.terminal.source`입니다.
- 운영 업데이트 주소·키와 업데이트 서명 산출물을 사용하지 않습니다. 기존 업데이트 UI는 남지만 이 구성으로 운영 업데이트를 받지 않습니다.
- Apple 개발자 계정·인증서·공증 자격증명이 필요하지 않습니다. macOS는 로컬 ad-hoc 서명을 사용하며, 공증된 정식 배포판과 동일한 신뢰 상태를 제공하지 않습니다.
- 실행 래퍼는 자식 빌드 프로세스의 Apple·업데이터·Windows 인증서 환경 변수를 제거합니다. 운영 릴리즈·서명 스크립트는 공개 묶음에 포함하지 않습니다.

별도 앱 식별자는 **사용자 데이터의 완전한 격리를 의미하지 않습니다**. 기존 코드가 사용하는 `octo` 설정 폴더, `~/.bbarit`, 노트·프로젝트 데이터 경로는 유지합니다. 기존 설치본의 데이터와 완전히 분리해 시험하려면 별도 OS 사용자 환경을 사용하세요. 이 공개 준비 작업에서는 설치된 앱이나 실사용 데이터를 조작하지 않았습니다.

### 포크 릴리스와 자동 업데이트

공개 빌드는 업데이트 주소와 키가 비어 있어 자동 업데이트를 받지 않습니다. 이 포크는 자체 minisign 키와 GitHub Releases를 업데이트 소스로 쓰도록 [`tauri.fork.conf.json`](src-tauri/tauri.fork.conf.json)을 소스 설정 위에 덧씌울 수 있습니다. 원작자의 운영 키·주소와는 무관하며, 공개키만 저장소에 있고 개인키는 커밋하지 않습니다.

```sh
npx tauri signer generate -w ~/.tauri/bbarit-fork.key   # 최초 1회. 공개키를 tauri.fork.conf.json에 넣습니다
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/bbarit-fork.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='…' npm run tauri:build:fork
node scripts/fork-release-manifest.mjs --tag v1.1.51 --repo bluelang1/bbarit-terminal-opensource --out release-out
```

`tauri:build:fork`는 `--fork-release`로 업데이트 서명 산출물(`.app.tar.gz` + `.sig`)을 만들고, 래퍼는 `TAURI_SIGNING_PRIVATE_KEY`·`_PASSWORD`만 자식 프로세스에 남깁니다. 매니페스트 스크립트는 태그가 `v<앱 버전>`과 같은지 확인하고 `release-out/`에 공백 없는 이름의 번들 파일과 `latest.json`을 씁니다.

릴리스 절차는 다음과 같습니다.

1. `node scripts/bump-version.mjs 1.1.52`로 버전을 올리고, `src-tauri`에서 `cargo update -p octo-ui --offline`으로 Cargo.lock도 맞춘 뒤 머지합니다(아니면 CI의 `--locked` 검사가 실패합니다). 업데이터는 현재 버전보다 큰 버전만 설치합니다.
2. `gh workflow run fork-release.yml --ref main -f tag=v1.1.52`. [`fork-release.yml`](.github/workflows/fork-release.yml) 워크플로가 macOS(Apple Silicon)에서 빌드해 **초안(draft) 릴리스**에 산출물과 `latest.json`을 올립니다. 태그는 직접 만들지 않습니다. 초안을 **게시하는 순간** GitHub가 빌드한 커밋에 태그를 만듭니다. 저장소 시크릿 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 필요합니다. main에서 실행하는 이유는 Rust 캐시가 `main`에 남아 두 번째 릴리스부터 빌드가 짧아지기 때문입니다(캐시는 ref 단위로 격리되므로 첫 실행은 콜드).
3. GitHub에서 초안을 검토하고 게시(publish)합니다. 게시된 최신 릴리스만 `releases/latest/download/latest.json`으로 제공되므로, 게시 전에는 설치된 앱이 업데이트를 보지 못합니다.
4. 포크 빌드를 설치한 앱은 버전 배지에서 새 버전을 감지하고, 업데이트 버튼을 눌렀을 때만 내려받아 설치·재시작합니다.

이 포크를 다시 포크한다면 업데이트 주소(`tauri.fork.conf.json`)와 배지·릴리스 페이지 링크 기본값(`src/config/endpoints.ts`의 릴리스 저장소)을 함께 바꾸고, 자신의 키를 새로 만드세요.

원작자 서명 설치본(`com.octo.terminal`)은 원작자 키로만 검증하므로 이 포크의 릴리스를 받지 않습니다. 포크 빌드(`com.bbarit.terminal.source`)를 한 번 직접 설치한 뒤부터 자동 업데이트가 이어집니다. ad-hoc 서명 앱의 교체·재실행은 실제 macOS에서 확인해야 합니다.

## Rust 검사

```sh
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps
cargo test --manifest-path bbarit-agent/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Cargo metadata 성공은 네이티브 컴파일·링크·실행 성공을 의미하지 않습니다. OS별 네이티브 의존성이 필요하며, Rust 테스트도 최초 실행 시 긴 컴파일이 발생할 수 있습니다.

## 연결과 데이터

터미널·파일·프로젝트 기능은 로컬 Rust 백엔드를 사용합니다. AI CLI 로그인, API 키, GitHub·원격 서버·메신저 연결은 사용자가 직접 설정합니다. 키와 사용자 데이터를 저장소에 추가하지 마세요.

제품 공지는 `bbarit.com`에서 읽으며, 채팅·Thread·원격 협업·모델 다운로드·외부 연동은 각각의 서버와 네트워크를 사용할 수 있습니다. 이 소스 배포는 모든 기능을 오프라인으로 바꾸는 작업이 아닙니다. 자세한 범위는 [공개 소스 안내](docs/OPEN_SOURCE.md)를 참고하세요.

## 엔드포인트 설정

프런트엔드가 사용하는 서버 주소와 릴리즈 저장소는 `src/config/endpoints.ts` 한 곳에서 읽습니다. 빌드 시 `VITE_*` 환경 변수로 바꿀 수 있고, 설정하지 않으면 기본값을 씁니다. 예시는 `.env.example`을 복사해 `.env.local`로 쓰세요.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `VITE_BBARIT_API_BASE_URL` | `https://bbarit.com` | Thread API·공지·라운지·설치 스크립트의 기준 주소 |
| `VITE_BBARIT_NOTICES_URL` | `<기준 주소>/api/products/notices` | 제품 공지 피드. `off` 또는 빈 값이면 요청하지 않음 |
| `VITE_BBARIT_LOUNGE_WS_URL` | 기준 주소에서 파생 (`wss://bbarit.com/api/lounge/ws`) | 라운지 웹소켓 (`~/.config/octo/.env`의 `BBARIT_LOUNGE_URL`이 실행 시 우선) |
| `VITE_BBARIT_AGENT_INSTALL_URL` | `<기준 주소>/agent/install.sh` | `bbarit-oss` 에이전트 미설치 안내에 쓰는 설치 스크립트 |
| `VITE_BBARIT_RELEASE_REPO_MAC` | `bluelang1/bbarit-terminal-opensource` | 툴바 GitHub 링크·릴리즈 페이지 (macOS) |
| `VITE_BBARIT_RELEASE_REPO_WIN` | `bluelang1/bbarit-terminal-opensource` | 릴리즈 페이지 (Windows) |

서명된 Tauri 업데이터 엔드포인트는 `src-tauri` 설정에 있으며 이 변수들의 영향을 받지 않습니다.

## 검증 범위

공개 준비 시 수행한 검사는 [공개 소스 안내](docs/OPEN_SOURCE.md)에 구분해 기록합니다. 프런트엔드 빌드·단위 검사·설정 검사와 네이티브 앱의 실제 실행 검증은 서로 다른 근거입니다.

이번 공개 준비에서 Windows 실기 검증을 수행하지 않았습니다. Windows에서 동작·릴리즈 가능 여부를 판단하려면 실제 Windows 환경에서 `npm run win:prereq`, `npm run win:verify`와 해당 브라우저·에이전트 검증을 완료해야 합니다. Linux의 전체 기능·패키징도 검증하지 않았습니다.

## 라이선스와 기여

프로젝트의 MIT 라이선스는 [LICENSE](LICENSE)를 참고하세요. 의존성·번들 자산에는 각자의 라이선스가 적용됩니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [공개 소스 안내](docs/OPEN_SOURCE.md)를 확인한 뒤 기여해 주세요.
