// CampaignsSection — wrapper owning the Campaigns section's data so App.tsx
// only needs two routing cases. Mounts the campaign-tag layer plus the silo
// data hooks (channels, leads, attributions, outreach, 6Sense) once, then
// renders the Overview scorecard or the Tags manager based on `page`.

import type { PageKey } from '../App';
import { useCampaignTags } from '../hooks/useCampaignTags';
import { useChannels } from '../hooks/useChannels';
import { useLeads } from '../hooks/useLeads';
import { useAttributions } from '../hooks/useAttributions';
import { useOutreachSnapshots } from '../hooks/useOutreachSnapshots';
import { useSixSenseSnapshots } from '../hooks/useSixSenseSnapshots';
import { useLinkedinSnapshots } from '../hooks/useLinkedinSnapshots';
import CampaignTagsPage from './CampaignTagsPage';
import CampaignsOverviewPage from './CampaignsOverviewPage';

interface CampaignsSectionProps {
  page: 'campaigns-overview' | 'campaigns-tags';
  onNavigate: (p: PageKey) => void;
}

export default function CampaignsSection({
  page,
  onNavigate,
}: CampaignsSectionProps) {
  const tagsHook = useCampaignTags();
  const channels = useChannels();
  const { leads, loading: leadsLoading } = useLeads();
  const { attributions, loading: attrsLoading } = useAttributions();
  const { snapshots: outreachSnapshots, loading: outreachLoading } =
    useOutreachSnapshots();
  const { snapshots: sixSenseSnapshots, loading: sixSenseLoading } =
    useSixSenseSnapshots();
  const { snapshots: linkedinSnapshots, loading: linkedinLoading } =
    useLinkedinSnapshots();

  if (page === 'campaigns-tags') {
    return (
      <CampaignTagsPage
        tagsHook={tagsHook}
        channels={channels}
        outreachSnapshots={outreachSnapshots}
        sixSenseSnapshots={sixSenseSnapshots}
        linkedinSnapshots={linkedinSnapshots}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <CampaignsOverviewPage
      tagsHook={tagsHook}
      channels={channels}
      leads={leads}
      attributions={attributions}
      outreachSnapshots={outreachSnapshots}
      sixSenseSnapshots={sixSenseSnapshots}
      linkedinSnapshots={linkedinSnapshots}
      loading={
        leadsLoading ||
        attrsLoading ||
        outreachLoading ||
        sixSenseLoading ||
        linkedinLoading
      }
      onNavigate={onNavigate}
    />
  );
}
