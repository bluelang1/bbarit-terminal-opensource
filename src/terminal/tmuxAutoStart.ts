// tmux 자동 시작 명령. tmuxAutoStart 는 앱이 꺼져도 세션이 살아남게 하려고 있으므로, tmux 서버가
// 탭의 스코프 토큰(BBARIT_TERM_SCOPE)을 물려받으면 안 된다 — 물려받으면 그 탭을 닫거나 앱을
// 끌 때 스윕이 서버와 모든 세션을 죽인다. unix 에서는 `env -u` 로 토큰을 빼고 띄운다.
// 서버가 이미 다른 탭에서 떠 있으면 그 서버에 붙을 뿐이라 따로 할 일이 없다.
// 설계: docs/TERMINAL_SCOPE_SWEEP.md
export const TERM_SCOPE_ENV = 'BBARIT_TERM_SCOPE';

/** Enter 는 붙이지 않는다(호출자가 `\r` 을 붙인다). Windows 에서는 접두를 붙이지 않는다. */
export function tmuxAutoStartCommand(sessionName: string, windows = false): string {
  const tmux = `tmux new-session -A -s ${sessionName}`;
  return windows ? tmux : `env -u ${TERM_SCOPE_ENV} ${tmux}`;
}
