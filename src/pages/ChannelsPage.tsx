import type { PageKey } from '../App';
import { useChannels } from '../hooks/useChannels';
import { useChannelMutations } from '../hooks/useChannelMutations';
import { useChannelLeadCounts } from '../hooks/useChannelLeadCounts';
import ChannelManager from '../components/channels/ChannelManager';

interface ChannelsPageProps {
  onNavigate?: (page: PageKey) => void;
}

export default function ChannelsPage({ onNavigate }: ChannelsPageProps = {}) {
  const channels = useChannels();
  const leadCounts = useChannelLeadCounts();
  const mutations = useChannelMutations(channels);

  return (
    <div className="p-8 space-y-4 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold text-charcoal">Channels</h1>
        <p className="mt-1 text-sm text-slate-muted">
          Two-level taxonomy seeded from SFDC's parent campaign and campaign
          name. Rename, reorder, hide, or merge channels here. Lead counts
          update live from the leads table.
        </p>
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
      />
    </div>
  );
}
