// Window pin: keep the main window above other windows and/or on every macOS
// desktop (Space). Values live in config.window; App.tsx applies them to the
// main window only. Design: docs/superpowers/specs/2026-11-13-window-pin-design.md

export interface WindowPinState {
  alwaysOnTop: boolean;
  followDesktops: boolean;
}

/** The two Tauri window methods we use (a fake in tests). */
export interface PinnableWindow {
  label?: string;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<void>;
  setVisibleOnAllWorkspaces(visible: boolean): Promise<void>;
}

export const DEFAULT_WINDOW_PIN: WindowPinState = { alwaysOnTop: false, followDesktops: false };

/** Sanitise a stored value: anything but an explicit `true` is off. */
export function readWindowPin(raw: unknown): WindowPinState {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { alwaysOnTop: v.alwaysOnTop === true, followDesktops: v.followDesktops === true };
}

async function attempt(label: string, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (err) {
    console.warn(`[window-pin] ${label} failed:`, err);
  }
}

/**
 * macOS: one Rust call (src-tauri/src/window_pin.rs) sets level + collection behavior,
 * so a pinned window stays in Mission Control and "follow desktops" can re-home it.
 */
export type NativePin = (label: string, alwaysOnTop: boolean, followDesktops: boolean) => Promise<void>;
export type InvokeFn = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The native path on macOS, null elsewhere (the Tauri window API is used there). */
export function nativePinFor(platform: string | undefined, invoke: InvokeFn): NativePin | null {
  if (!followDesktopsSupported(platform)) return null;
  return async (label, alwaysOnTop, followDesktops) => {
    await invoke('window_pin_apply', { label, alwaysOnTop, followDesktops });
  };
}

/** Apply both switches; a failure is logged, never thrown, and does not block the other. */
export async function applyWindowPin(win: PinnableWindow, state: WindowPinState, native?: NativePin | null): Promise<void> {
  if (native && win.label) {
    const label = win.label;
    await attempt(`window_pin_apply(${label})`, () => native(label, state.alwaysOnTop, state.followDesktops));
    return;
  }
  await Promise.all([
    attempt('setAlwaysOnTop', () => win.setAlwaysOnTop(state.alwaysOnTop)),
    attempt('setVisibleOnAllWorkspaces', () => win.setVisibleOnAllWorkspaces(state.followDesktops)),
  ]);
}

export const MAIN_WINDOW_LABEL = 'main';
/** Windows that never follow the main window's pin: main itself and the desktop pet. */
const NOT_FOLLOWING = new Set([MAIN_WINDOW_LABEL, 'pet']);

/**
 * Whether the effect in App.tsx should touch the window: only `main`, only after
 * config has loaded, and only once a switch has been on (so turning one off is
 * applied, but users who never used them are left alone).
 */
export function windowPinAction(input: {
  label: string;
  ready: boolean;
  touched: boolean;
  state: WindowPinState;
}): 'apply' | 'skip' {
  if (!input.ready || input.label !== MAIN_WINDOW_LABEL) return 'skip';
  if (!input.touched && !input.state.alwaysOnTop && !input.state.followDesktops) return 'skip';
  return 'apply';
}

/**
 * The app's own secondary windows (guide, tool-*, term-detach-*, harness…) stay
 * on top together with a pinned main window, or they would open behind it.
 */
export function followsMainPin(label: string): boolean {
  return label.length > 0 && !NOT_FOLLOWING.has(label);
}

export interface LabeledTopWindow {
  label: string;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<void>;
}

/** Set always-on-top on every window that follows main; failures are logged, never thrown. */
export async function setSecondaryOnTop(windows: LabeledTopWindow[], on: boolean, native?: NativePin | null): Promise<void> {
  await Promise.all(
    windows
      .filter(w => followsMainPin(w.label))
      .map(w => (native
        ? attempt(`window_pin_apply(${w.label})`, () => native(w.label, on, false))
        : attempt(`setAlwaysOnTop(${w.label})`, () => w.setAlwaysOnTop(on)))),
  );
}

/** Closing the guide spotlight must not drop the guide behind a pinned main window. */
export function keepGuideOnTopAfterSpotlight(pin: Partial<WindowPinState> | undefined): boolean {
  return pin?.alwaysOnTop === true;
}

/** "Follow desktops" only means something on macOS (Spaces). Pass navigator.platform. */
export function followDesktopsSupported(platform: string | undefined): boolean {
  return typeof platform === 'string' && platform.toUpperCase().includes('MAC');
}

/** navigator.platform, or '' where it is unavailable. */
export function currentPlatform(): string {
  try { return typeof navigator !== 'undefined' ? navigator.platform || '' : ''; } catch { return ''; }
}
