// BdrSection — wrapper that owns the BDR section's data + state so App.tsx
// only needs two routing cases. Mounts the hooks (attributions/touches/
// channels/quotas), the password gate, the deal-editor modal (shared by the
// dashboard's matched-deal edit pencils), and renders the Dashboard or Quotas
// sub-page based on `page`.

import { useState } from 'react';
import type { PageKey } from '../App';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useChannels } from '../hooks/useChannels';
import { useBdrQuotas } from '../hooks/useBdrQuotas';
import BdrGate from '../components/bdr/BdrGate';
import AttributionEditorModal from '../components/attribution/AttributionEditorModal';
import BdrDashboardPage from './BdrDashboardPage';
import BdrQuotasPage from './BdrQuotasPage';

interface BdrSectionProps {
  page: 'bdr-quota-dashboard' | 'bdr-quota-quotas';
  onNavigate: (p: PageKey) => void;
}

export default function BdrSection({ page, onNavigate }: BdrSectionProps) {
  return (
    <BdrGate>
      <BdrSectionInner page={page} onNavigate={onNavigate} />
    </BdrGate>
  );
}

function BdrSectionInner({ page, onNavigate }: BdrSectionProps) {
  const attributionsHook = useAttributions();
  const touchesHook = useAttributionTouches();
  const channels = useChannels();
  const { quotas, loading: quotasLoading, upsert } = useBdrQuotas();

  const [editingAttributionId, setEditingAttributionId] = useState<
    string | null
  >(null);

  const loading =
    attributionsHook.loading || touchesHook.loading || quotasLoading;

  return (
    <>
      {page === 'bdr-quota-dashboard' ? (
        <BdrDashboardPage
          attributions={attributionsHook.attributions}
          attributionTouches={touchesHook.touches}
          channels={channels}
          quotas={quotas}
          loading={loading}
          onNavigate={onNavigate}
          onEditDeal={setEditingAttributionId}
        />
      ) : (
        <BdrQuotasPage
          quotas={quotas}
          loading={quotasLoading}
          upsert={upsert}
          onNavigate={onNavigate}
        />
      )}

      {editingAttributionId && (
        <AttributionEditorModal
          attributionId={editingAttributionId}
          channels={channels}
          attributionsHook={attributionsHook}
          touchesHook={touchesHook}
          onClose={() => setEditingAttributionId(null)}
        />
      )}
    </>
  );
}
