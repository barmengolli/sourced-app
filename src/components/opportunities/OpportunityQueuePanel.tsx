import { useEffect, useMemo, useState } from 'react';
import OpportunityQueueManager, { type QueueChannelOption } from './OpportunityQueueManager';
import { createOpportunityQueueHttpRepository } from '../../lib/opportunityQueueHttpRepository';

type SessionState = 'checking' | 'locked' | 'ready' | 'unavailable';

export default function OpportunityQueuePanel({ channels }: { channels: QueueChannelOption[] }) {
  const [state, setState] = useState<SessionState>('checking');
  const [password, setPassword] = useState('');
  const [csrf, setCsrf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const repository = useMemo(() => createOpportunityQueueHttpRepository(() => csrf), [csrf]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/opportunity-queue', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'session' }),
    }).then(async (response) => {
      const body = await response.json() as { ok: boolean; data?: { csrf: string } };
      if (cancelled) return;
      if (response.ok && body.ok && body.data) {
        setCsrf(body.data.csrf);
        setState('ready');
      } else {
        setState(response.status === 401 ? 'locked' : 'unavailable');
      }
    }).catch(() => { if (!cancelled) setState('unavailable'); });
    return () => { cancelled = true; };
  }, []);

  const login = async () => {
    setError(null);
    const response = await fetch('/api/opportunity-queue', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'login', password }),
    });
    const body = await response.json() as { ok: boolean; data?: { csrf: string }; error?: { message: string } };
    if (!response.ok || !body.ok || !body.data) {
      setError(body.error?.message ?? 'Unlock failed');
      return;
    }
    setPassword('');
    setCsrf(body.data.csrf);
    setState('ready');
  };

  if (state === 'checking') return <p className="text-sm text-slate-muted p-4">Checking queue access…</p>;
  if (state === 'unavailable') {
    return <p className="text-sm text-danger p-4">The secure Opportunity queue API is not configured.</p>;
  }
  if (state === 'locked') {
    return (
      <form className="p-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void login(); }}>
        <div>
          <h2 className="text-base font-semibold text-charcoal">Unlock Opportunity review</h2>
          <p className="text-xs text-slate-muted">This protects decisions that change production reporting.</p>
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <input type="password" aria-label="Opportunity queue password" value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="text-sm px-3 py-2 border border-border rounded bg-bg" />
          <button type="submit" className="text-xs px-3 py-2 rounded bg-indigo text-white">Unlock</button>
        </div>
      </form>
    );
  }
  return <OpportunityQueueManager repository={repository} channels={channels} live />;
}
