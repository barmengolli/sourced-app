import { useState } from 'react';
import PasswordGate from './components/PasswordGate';
import LeadsPage from './pages/LeadsPage';
import ChannelsPage from './pages/ChannelsPage';
import DashboardPage from './pages/DashboardPage';
import CohortPage from './pages/CohortPage';
import SettingsPage from './pages/SettingsPage';
import ImportPage from './pages/ImportPage';

export type PageKey =
  | 'leads'
  | 'channels'
  | 'import'
  | 'dashboard'
  | 'cohort'
  | 'settings';

const NAV: { key: PageKey; label: string }[] = [
  { key: 'leads', label: 'Leads' },
  { key: 'channels', label: 'Channels' },
  { key: 'import', label: 'Import' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'cohort', label: 'Cohort' },
  { key: 'settings', label: 'Settings' },
];

function PageBody({
  page,
  onNavigate,
}: {
  page: PageKey;
  onNavigate: (p: PageKey) => void;
}) {
  switch (page) {
    case 'leads':
      return <LeadsPage onNavigate={onNavigate} />;
    case 'channels':
      return <ChannelsPage onNavigate={onNavigate} />;
    case 'import':
      return <ImportPage />;
    case 'dashboard':
      return <DashboardPage />;
    case 'cohort':
      return <CohortPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

export default function App() {
  const [page, setPage] = useState<PageKey>('leads');

  return (
    <PasswordGate>
      <div className="min-h-screen flex">
        <aside className="w-56 border-r border-border bg-muted flex flex-col">
          <div className="flex items-center gap-2 px-5 py-5 border-b border-border">
            <img src="/sourced-mark.png" alt="" className="w-7 h-7 object-contain" />
            <span className="text-lg font-semibold text-charcoal lowercase">sourced</span>
          </div>
          <nav className="flex-1 p-3 space-y-1">
            {NAV.map((item) => {
              const active = item.key === page;
              return (
                <button
                  key={item.key}
                  onClick={() => setPage(item.key)}
                  className={
                    'w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ' +
                    (active
                      ? 'bg-indigo text-white'
                      : 'text-charcoal hover:bg-border/60')
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </aside>
        <main className="flex-1 min-w-0">
          <PageBody page={page} onNavigate={setPage} />
        </main>
      </div>
    </PasswordGate>
  );
}
