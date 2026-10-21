## 설치 · Install

macOS (Apple Silicon, M1 이상) 전용입니다. 이미 이 포크를 설치했다면 앱의 버전 배지에서 업데이트 버튼을 누르면 됩니다.

1. 아래 **Assets**에서 `BBARIT-Terminal-Source_<버전>_aarch64.dmg`를 받아 열고, `BBARIT Terminal Source`를 `Applications`로 끌어 넣습니다.
2. 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면 Finder에서 앱을 **우클릭 → 열기**를 누르거나, 터미널에서 다음을 실행합니다.
   ```
   xattr -dr com.apple.quarantine "/Applications/BBARIT Terminal Source.app"
   ```
3. 이후 새 버전은 앱 안에서 자동으로 알려 주고, 업데이트 버튼을 누를 때만 설치됩니다.

`.app.tar.gz`, `.sig`, `latest.json`은 자동 업데이트용 파일이라 직접 받을 필요가 없습니다. 자세한 내용은 [README의 설치 안내](https://github.com/bluelang1/bbarit-terminal-opensource#이-포크-설치하기)를 보세요.

---

