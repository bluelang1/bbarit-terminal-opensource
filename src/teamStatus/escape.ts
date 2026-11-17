// Esc closes the innermost open thing first (reject form → drawer mode → drawer → add-task
// form), then the overlay. Open parts register a closer while they are open; the overlay's
// Esc handler runs the most recently registered one, or closes itself when none is left.
import { createContext, useContext, useEffect, useRef } from 'react';

export interface EscapeStack {
  push(close: () => void): () => void;
  /** Close the innermost registered part; false when nothing was open. */
  run(): boolean;
}

export function createEscapeStack(): EscapeStack {
  const list: Array<{ close: () => void }> = [];
  return {
    push(close) {
      const entry = { close };
      list.push(entry);
      return () => {
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
      };
    },
    run() {
      const top = list[list.length - 1];
      if (!top) return false;
      top.close();
      return true;
    },
  };
}

export const EscapeContext = createContext<EscapeStack | null>(null);

/** While `open`, Esc calls `close` before anything opened earlier. */
export function useEscapeLayer(open: boolean, close: () => void): void {
  const stack = useContext(EscapeContext);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || !stack) return;
    return stack.push(() => closeRef.current());
  }, [open, stack]);
}
