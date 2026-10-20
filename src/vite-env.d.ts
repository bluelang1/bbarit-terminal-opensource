/// <reference types="vite/client" />

// vite.config.ts define()로 주입되는 빌드타임 상수들.
declare const __BBARIT_BROWSER_CLI__: string;
// dev(serve)에서만 repo 루트 절대경로, build에서는 '' — App.tsx가 DEV 가드로 사용.
declare const __DEV_REPO_ROOT__: string;

// 서버·릴리즈 저장소 오버라이드 (src/config/endpoints.ts, .env.example 참고).
interface ImportMetaEnv {
  readonly VITE_BBARIT_API_BASE_URL?: string;
  readonly VITE_BBARIT_NOTICES_URL?: string;
  readonly VITE_BBARIT_LOUNGE_WS_URL?: string;
  readonly VITE_BBARIT_AGENT_INSTALL_URL?: string;
  readonly VITE_BBARIT_RELEASE_REPO_MAC?: string;
  readonly VITE_BBARIT_RELEASE_REPO_WIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
