/**
 * useSlideHistory.ts — Undo/Redo custom hook for slide editing
 */

import { useState, useRef, useCallback } from 'react';
import type { Slide } from './types';
import { MAX_HISTORY } from './types';

// Snapshots hold plain references, not deep clones: every slide mutation in the
// editor goes through immutable setSlides/updateCurrentSlide updates, so a past
// array can never be mutated in place. Deep-cloning here serialized the whole
// deck (inline base64 images included) on every drag/keystroke snapshot.
export function useSlideHistory(slidesRef: React.MutableRefObject<Slide[]>) {
  const pastRef = useRef<Slide[][]>([]);
  const futureRef = useRef<Slide[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  const recordForUndo = useCallback(() => {
    pastRef.current.push(slidesRef.current);
    if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
    futureRef.current = [];
    updateFlags();
  }, [slidesRef, updateFlags]);

  const undo = useCallback((): Slide[] | null => {
    if (pastRef.current.length === 0) return null;
    futureRef.current.push(slidesRef.current);
    const prev = pastRef.current.pop()!;
    updateFlags();
    return prev;
  }, [slidesRef, updateFlags]);

  const redo = useCallback((): Slide[] | null => {
    if (futureRef.current.length === 0) return null;
    pastRef.current.push(slidesRef.current);
    const next = futureRef.current.pop()!;
    updateFlags();
    return next;
  }, [slidesRef, updateFlags]);

  return { canUndo, canRedo, recordForUndo, undo, redo };
}
