/**
 * Monaco를 로컬 번들로 구동한다.
 *
 * @monaco-editor/react의 기본값은 jsdelivr CDN 로드라서
 *  - 오프라인/방화벽 환경에서 코드 편집기가 통째로 깨지고
 *  - package.json의 monaco-editor 버전과 런타임 버전이 어긋날 수 있다.
 * 이 모듈을 앱 시작 시 한 번 import하면 이후 모든 <Editor>가 로컬 monaco를 쓴다.
 * (main.tsx에서 dynamic import — monaco는 별도 청크로 분리되어 첫 페인트를 막지 않는다)
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

// UI 자동검증(dev:screen js)에서 에디터 인스턴스에 접근하기 위한 전역 (__octoOpenFile과 같은 관례).
(window as unknown as { __bbaritMonaco?: typeof monaco }).__bbaritMonaco = monaco;

// Monaco의 취소 토큰은 정상 동작 중에도 'Canceled' unhandled rejection을 흘린다 —
// 실제 오류가 아니므로 콘솔 스팸만 막는다.
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined;
  if (reason && (reason.name === 'Canceled' || reason.message === 'Canceled')) e.preventDefault();
});
