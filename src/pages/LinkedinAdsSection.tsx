// LinkedinAdsSection — wrapper owning the LinkedIn Ads section's data so App.tsx
// needs one routing case. Mounts the snapshots hook and renders the dashboard.

import { useLinkedinSnapshots } from '../hooks/useLinkedinSnapshots';
import LinkedinDashboardPage from './LinkedinDashboardPage';

export default function LinkedinAdsSection() {
  const { snapshots, loading } = useLinkedinSnapshots();
  return <LinkedinDashboardPage snapshots={snapshots} loading={loading} />;
}
