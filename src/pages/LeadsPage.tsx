import { useEffect, useMemo, useState } from 'react';
import type { PageKey } from '../App';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import type { Lead, StageKey } from '../types/db';
import { STAGE_ORDER } from '../constants/stages';
import LeadsFilterBar from '../components/leads/LeadsFilterBar';
import LeadsTable, { type LeadSortKey } from '../components/leads/LeadsTable';
import LeadDetailDrawer from '../components/leads/LeadDetailDrawer';
import LeadsGate, {
  formatLockCountdown,
  useLeadsGate,
} from '../components/leads/LeadsGate';

interface LeadsPageProps {
  onNavigate?: (page: PageKey) => void;
}

function uniqueValues(leads: Lead[], key: 'country' | 'owner'): string[] {
  const set = new Set<string>();
  for (const l of leads) {
    const v = l[key];
    if (v && v.trim() !== '') set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function LeadsPage(props: LeadsPageProps = {}) {
  return (
    <LeadsGate>
      <LeadsPageContent {...props} />
    </LeadsGate>
  );
}

function LeadsPageContent({ onNavigate }: LeadsPageProps) {
  const {
    leads,
    loading,
    error,
    createLead,
    editField,
    toggleLock,
    revertField,
    setStageHistory,
    deleteLead,
  } = useLeads();
  const channels = useChannels();

  const [stageFilter, setStageFilter] = useState<Set<StageKey>>(
    () => new Set(STAGE_ORDER),
  );
  const [countryFilter, setCountryFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput, 200);

  const [sortKey, setSortKey] = useState<LeadSortKey>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const countries = useMemo(() => uniqueValues(leads, 'country'), [leads]);
  const owners = useMemo(() => uniqueValues(leads, 'owner'), [leads]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (!stageFilter.has(l.current_stage)) return false;
      if (countryFilter && l.country !== countryFilter) return false;
      if (ownerFilter && l.owner !== ownerFilter) return false;
      if (q) {
        const hay =
          (l.email ?? '') +
          ' ' +
          (l.first_name ?? '') +
          ' ' +
          (l.last_name ?? '') +
          ' ' +
          (l.account ?? '');
        if (!hay.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [leads, stageFilter, countryFilter, ownerFilter, search]);

  const selectedLead = selectedLeadId
    ? leads.find((l) => l.id === selectedLeadId) ?? null
    : null;

  // Close the drawer if its lead disappears (deleted, or filtered out by realtime).
  useEffect(() => {
    if (selectedLeadId && !leads.some((l) => l.id === selectedLeadId)) {
      setSelectedLeadId(null);
    }
  }, [selectedLeadId, leads]);

  const handleSortChange = (k: LeadSortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir(k === 'updated_at' ? 'desc' : 'asc');
    }
  };

  const handleToggleStage = (s: StageKey) => {
    setStageFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };
  const handleSetAllStages = (all: boolean) => {
    setStageFilter(all ? new Set(STAGE_ORDER) : new Set());
  };

  const submitNewLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    try {
      const created = await createLead({ email: newEmail });
      setNewEmail('');
      setCreating(false);
      setSelectedLeadId(created.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  return (
    <div className="flex h-screen min-h-0">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <header className="px-8 pt-8 pb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-charcoal">Leads</h1>
            <p className="mt-1 text-sm text-slate-muted">
              {loading
                ? 'Loading'
                : `${filtered.length} of ${leads.length} ${
                    leads.length === 1 ? 'lead' : 'leads'
                  }`}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <LockLeadsButton />
            {onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('funnel-import')}
                className="text-sm px-3 py-1.5 rounded border border-border text-charcoal hover:bg-muted"
              >
                Import
              </button>
            )}
            {creating ? (
              <form
                onSubmit={submitNewLead}
                className="flex items-center gap-2"
              >
                <input
                  type="email"
                  required
                  autoFocus
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="text-sm px-2 py-1.5 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
                />
                <button
                  type="submit"
                  className="text-sm px-3 py-1.5 rounded bg-indigo text-white"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewEmail('');
                    setCreateError(null);
                  }}
                  className="text-sm px-2 py-1.5 text-slate-muted hover:text-charcoal"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="text-sm px-3 py-1.5 rounded bg-indigo text-white"
              >
                New lead
              </button>
            )}
            {createError && (
              <p className="text-xs text-danger mt-1">{createError}</p>
            )}
          </div>
        </header>

        {error && (
          <div className="mx-8 mb-3 px-3 py-2 rounded border border-danger/40 bg-danger/5 text-danger text-xs">
            Failed to load leads: {error.message}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-8 pb-8 space-y-3">
          <LeadsFilterBar
            stageFilter={stageFilter}
            onToggleStage={handleToggleStage}
            onSetAllStages={handleSetAllStages}
            countries={countries}
            countryFilter={countryFilter}
            onCountryChange={setCountryFilter}
            owners={owners}
            ownerFilter={ownerFilter}
            onOwnerChange={setOwnerFilter}
            search={searchInput}
            onSearchChange={setSearchInput}
          />

          <LeadsTable
            leads={filtered}
            channels={channels}
            sortKey={sortKey}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            onRowClick={setSelectedLeadId}
            selectedLeadId={selectedLeadId}
          />
        </div>
      </div>

      {selectedLead && (
        <LeadDetailDrawer
          lead={selectedLead}
          channels={channels}
          onClose={() => setSelectedLeadId(null)}
          onEditField={(field, value) =>
            editField(selectedLead.id, field, value as never)
          }
          onToggleLock={(field, locked) =>
            toggleLock(selectedLead.id, field, locked)
          }
          onRevertField={(field) => revertField(selectedLead.id, field)}
          onSetStageHistory={(entries) =>
            setStageHistory(selectedLead.id, entries)
          }
          onDelete={async () => {
            await deleteLead(selectedLead.id);
            setSelectedLeadId(null);
          }}
        />
      )}
    </div>
  );
}

// Header button: immediate re-lock of the Leads section. Visible
// only inside the unlocked LeadsGate subtree. Title attribute
// carries the auto-lock countdown so the user can hover and see
// "Auto-lock in M:SS".
function LockLeadsButton() {
  const { lock, secondsUntilLock } = useLeadsGate();
  return (
    <button
      type="button"
      onClick={lock}
      title={`Auto-lock in ${formatLockCountdown(secondsUntilLock)}`}
      className="text-sm px-3 py-1.5 rounded border border-indigo bg-indigo/10 text-indigo hover:bg-indigo/20"
    >
      Lock Leads
      <span className="ml-1 text-xs text-indigo/70">
        ({formatLockCountdown(secondsUntilLock)})
      </span>
    </button>
  );
}
