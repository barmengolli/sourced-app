import { useState, useCallback } from 'react';

const STORAGE_KEY = 'sourced_unlocked';

// Read at module init so the value is captured once. If the env var is missing
// we render an explicit misconfiguration error rather than letting anyone in
// with a baked-in fallback (F-004).
const CORRECT_PASSWORD = import.meta.env.VITE_APP_PASSWORD as string | undefined;

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(STORAGE_KEY) === 'true'
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!CORRECT_PASSWORD) return;
      if (password === CORRECT_PASSWORD) {
        sessionStorage.setItem(STORAGE_KEY, 'true');
        setUnlocked(true);
        setError(false);
      } else {
        setError(true);
      }
    },
    [password],
  );

  if (unlocked) return <>{children}</>;

  if (!CORRECT_PASSWORD) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center">
        <div className="bg-bg rounded-xl shadow-sm border border-border p-8 w-full max-w-sm space-y-3">
          <div className="flex items-center justify-center gap-2">
            <img
              src="/sourced-mark.png"
              alt="sourced"
              className="w-10 h-10 object-contain"
            />
            <span className="text-lg font-semibold text-charcoal lowercase">sourced</span>
          </div>
          <h1 className="text-base font-semibold text-charcoal text-center">
            App misconfigured
          </h1>
          <p className="text-sm text-slate-muted text-center">
            VITE_APP_PASSWORD is not set. The deployment is missing required
            configuration; sign-in is disabled until it is added.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted flex items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="bg-bg rounded-xl shadow-sm border border-border p-8 w-full max-w-sm space-y-4"
      >
        <div className="flex items-center justify-center gap-2">
          <img
            src="/sourced-mark.png"
            alt="sourced"
            className="w-10 h-10 object-contain"
          />
          <span className="text-lg font-semibold text-charcoal lowercase">sourced</span>
        </div>
        <p className="text-sm text-slate-muted text-center">Enter password to continue</p>
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
        {error && <p className="text-danger text-sm">Incorrect password</p>}
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
