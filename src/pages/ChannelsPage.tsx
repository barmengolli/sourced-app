import { useState } from 'react';
import type { PageKey } from '../App';
import { useChannels } from '../hooks/useChannels';
import { useChannelMutations } from '../hooks/useChannelMutations';
import { useChannelLeadCounts } from '../hooks/useChannelLeadCounts';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import ChannelManager from '../components/channels/ChannelManager';

interface ChannelsPageProps {
  onNavigate?: (page: PageKey) => void;
}

export default function ChannelsPage({ onNavigate }: ChannelsPageProps = {}) {
  const channels = useChannels();
  const leadCounts = useChannelLeadCounts();
  const mutations = useChannelMutations(channels);
  const costsHook = useCampaignCosts();

  // Year used by the BudgetEditor's quick-fill helpers (This year / Q1
  // / Q2 / Q3 / Q4). Lives on this page so it persists across row
  // expand/collapse but resets on full reload.
  const [budgetYear, setBudgetYear] = useState<number>(
    () => new Date().getFullYear(),
  );

  // Year options span recent past / current / next so users can
  // backfill or plan ahead. Cap at +/- 1 since the budget UI is
  // for the working year, not historical archeology.
  const yearOptions = [budgetYear - 1, budgetYear, budgetYear + 1];

  return (
    <div className="p-8 space-y-4 max-w-4xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">Channels</h1>
          <p className="mt-1 text-sm text-slate-muted">
            Two-level taxonomy seeded from SFDC's parent campaign and campaign
            name. Rename, reorder, hide, or merge channels here. Lead counts
            update live from the leads table.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-muted">
          Budget quick-fill year
          <select
            value={budgetYear}
            onChange={(e) => setBudgetYear(parseInt(e.target.value, 10))}
            className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </header>

      {channels.length === 0 && onNavigate && (
        <div className="border border-border rounded-lg bg-muted p-4 text-sm text-charcoal">
          No channels yet.{' '}
          <button
            type="button"
            onClick={() => onNavigate('funnel-import')}
            className="text-indigo hover:underline"
          >
            Run an import
          </button>{' '}
          to seed the channel tree from a SFDC report.
        </div>
      )}

      <ChannelManager
        channels={channels}
        leadCounts={leadCounts}
        mutations={mutations}
        costs={costsHook.costs}
        costsHook={costsHook}
        budgetYear={budgetYear}
      />
    </div>
  );
}
