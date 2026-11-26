# 릴리스 전 의존성 취약점 검사(cargo audit) 설계

- 상태: 검토 1차, 구현 보류 (다른 큰 작업이 머지된 뒤 진행)
- 날짜: 2026-11-26
- 관련: `2026-11-26-update-signing-hardening-design.md` (같은 릴리스 보안 묶음)

## 목표

릴리스 전에 `cargo audit` 로 Rust 의존성의 알려진 취약점을 검사하고, 걸리면 릴리스를 막는다.
지금 바로 막는 단계를 넣으면 모든 릴리스가 막히므로, 정리 → 예외 등록 → 차단 순서로 간다.

## 지금 상태 (2026-11-26, origin/main 에서 재현)

재현 명령: `cargo audit --file <Cargo.lock>` (cargo-audit 0.23.0)

| 잠금 파일 | 취약점 공지 | 해당 크레이트 수 | 경고(관리 중단 등) |
|---|---|---|---|
| `src-tauri/Cargo.lock` | 57 | 24 | 60 |
| `bbarit-agent/Cargo.lock` | 27 | 12 | 12 |
| `bbarit-agent/vendor/semble/Cargo.lock` | 8 | 5 | 4 |

- 건수는 공지 개수다. 한 크레이트에 공지가 여러 개 붙어 실제 고칠 크레이트 수는 더 적다.
- 잠금 파일이 셋이지만 **출시되는 앱은 `src-tauri/Cargo.lock` 하나로 빌드된다.** `src-tauri` 가
  `bbarit-agent` 를 경로로 끌어와 그 의존성을 자기 잠금 파일에서 다시 정한다
  (`src-tauri/Cargo.toml:73`). 나머지 둘은 에이전트를 따로 빌드·테스트할 때만 쓰인다.
- 검사 설정(`.cargo/audit.toml`, `deny.toml`)도, 검사를 돌리는 워크플로도 아직 없다.

## 항목별 확인 결과 (`src-tauri`, macOS Apple Silicon 빌드 기준)

| 구분 | 크레이트 | 확인 결과 |
|---|---|---|
| 단순 업데이트로 해결 | rustls 0.23.37, rustls-webpki 0.103.9, webpki-roots, url, cookie, crossbeam-epoch, libz-sys, ammonia | 앱에 들어감. `cargo update --dry-run` 이 수정 버전 이상으로 올린다 (rustls 0.23.46, rustls-webpki 0.103.17, url 2.5.9, ammonia 4.2.5 등). `url` 은 버전 지정 없이도 올라갔다 |
| 잠금 파일에만 있음 | quinn-proto, quinn-udp, rkyv | 어떤 대상·기능으로도 빌드에 들어가지 않는다. 업데이트하면 공지는 사라진다(rkyv 제외) |
| macOS 에 안 들어감 | zip 4.6.1, webpki-root-certs, quick-xml 0.28.2 / 0.30.0 / 0.37.5 | macOS 빌드에 없다. zip 은 업데이트 플러그인이 Linux/Windows 용으로만 끌어온다. 지금은 macOS 만 출시하므로 실제 영향 없음 |
| 상위 크레이트를 올려야 함 | rustls 0.22.4, rustls-webpki 0.102.8 | 앱에 들어감. 에이전트가 쓰는 `tungstenite 0.21.0` 이 끌어온다. 단순 업데이트로 안 움직인다 |
| 큰 버전 올림 | surrealdb / surrealdb-core 2.6.2, libsqlite3-sys 0.30.1 | 앱에 들어감. 단순 업데이트로는 2.7.0 까지만 간다(공지 해결 여부 미확인) |
| 수정본 없음 | rsa 0.9.10 | 앱에 들어감. 어떤 경로로 쓰이는지 확인 후 예외 판단 |
| 해당 없을 가능성 | zstd-sys, quick-xml 0.38.4 | zstd-sys 는 WebAssembly 한정 문제. quick-xml 0.38.4 는 빌드 도구로만 쓰인다 |

전달받은 내용과 다른 점:
- **ammonia(XSS)와 zip(압축 해제)은 우리 코드가 직접 쓰지 않는다.** ammonia 는 surrealdb 안에서,
  zip 은 업데이트 플러그인 안에서만 쓰인다. "실제로 위험해 보이는 것" 순서에서 zip 은 macOS 에
  없으므로 내려가고, 앱에 실제로 들어가는 TLS 계열(rustls)이 가장 먼저다.
- quinn 8건은 건수는 크지만 빌드에 들어가지 않는다.

아직 확인하지 못한 것: Windows 대상 포함 여부, `rsa` 수정본 존재 여부, surrealdb 2.7.0 ·
quick-xml · zstd-sys 가 올라간 뒤 공지가 실제로 사라지는지, 에이전트·semble 잠금 파일의 항목별
상세(위 표는 `src-tauri` 기준).

## 접근 방법

1. **출시 잠금 파일만 막고, 나머지 둘은 경고만 (권장)** — 앱에 실제로 들어가는 것은
   `src-tauri/Cargo.lock` 뿐이므로 릴리스 차단은 여기에만 건다. 에이전트·semble 잠금 파일은
   같은 PR 에서 함께 업데이트하되 검사 결과는 경고로만 남긴다. 예외 목록을 한 곳만 관리한다.
2. **셋 다 막기** — 전달받은 제안. 빈틈은 없지만 예외 목록을 세 곳에 맞춰야 하고, semble 은
   외부에서 가져온 크레이트라 원본을 따라갈 때마다 다시 어긋난다.
3. **cargo-deny 로 바꾸기** — 라이선스·출처까지 볼 수 있지만 지금 필요한 범위보다 크다.

## 단계 (구현 시)

1. **정리 PR**: 세 폴더에서 `cargo update -p <크레이트>` 로 "단순 업데이트로 해결" 항목과 quinn 을
   올린다. 확인은 `cargo test`(src-tauri, bbarit-agent)와 `cargo audit` 건수 감소.
   `src-tauri` 는 `--locked` 빌드가 깨지지 않는지 본다.
2. **경고 단계 추가**: `fork-release.yml` 과 CI 에 `cargo audit` 를 "경고만 내고 통과"로 넣는다.
   `cargo install cargo-audit --locked --version 0.23.0`.
3. **남은 항목 결정**: 항목마다 "올린다 / 예외 등록"을 정한다. 예외는 사유와 확인 명령을 주석으로
   적어 `src-tauri/.cargo/audit.toml` 의 `[advisories] ignore` 에 둔다.
   - `tungstenite` 올림(rustls 0.22 제거)은 에이전트 코드 수정이 따를 수 있다.
   - surrealdb 큰 버전 올림은 저장 형식이 바뀔 수 있어 원본(upstream) 반영을 기다릴지 따로 판단.
   - macOS 에 없는 항목은 "macOS 전용 출시" 사유로 예외. Windows/Linux 를 출시하게 되면 다시 본다.
4. **차단으로 전환**: `src-tauri/Cargo.lock` 검사를 실패 처리로 바꾼다.

## 주의

- 원본을 따라가는 포크라서 잠금 파일을 크게 바꾸면 다음 `git merge upstream/main` 때 충돌한다.
  1단계는 작은 버전 올림뿐이라 충돌해도 다시 `cargo update` 하면 된다.
- 경고(관리 중단·yanked)는 취약점이 아니며 기본값으로 실패 처리되지 않는다. 그대로 둔다.
- 차단을 켜면 새 공지가 나온 날부터 릴리스가 막힌다. 급한 릴리스는 예외 등록 PR 을 먼저 거친다.

## 남은 결정

- 차단 범위: 출시 잠금 파일만(권장) vs 셋 다.
- 1단계 정리 PR 은 잠금 파일만 바꾸므로 다른 큰 작업과 충돌이 작다. 보류를 풀고 먼저 할지.
