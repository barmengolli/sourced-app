// LeadsGate — section-level password gate for the Leads page.
//
// While locked, children are NOT mounted: the page renders a
// centered password prompt instead. This is the security contract
// — locked state has no PII anywhere in the DOM because the rest
// of the page never enters the React tree.
//
// Unlock requires VITE_REVEAL_PII_PASSWORD. State is React-only:
// defaults to locked on every mount, no storage. Re-lock triggers:
//   - 10-minute idle timer (any interaction inside the gate
//     subtree resets it, debounced 500ms)
//   - Manual Lock button via the exposed context's lock()
//   - Component unmount (navigating away from Leads)
//   - Page reload (default-locked initial state)
//
// Not a real access boundary: rows still ship from Supabase to the
// browser. Defeats shoulder-surfing and screen-share leaks. Real
// fix is audit item F-001 (Supabase Auth + RLS by role).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const IDLE_LIMIT_MS = 10 * 60 * 1000;
const RESET_DEBOUNCE_MS = 500;
const TICK_INTERVAL_MS = 1000;

const CORRECT_PASSWORD = import.meta.env.VITE_REVEAL_PII_PASSWORD as
  | string
  | undefined;

interface LeadsGateContextValue {
  // Immediate re-lock. Visible to any child of the unlocked subtree
  // via useLeadsGate().
  lock: () => void;
  // Seconds until the idle timer fires. Children can display as
  // "Auto-lock in M:SS".
  secondsUntilLock: number;
}

const Context = createContext<LeadsGateContextValue | null>(null);

export function useLeadsGate(): LeadsGateContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    // Outside the unlocked subtree the hook is a no-op so transient
    // mounts don't crash. The Lock button never reaches this branch
    // because it's a child of LeadsGate.
    return { lock: () => undefined, secondsUntilLock: 0 };
  }
  return ctx;
}

export function formatLockCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function LeadsGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [locked, setLocked] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [lastActivity, setLastActivity] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => performance.now());
  const lastResetRef = useRef<number>(0);

  const lock = useCallback(() => {
    setLocked(true);
    setPassword('');
    setError(false);
    setLastActivity(null);
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!CORRECT_PASSWORD) {
        setError(true);
        return;
      }
      if (password === CORRECT_PASSWORD) {
        setError(false);
        setLocked(false);
        setLastActivity(performance.now());
      } else {
        setError(true);
      }
    },
    [password],
  );

  // Activity listeners + tick loop are gated on !locked so the gate
  // is quiet at rest. When unlocked: any interaction resets the
  // idle clock (debounced 500ms); a 1s tick keeps the countdown
  // fresh.
  useEffect(() => {
    if (locked) return;
    const onActivity = () => {
      const t = performance.now();
      if (t - lastResetRef.current < RESET_DEBOUNCE_MS) return;
      lastResetRef.current = t;
      setLastActivity(t);
    };
    window.addEventListener('mousemove', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity);
    window.addEventListener('scroll', onActivity, { passive: true });
    window.addEventListener('click', onActivity);
    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('scroll', onActivity);
      window.removeEventListener('click', onActivity);
    };
  }, [locked]);

  useEffect(() => {
    if (locked) return;
    const id = window.setInterval(() => {
      setNow(performance.now());
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [locked]);

  // Auto-lock when idle limit reached.
  useEffect(() => {
    if (locked || lastActivity === null) return;
    if (now - lastActivity >= IDLE_LIMIT_MS) {
      lock();
    }
  }, [locked, lastActivity, now, lock]);

  const secondsUntilLock = useMemo(() => {
    if (locked || lastActivity === null) return 0;
    const remainingMs = Math.max(0, IDLE_LIMIT_MS - (now - lastActivity));
    return Math.ceil(remainingMs / 1000);
  }, [locked, lastActivity, now]);

  const ctxValue = useMemo<LeadsGateContextValue>(
    () => ({ lock, secondsUntilLock }),
    [lock, secondsUntilLock],
  );

  if (locked) {
    return (
      <div className="flex h-screen min-h-0 items-center justify-center bg-muted">
        <form
          onSubmit={handleSubmit}
          className="bg-bg rounded-xl shadow-sm border border-border p-6 w-full max-w-sm space-y-4"
        >
          <h2 className="text-base font-semibold text-charcoal text-center">
            Enter password to view leads
          </h2>
          <p className="text-xs text-slate-muted text-center">
            Leads PII is gated. Auto-locks after 10 minutes of inactivity.
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(false);
            }}
            placeholder="Password"
            autoFocus
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
          />
          {error && (
            <p className="text-danger text-sm">
              {CORRECT_PASSWORD
                ? 'Incorrect password'
                : 'Leads gate is not configured (VITE_REVEAL_PII_PASSWORD).'}
            </p>
          )}
          <button
            type="submit"
            className="w-full py-2 bg-indigo hover:opacity-90 text-white text-sm font-medium rounded-lg transition-opacity"
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return <Context.Provider value={ctxValue}>{children}</Context.Provider>;
}
