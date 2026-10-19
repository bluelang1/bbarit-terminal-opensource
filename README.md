# BBARIT Terminal · 빠릿터미널

**빠릿터미널이 MIT 오픈소스로 공개되었습니다.**

소스: [johunsang/bbarit-terminal-opensource](https://github.com/johunsang/bbarit-terminal-opensource)

Tauri 2, Rust, React 19, TypeScript로 만든 데스크톱 AI 개발 환경입니다. 실제 PTY 터미널, 여러 프로젝트, AI CLI 연동, 코드·문서 편집기, 내장 브라우저, 에이전트와 작업 패널을 제공합니다. 이전 제품명은 Octo Terminal입니다.

[공개 소스 저장소](https://github.com/johunsang/bbarit-terminal-opensource)는 **MIT 라이선스의 소스 배포본**입니다. 운영 키, 사용자 데이터, 서명 인증서, 설치 파일과 비공개 Git 이력을 포함하지 않습니다. 외부 AI·GitHub·SNS 서비스는 사용자가 자신의 계정이나 키로 연결합니다. 서버를 사용하는 채팅·Thread 등 기존 기능도 남아 있습니다.

## 소스 기준

원본 최신 `main` 커밋 `e8515d22`를 기준으로 준비했습니다. 해당 소스는 Windows 수정 릴리즈 `v1.1.51`에 해당하지만 `package.json`·Cargo·기본/macOS Tauri 버전은 `1.1.50`, Windows Tauri 버전은 `1.1.51`입니다. 이 배포본에서는 원본 버전 메타데이터를 유지합니다.

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
| `VITE_BBARIT_LOUNGE_WS_URL` | `wss://bbarit.com/api/lounge/ws` | 라운지 웹소켓 (`~/.config/octo/.env`의 `BBARIT_LOUNGE_URL`이 실행 시 우선) |
| `VITE_BBARIT_AGENT_INSTALL_URL` | `<기준 주소>/agent/install.sh` | `bbarit-oss` 에이전트 미설치 안내에 쓰는 설치 스크립트 |
| `VITE_BBARIT_RELEASE_REPO_MAC` | `bluelang1/bbarit-terminal-opensource` | 툴바 GitHub 링크·릴리즈 페이지 (macOS) |
| `VITE_BBARIT_RELEASE_REPO_WIN` | `bluelang1/bbarit-terminal-opensource` | 릴리즈 페이지 (Windows) |

서명된 Tauri 업데이터 엔드포인트는 `src-tauri` 설정에 있으며 이 변수들의 영향을 받지 않습니다.

## 검증 범위

공개 준비 시 수행한 검사는 [공개 소스 안내](docs/OPEN_SOURCE.md)에 구분해 기록합니다. 프런트엔드 빌드·단위 검사·설정 검사와 네이티브 앱의 실제 실행 검증은 서로 다른 근거입니다.

이번 공개 준비에서 Windows 실기 검증을 수행하지 않았습니다. Windows에서 동작·릴리즈 가능 여부를 판단하려면 실제 Windows 환경에서 `npm run win:prereq`, `npm run win:verify`와 해당 브라우저·에이전트 검증을 완료해야 합니다. Linux의 전체 기능·패키징도 검증하지 않았습니다.

## 라이선스와 기여

프로젝트의 MIT 라이선스는 [LICENSE](LICENSE)를 참고하세요. 의존성·번들 자산에는 각자의 라이선스가 적용됩니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [공개 소스 안내](docs/OPEN_SOURCE.md)를 확인한 뒤 기여해 주세요.
