import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// One-time cleanup: a previous patch persisted parent-row collapse state to
// localStorage under sourced.funnelCollapsed.<channelId>. The current
// behavior is in-memory only (resets on every page load). Sweep the
// orphaned keys once so the namespace stays clean. Can remove later.
try {
  const stale = Object.keys(window.localStorage).filter((k) =>
    k.startsWith('sourced.funnelCollapsed.'),
  );
  for (const k of stale) window.localStorage.removeItem(k);
} catch {
  // localStorage may be unavailable in some sandboxed contexts; ignore.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
