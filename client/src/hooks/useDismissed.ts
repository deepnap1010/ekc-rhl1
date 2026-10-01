// client/src/hooks/useDismissed.ts
// Asks this person let run out on a screen that is NOT the machine's
// terminal. The terminal's expiry is written to the server and the ask leaves
// every queue; any other popup screen only closes it — so the ids are kept
// here, per person and event, on this device, or a reload would replay every
// closed ask one by one. Bounded; the server's two-hour queue window makes
// anything older irrelevant.
import { useCallback, useState } from 'react';

const CAP = 300;
const read = (key: string): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
};

export function useDismissed(key: string): { has: (id: string) => boolean; add: (id: string) => void } {
  const [ids, setIds] = useState<string[]>(() => read(key));
  const add = useCallback((id: string) => setIds((cur) => {
    const next = [...cur.filter((x) => x !== id), id].slice(-CAP);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode: this session only */ }
    return next;
  }), [key]);
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { has, add };
}
