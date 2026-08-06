// CampaignsSection — wrapper owning the Campaigns section's data so App.tsx
// only needs two routing cases. Mounts the campaign-tag layer plus the silo
// data hooks (channels, leads, attributions, outreach, 6Sense) once, then
// renders the Overview scorecard or the Tags manager based on `page`.

import type { PageKey } from '../App';
import { useCampaignTags } from '../hooks/useCampaignTags';
import { useChannels } from '../hooks/useChannels';
import { useLeads } from '../hooks/useLeads';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useOutreachSnapshots } from '../hooks/useOutreachSnapshots';
import { useSixSenseSnapshots } from '../hooks/useSixSenseSnapshots';
import { useLinkedinSnapshots } from '../hooks/useLinkedinSnapshots';
import CampaignTagsPage from './CampaignTagsPage';
import CampaignsOverviewPage from './CampaignsOverviewPage';
import type { ComparisonMode, ReportingPeriod } from '../types/reporting';

interface CampaignsSectionProps {
  // Shared reporting selection, threaded to the Overview page.
  explicitPeriod: ReportingPeriod | null;
  comparison: ComparisonMode;
  onPeriodChange: (p: ReportingPeriod) => void;
  onComparisonChange: (m: ComparisonMode) => void;
  page: 'campaigns-overview' | 'campaigns-tags';
  onNavigate: (p: PageKey) => void;
}

export default function CampaignsSection({
  page,
  onNavigate,
  explicitPeriod,
  comparison,
  onPeriodChange,
  onComparisonChange,
}: CampaignsSectionProps) {
  const tagsHook = useCampaignTags();
  const channels = useChannels();
  const { leads, loading: leadsLoading } = useLeads();
  const { attributions, loading: attrsLoading } = useAttributions();
  // Touches let a campaign see deals it influenced without having sourced.
  const { touches: attributionTouches, loading: touchesLoading } =
    useAttributionTouches();
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
      explicitPeriod={explicitPeriod}
      comparison={comparison}
      onPeriodChange={onPeriodChange}
      onComparisonChange={onComparisonChange}
      tagsHook={tagsHook}
      channels={channels}
      leads={leads}
      attributions={attributions}
      attributionTouches={attributionTouches}
      outreachSnapshots={outreachSnapshots}
      sixSenseSnapshots={sixSenseSnapshots}
      linkedinSnapshots={linkedinSnapshots}
      loading={
        leadsLoading ||
        attrsLoading ||
        touchesLoading ||
        outreachLoading ||
        sixSenseLoading ||
        linkedinLoading
      }
      onNavigate={onNavigate}
    />
  );
}
