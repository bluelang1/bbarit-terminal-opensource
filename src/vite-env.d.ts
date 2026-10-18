/// <reference types="vite/client" />

// vite.config.ts define()로 주입되는 빌드타임 상수들.
declare const __BBARIT_BROWSER_CLI__: string;
// dev(serve)에서만 repo 루트 절대경로, build에서는 '' — App.tsx가 DEV 가드로 사용.
declare const __DEV_REPO_ROOT__: string;
