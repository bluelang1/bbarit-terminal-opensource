// The "agent ready" notification fires once per terminal lifetime, but the PTY
// writer it hands out is dropped on every unmount. A remounted terminal must
// therefore re-register its writer even though the once-gate already fired,
// otherwise external injection (mix broadcast, ctl term write, harness) goes
// nowhere while the terminal itself still types fine.
export function shouldNotifyReady(alreadyNotified: boolean, writerRegistered: boolean): boolean {
  return !alreadyNotified || !writerRegistered;
}
