# 공개 소스 배포 범위

공개 저장소: https://github.com/johunsang/bbarit-terminal-opensource

## 기준과 제품 범위

빠릿터미널 원본 최신 `main`의 `e8515d22`를 기준으로 준비합니다. Windows 수정 태그는 `v1.1.51`, 기본·macOS·npm·Cargo 메타데이터는 `1.1.50`, Windows Tauri 구성은 `1.1.51`인 원본 상태를 유지합니다. 이 문서는 새 바이너리 릴리즈나 스토어 배포를 선언하지 않습니다.

이 공개 저장소에는 터미널 본체, 내장 Rust 에이전트, 브라우저와 제어 CLI, 채팅·Thread 및 기존 작업 패널이 포함됩니다. 별도로 배포되는 `bbarit-agent-oss`는 독립 프로젝트이며 이 소스 배포와 동기화하지 않습니다.

## 공개하는 구성

- `src/`, `public/`: React 프런트엔드, 관련 소스·자산과 테스트.
- `src-tauri/`: Tauri/Rust 소스, Cargo 메타데이터, 아이콘·네이티브 구성.
- `bbarit-agent/`: 앱에 포함되는 Rust 에이전트와 필수 `vendor/semble` 소스.
- `agent-browser-cli/`: 내장 브라우저 제어 CLI.
- 소스 빌드·검증에 필요한 스크립트, 잠금 파일, 라이선스·기여 문서.

실제 공개 파일 목록은 내보내기 정책과 감사 결과가 기준입니다. 원본 비공개 Git 이력을 이어 붙이지 않고 새 소스 묶음을 만듭니다. 운영 키·계정 내보내기·실사용 DB·로컬 설정·로그·녹화·생성 미디어·빌드 산출물·서명/공증/운영 릴리즈 스크립트는 제외합니다. MIT는 프로젝트 원본 라이선스를 유지하며, 제3자 라이선스를 대체하지 않습니다.

## 공개용 빌드 구성

`npm run tauri:dev`, `npm run tauri:build`, `npm run tauri -- info`는 `scripts/tauri-opensource.mjs`를 사용합니다. 개발·빌드 시 Tauri의 기본 구성과 OS 구성을 읽은 뒤 `src-tauri/tauri.opensource.conf.json`을 추가 병합합니다. [Tauri 구성 문서](https://v2.tauri.app/reference/config/)를 참고하세요.

공개 override는 다음을 적용합니다.

| 항목 | 공개 소스 빌드 |
| --- | --- |
| 앱 이름/식별자 | `BBARIT Terminal Source` / `com.bbarit.terminal.source` |
| 운영 updater | endpoint 목록 비움, 운영 공개키 비움 |
| updater 서명 산출물 | 생성하지 않음 |
| macOS 서명 | `-` 로컬 ad-hoc, 운영 팀·공증 제공자 사용 안 함 |
| Windows 서명 | 인증서 지문과 외부 서명 명령 없음 |
| 빌드 자식 환경 | `APPLE_*`, `TAURI_SIGNING_*`, `WINDOWS_CERTIFICATE*` 제거 |

macOS ad-hoc은 Apple 계정 인증이나 공증이 아닙니다. 배포판에 적용되는 OS 신뢰·보안 안내를 우회하는 구성도 아닙니다. [Tauri ad-hoc 서명 문서](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)를 참고하세요.

공식 설치 파일·기존 릴리즈 다운로드를 이 소스 배포의 설치 경로로 안내하지 않습니다. 소스 빌드 방식으로 제공합니다. 별도 `bbarit-agent-oss` 프로젝트의 릴리즈·설치 안내는 이 작업의 대상이 아닙니다.

기존 `tauri.conf.json`, `tauri.macos.conf.json`, `tauri.windows.conf.json`은 원본 배포 구성의 참고 자료입니다. 그 안의 updater 공개키는 검증용 공개 정보이며 서명용 개인키가 아닙니다. npm 소스 빌드 명령은 운영 설정을 override합니다. 직접 `npx tauri build`를 실행하면 이 래퍼를 거치지 않으므로 README의 명령을 사용하세요. 별도 릴리즈를 운영하려면 소유자의 식별자·업데이트 서버·서명 정책으로 구성하고 독립 검증해야 합니다.

`src-tauri`는 `../bbarit-agent`를 로컬 Cargo 의존성으로 사용하고, 에이전트는 `vendor/semble`을 사용합니다. 네이티브 번들은 `claude-skills`, 브라우저 CLI, 에이전트 personas, 개발 화면 CLI를 포함합니다. 이 파일들을 임의로 빼면 소스 또는 번들이 불완전해질 수 있습니다. 앱 전용 사전 컴파일 리소스가 없는 기능은 로컬 도구 설치·별도 다운로드가 필요할 수 있습니다.

## 네트워크와 설정

기존 서비스의 인증·권한 흐름을 유지합니다. 키와 AI CLI 인증은 사용자가 자신의 외부 서비스 설정으로 제공합니다.

- 원본 updater는 시작 약 1.2초 후, 약 5분마다, 포커스 복귀 시 검사합니다. 공개 override는 endpoint를 비우므로 운영 업데이트를 조회하지 않습니다. 업데이트 UI가 검사 불가 상태를 표시할 수 있습니다. 원본도 자동 설치하지 않으며, 설치는 업데이트 버튼을 누를 때 수행됩니다.
- 제품 공지는 `https://bbarit.com/api/products/notices`를 읽습니다. 요청·JSON 파싱 실패 시 빈 공지 목록으로 처리합니다.
- Lounge·Thread는 운영 서버를 사용하는 별도 기능입니다. Thread의 GitHub 로그인 등 기존 서비스 인증을 유지합니다.
- AI·MCP·GitHub·SSH·메신저·터널·모델 다운로드 등은 사용자가 선택한 서비스와 연결될 수 있습니다. 이 준비 작업에서 전 기능의 네트워크 추적을 수행하지는 않았습니다.
- 소스 검토에서 전역 사용량 수집용 telemetry SDK나 필수 원격 crash 전송은 찾지 못했습니다. MCP 설정 목록의 Sentry·PostHog 등은 사용자가 연결하는 도구 preset입니다. 이 결과는 모든 경로가 네트워크를 사용하지 않는다는 보장이 아닙니다.

별도 앱 식별자와 별개로 `octo` 설정 폴더, `~/.bbarit`, 노트·프로젝트 데이터 등 기존 사용자 경로는 유지합니다. 설치본의 설정과 완전히 격리된 새 사용자 데이터 디렉터리를 보장하지 않습니다. 기존 앱 데이터로 시험하거나 사용자의 인증 정보를 수집하지 않습니다.

## 검증 방법과 경계

README의 `npm ci`, `npm run build`, `npm run test:run`, `npm run test:source-build`로 프런트엔드·단위·공개 구성 검사를 수행합니다. 공개 래퍼 테스트는 endpoint 제거, 식별자, 서명 환경 제거, 공개 override 강제를 검사하며 앱이나 Cargo 빌드를 실행하지 않습니다.

`cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps`는 매니페스트를 확인하는 단계입니다. 전체 Rust 컴파일, 네이티브 링크, 설치, 실제 앱 실행은 각각 추가 검증이 필요합니다. 특히 네이티브 RocksDB·tokenizers·Whisper는 플랫폼 도구와 충분한 디스크가 필요합니다.

공개 전 소스 검증 결과:

| 검사 | 결과 |
| --- | --- |
| TypeScript app/node 설정 검사 | 통과 |
| Vite 프런트엔드 빌드 | 통과 |
| 프런트엔드 단위 검사 | 165파일, 1,693검사 통과 |
| 공개 소스 구성·서명 환경 검사 | 4검사 통과 |
| Mac/Windows 구성 병합 후 Tauri JSON Schema 검사 | 2구성 통과 |
| Cargo `metadata --locked` | 1,125패키지 해석 통과 |

위 결과는 네이티브 앱 전체 컴파일·링크·GUI 실행·Windows 실기 검증을 포함하지 않습니다. 설치·실계정 AI·유료 API·바이너리 배포·업데이트 설치도 검증하지 않았습니다.
