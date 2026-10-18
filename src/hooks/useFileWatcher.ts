/**
 * useFileWatcher.ts
 *
 * Cross-platform file system watcher hook.
 * Subscribes to "fs-events" Tauri events and filters by watch path.
 *
 * Usage:
 *   useFileWatcher('/path/to/project', (event) => {
 *     console.log('Files changed:', event.paths);
 *     refreshFileTree();
 *   });
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface FsEvent {
  kind: 'create' | 'modify' | 'remove' | 'rename' | 'other' | 'access' | 'any';
  paths: string[];
  watch_root: string;
}

function normalizeWatchPath(path: string): string {
  let normalized = String(path || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '');

  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
  }

  return normalized;
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const c = normalizeWatchPath(candidate);
  const r = normalizeWatchPath(root);
  return c === r || c.startsWith(`${r}/`);
}

/**
 * Watch a directory for file system changes.
 * Automatically starts/stops watching when path changes.
 *
 * @param watchPath - Directory path to watch (null to disable)
 * @param callback - Called when files change
 * @param options - { recursive: true } by default
 */
export function useFileWatcher(
  watchPath: string | null,
  callback: (event: FsEvent) => void,
  options?: { recursive?: boolean; debounceMs?: number },
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEventsRef = useRef<FsEvent[]>([]);

  useEffect(() => {
    if (!watchPath) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const debounceMs = options?.debounceMs ?? 1000;

    // Listen before starting the watcher so early events are not missed.
    const unlistenPromise = listen<FsEvent>('fs-events', (event) => {
      if (disposed) return;
      const e = event.payload;
      const rootMatches = normalizeWatchPath(e.watch_root) === normalizeWatchPath(watchPath);
      const pathMatches = e.paths.some((path) => isSameOrChildPath(path, watchPath));
      if (!rootMatches && !pathMatches) return;

      // Debounce: accumulate events and fire callback after debounce interval
      pendingEventsRef.current.push(e);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        const events = pendingEventsRef.current;
        pendingEventsRef.current = [];
        if (events.length > 0) {
          // Merge all events into one
          const allPaths = [...new Set(events.flatMap(ev => ev.paths))];
          const hasRemove = events.some(ev => ev.kind === 'remove');
          const merged: FsEvent = {
            kind: hasRemove ? 'remove' : events[events.length - 1].kind,
            paths: allPaths,
            watch_root: events[0].watch_root,
          };
          callbackRef.current(merged);
        }
      }, debounceMs);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    void unlistenPromise.then(() => {
      if (disposed) return;
      return invoke('watch_directory', {
        path: watchPath,
        recursive: options?.recursive ?? true,
      }).catch((err) => console.warn('[FileWatcher] watch failed:', err));
    });

    return () => {
      disposed = true;
      unlisten?.();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingEventsRef.current = [];
      invoke('unwatch_directory', { path: watchPath }).catch(() => {});
    };
  }, [watchPath, options?.recursive, options?.debounceMs]);
}
