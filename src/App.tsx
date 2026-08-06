import { useCallback, useEffect, useRef, useState } from 'react';
import PasswordGate from './components/PasswordGate';
import Sidebar from './components/Sidebar';
import LeadsPage from './pages/LeadsPage';
import ChannelsPage from './pages/ChannelsPage';
import SettingsPage from './pages/SettingsPage';
import UserManualPage from './pages/UserManualPage';
import FeedbackPage from './pages/FeedbackPage';
import FunnelImportPage from './pages/FunnelImportPage';
import FunnelDataEntryPage from './pages/FunnelDataEntryPage';
import FunnelDashboardPage from './pages/FunnelDashboardPage';
import FunnelComparePage from './pages/FunnelComparePage';
import FunnelEventsPage from './pages/FunnelEventsPage';
import FunnelSpendPage from './pages/FunnelSpendPage';
import FunnelVelocityPage from './pages/FunnelVelocityPage';
import OutreachDataPage from './pages/OutreachDataPage';
import OutreachDashboardPage from './pages/OutreachDashboardPage';
// OutreachComparePage source is retained but no longer routed (Bite 3C).
import SixSenseDashboardPage from './pages/SixSenseDashboardPage';
import SixSenseImportPage from './pages/SixSenseImportPage';
import BdrSection from './pages/BdrSection';
import CampaignsSection from './pages/CampaignsSection';
import LinkedinAdsSection from './pages/LinkedinAdsSection';
import { useOutreachSnapshots } from './hooks/useOutreachSnapshots';
import { useSixSenseSnapshots } from './hooks/useSixSenseSnapshots';
import type { OutreachSnapshot, SixSenseSnapshot } from './types/db';
import type { ComparisonMode, ReportingPeriod } from './types/reporting';
import type { SixSenseSnapshotInput } from './lib/sixsense';
import { sectionForPage, SIDEBAR_SECTIONS } from './constants/sidebar';
import { readJson, writeJson } from './lib/storage';
import { redirectRetiredPage } from './lib/retiredRoutes';
import { currentIsoWeek, currentQuarter } from './lib/dates';
import type { PeriodFilter } from './lib/compute';
import { REGIONS, type RegionKey } from './constants/regions';
import {
  OUTREACH_REGIONS,
  type OutreachRegionKey,
} from './constants/outreachRegions';
import { useReportingSelection } from './hooks/useReportingSelection';
import { toPeriodFilter, fromPeriodFilter } from './lib/reportingPeriodBridge';

export type PageKey =
  | 'funnel-data'
  | 'funnel-dashboard'
  | 'funnel-events'
  | 'funnel-velocity'
  | 'funnel-spend'
  | 'funnel-compare'
  | 'outreach-data'
  | 'outreach-dashboard'
  | 'outreach-compare'
  | 'sixsense-dashboard'
  | 'sixsense-import'
  | 'bdr-quota-dashboard'
  | 'bdr-quota-quotas'
  | 'campaigns-overview'
  | 'campaigns-tags'
  | 'linkedin-dashboard'
  | 'leads'
  | 'channels'
  | 'funnel-import'
  | 'settings'
  | 'user-manual'
  | 'feedback';

// Initial page: pick from the Funnel section's lastTabStorageKey if present,
// else its defaultChild. So returning users land on whatever Funnel sub-tab
// they were last on.
function initialPage(): PageKey {
  const funnel = SIDEBAR_SECTIONS.find((s) => s.id === 'funnel');
  if (!funnel) return 'funnel-data';
  const last = readJson<PageKey | null>(funnel.lastTabStorageKey, null);
  if (last && funnel.children.some((c) => c.key === last)) return redirectRetiredPage(last);
  return funnel.defaultChild;
}

export type CompareView = 'single' | 'rolling3';

interface FunnelSubPageProps {
  year: number;
  filter: PeriodFilter;
  // Comparison mode from the shared reporting selection, so every funnel page
  // compares the same way and a change on one carries to the others.
  comparison: ComparisonMode;
  onComparisonChange: (m: ComparisonMode) => void;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
  // Compare-tab state. Lifted alongside year/filter so a user bouncing
  // between Compare and Data Entry doesn't lose their month selection.
  compareMonth: number;          // 1..12, calendar month
  onCompareMonthChange: (m: number) => void;
  compareView: CompareView;
  onCompareViewChange: (v: CompareView) => void;
}

// Outreach sub-tabs share the same selectors (year/quarter/week/region/
// sequences) so navigating between Data and Dashboard preserves the user's
// view. Sequences is a Set<number> of sequence_ids; an empty set means
// "All Sequences" (the multi-select treats empty and all-selected the
// same, matching DataVis 1's contract).
export interface OutreachSubPageProps {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  week: number;
  // Dashboard reporting selection (Bite 3B): shared Month/Quarter/Year period
  // plus comparison mode. null period = not yet chosen; the Dashboard derives
  // its data-driven default during render. Lifted here so explicit selections
  // survive navigation between Outreach sub-tabs and realtime updates.
  dashboardPeriod: ReportingPeriod | null;
  dashboardComparison: ComparisonMode;
  regions: Set<OutreachRegionKey>;
  selectedSequences: Set<number>;
  onYearChange: (y: number) => void;
  onQuarterChange: (q: 1 | 2 | 3 | 4) => void;
  onWeekChange: (w: number) => void;
  onDashboardPeriodChange: (p: ReportingPeriod) => void;
  onDashboardComparisonChange: (m: ComparisonMode) => void;
  onRegionsChange: (next: Set<OutreachRegionKey>) => void;
  onSelectedSequencesChange: (next: Set<number>) => void;
  // Snapshots are loaded once at the App level (via useOutreachSnapshots
  // there) and threaded down so the three sub-pages share one query and
  // one realtime subscription.
  snapshots: OutreachSnapshot[];
  loading: boolean;
}

// 6sense sub-tabs (Dashboard + Import) share one snapshot query and realtime
// subscription, mounted once at App level. There are no shared period/region
// selectors: the Dashboard owns its own snapshot-date picker and the Import
// page is standalone, so this carries just the data and the upsert writer.
export interface SixSenseSubPageProps {
  snapshots: SixSenseSnapshot[];
  loading: boolean;
  // Shared reporting selection, so a period chosen here survives navigation to
  // and from the other reporting pages.
  explicitPeriod: ReportingPeriod | null;
  comparison: ComparisonMode;
  onPeriodChange: (p: ReportingPeriod) => void;
  onComparisonChange: (m: ComparisonMode) => void;
  upsertSnapshot: (input: SixSenseSnapshotInput) => Promise<SixSenseSnapshot>;
  renameSegment: (from: string, to: string) => Promise<void>;
  onNavigate: (p: PageKey) => void;
}

// The shared reporting selection, passed to sections that own their own data
// hooks (BDR, Campaigns, LinkedIn) rather than receiving a props bundle.
export interface SharedReportingProps {
  explicitPeriod: ReportingPeriod | null;
  comparison: ComparisonMode;
  onPeriodChange: (p: ReportingPeriod) => void;
  onComparisonChange: (m: ComparisonMode) => void;
}

function PageBody({
  page,
  onNavigate,
  funnelProps,
  outreachProps,
  sixSenseProps,
  reportingProps,
}: {
  page: PageKey;
  onNavigate: (p: PageKey) => void;
  funnelProps: FunnelSubPageProps;
  outreachProps: OutreachSubPageProps;
  sixSenseProps: SixSenseSubPageProps;
  reportingProps: SharedReportingProps;
}) {
  switch (page) {
    case 'funnel-data':
      return <FunnelDataEntryPage {...funnelProps} />;
    case 'funnel-dashboard':
      return <FunnelDashboardPage {...funnelProps} />;
    case 'funnel-events':
      return <FunnelEventsPage {...funnelProps} />;
    case 'funnel-velocity':
      return <FunnelVelocityPage {...funnelProps} />;
    case 'funnel-spend':
      return <FunnelSpendPage {...funnelProps} />;
    case 'funnel-compare':
      return <FunnelComparePage {...funnelProps} />;
    case 'outreach-data':
      return <OutreachDataPage {...outreachProps} />;
    // 'outreach-compare' is retired (Bite 3C): redirectRetiredPage normalizes
    // it to 'outreach-dashboard' in both navigate() and initialPage(), so the
    // page state never holds the retired key and no route case is needed.
    case 'outreach-dashboard':
      return <OutreachDashboardPage {...outreachProps} />;
    case 'sixsense-dashboard':
      return <SixSenseDashboardPage {...sixSenseProps} />;
    case 'sixsense-import':
      return <SixSenseImportPage {...sixSenseProps} />;
    case 'bdr-quota-dashboard':
    case 'bdr-quota-quotas':
      return (
        <BdrSection page={page} onNavigate={onNavigate} {...reportingProps} />
      );
    case 'campaigns-overview':
    case 'campaigns-tags':
      return (
        <CampaignsSection
          page={page}
          onNavigate={onNavigate}
          {...reportingProps}
        />
      );
    case 'linkedin-dashboard':
      return <LinkedinAdsSection />;
    case 'funnel-import':
      return <FunnelImportPage />;
    case 'leads':
      return <LeadsPage onNavigate={onNavigate} />;
    case 'channels':
      return <ChannelsPage onNavigate={onNavigate} />;
    case 'settings':
      return <SettingsPage />;
    case 'user-manual':
      return <UserManualPage />;
    case 'feedback':
      return <FeedbackPage />;
  }
}

export default function App() {
  const [page, setPage] = useState<PageKey>(initialPage);

  // The ONE reporting selection shared by every in-scope reporting page, so an
  // explicit period survives navigation between reporting tabs. It holds only
  // a real user choice; each page still derives its own default from its own
  // data until then. See useReportingSelection for why a shared DEFAULT would
  // be wrong while a shared CHOICE is right.
  const reporting = useReportingSelection();

  // Legacy funnel selectors. These remain because the funnel calculator still
  // speaks PeriodFilter ('year' | 'Q1'..'Q4'); adding a month grain to it is a
  // separate calculation change with its own reconciliation.
  //
  // They are now DERIVED from the shared reporting selection whenever the user
  // has made one, so the shared bar and the legacy calculator can never
  // disagree about the visible period. Until then they keep their existing
  // calendar-quarter default.
  const initialQ = currentQuarter();
  const [legacyYear, setLegacyYear] = useState<number>(initialQ.year);
  const [legacyFilter, setLegacyFilter] = useState<PeriodFilter>(
    `Q${initialQ.quarter}` as PeriodFilter,
  );
  const sharedFilter = reporting.explicitPeriod
    ? toPeriodFilter(reporting.explicitPeriod)
    : null;
  // A month selection has no legacy equivalent and is NEVER widened to its
  // quarter; the funnel pages disable Month for exactly this reason, so this
  // only guards a period chosen on a month-capable page.
  const year = reporting.explicitPeriod?.year ?? legacyYear;
  const filter = sharedFilter ?? legacyFilter;

  // Writing through the legacy setters also updates the shared selection, so a
  // quarter picked on a funnel page carries to LinkedIn and Outreach.
  const setYear = useCallback(
    (y: number) => {
      setLegacyYear(y);
      reporting.setPeriod(fromPeriodFilter(y, filter));
    },
    [filter, reporting],
  );
  const setFilter = useCallback(
    (f: PeriodFilter) => {
      setLegacyFilter(f);
      reporting.setPeriod(fromPeriodFilter(year, f));
    },
    [year, reporting],
  );
  // Region filter: defaults to all-on. React state only, matches the
  // year/filter lifecycle (resets to all-on on full reload, persists
  // across Funnel sub-tab switches).
  const [regions, setRegions] = useState<Set<RegionKey>>(
    () => new Set<RegionKey>(REGIONS),
  );
  // Compare tab: default to the current calendar month, single-month view.
  const [compareMonth, setCompareMonth] = useState<number>(
    () => new Date().getMonth() + 1,
  );
  const [compareView, setCompareView] = useState<CompareView>('single');

  // Outreach selectors. Independent from the Funnel selectors so the two
  // domains don't fight over the same week/quarter. Defaults to current
  // ISO week's quarter, current week, all regions, all sequences.
  const initialIso = currentIsoWeek();
  const initialOutreachQuarter = (() => {
    const w = initialIso.week;
    if (w <= 13) return 1 as const;
    if (w <= 26) return 2 as const;
    if (w <= 39) return 3 as const;
    return 4 as const;
  })();
  const [outreachYear, setOutreachYear] = useState<number>(initialIso.year);
  const [outreachQuarter, setOutreachQuarter] = useState<1 | 2 | 3 | 4>(
    initialOutreachQuarter,
  );
  const [outreachWeek, setOutreachWeek] = useState<number>(initialIso.week);
  // Dashboard reporting selection (Bite 3B). Lifted here so a user's explicit
  // period/comparison choice survives navigation between Outreach sub-tabs and
  // realtime snapshot updates. null period = "not chosen yet"; the Dashboard
  // derives its default (the Month containing the latest export_date) during
  // render, so no effect ever resets a user selection and the browser clock
  // never picks the data default.
  const [outreachPeriod, setOutreachPeriod] = useState<ReportingPeriod | null>(
    null,
  );
  const [outreachComparison, setOutreachComparison] =
    useState<ComparisonMode>('previous_period');
  const [outreachRegions, setOutreachRegions] = useState<
    Set<OutreachRegionKey>
  >(() => new Set<OutreachRegionKey>(OUTREACH_REGIONS));
  // Empty set = "All Sequences". The dashboard's multi-select treats empty
  // and full-selected identically.
  const [outreachSelectedSequences, setOutreachSelectedSequences] = useState<
    Set<number>
  >(() => new Set<number>());

  // Snap outreachWeek/Quarter to the latest data once snapshots load. The
  // "user touched it" ref keeps us from re-snapping on every realtime
  // event. Any explicit week/quarter change from the user flips the flag,
  // so subsequent navigation between sub-tabs preserves their selection.
  const outreachWeekTouched = useRef(false);
  const { snapshots: outreachSnapshots, loading: outreachLoading } =
    useOutreachSnapshots();

  // 6sense snapshots: one shared query + realtime subscription for the
  // Dashboard and Import sub-tabs.
  const {
    snapshots: sixSenseSnapshots,
    loading: sixSenseLoading,
    upsertSnapshot: upsertSixSenseSnapshot,
    renameSegment: renameSixSenseSegment,
  } = useSixSenseSnapshots();
  useEffect(() => {
    if (outreachWeekTouched.current) return;
    if (outreachSnapshots.length === 0) return;
    let maxWeek = -1;
    for (const s of outreachSnapshots) {
      if (s.year !== outreachYear) continue;
      if (s.week_number > maxWeek) maxWeek = s.week_number;
    }
    if (maxWeek <= 0) return;
    setOutreachWeek(maxWeek);
    if (maxWeek <= 13) setOutreachQuarter(1);
    else if (maxWeek <= 26) setOutreachQuarter(2);
    else if (maxWeek <= 39) setOutreachQuarter(3);
    else setOutreachQuarter(4);
  }, [outreachSnapshots, outreachYear]);

  // Wrap the lifted setters so any explicit user action from a sub-page
  // marks the week as "touched", preventing the default-to-latest effect
  // from clobbering subsequent navigation.
  const setOutreachWeekUser = useCallback((w: number) => {
    outreachWeekTouched.current = true;
    setOutreachWeek(w);
  }, []);
  const setOutreachQuarterUser = useCallback((q: 1 | 2 | 3 | 4) => {
    outreachWeekTouched.current = true;
    setOutreachQuarter(q);
  }, []);
  const setOutreachYearUser = useCallback((y: number) => {
    // Year change: re-allow auto-snap so we land on the latest week of the
    // newly chosen year (matches how the user expects "show me 2025").
    outreachWeekTouched.current = false;
    setOutreachYear(y);
  }, []);

  // Centralized navigate. Any path to a sub-page (sidebar click, parent
  // click, deep-link from a utility page) flows through here so the
  // "last visited child" record stays consistent.
  const navigate = useCallback((requested: PageKey) => {
    const next = redirectRetiredPage(requested);
    setPage(next);
    const section = sectionForPage(next);
    if (section) {
      writeJson<PageKey>(section.lastTabStorageKey, next);
    }
  }, []);

  const funnelProps: FunnelSubPageProps = {
    comparison: reporting.comparison,
    onComparisonChange: reporting.setComparison,
    year,
    filter,
    onYearChange: setYear,
    onFilterChange: setFilter,
    regions,
    onRegionsChange: setRegions,
    compareMonth,
    onCompareMonthChange: setCompareMonth,
    compareView,
    onCompareViewChange: setCompareView,
  };

  const outreachProps: OutreachSubPageProps = {
    year: outreachYear,
    quarter: outreachQuarter,
    week: outreachWeek,
    dashboardPeriod: outreachPeriod,
    dashboardComparison: outreachComparison,
    regions: outreachRegions,
    selectedSequences: outreachSelectedSequences,
    onYearChange: setOutreachYearUser,
    onQuarterChange: setOutreachQuarterUser,
    onWeekChange: setOutreachWeekUser,
    onDashboardPeriodChange: setOutreachPeriod,
    onDashboardComparisonChange: setOutreachComparison,
    onRegionsChange: setOutreachRegions,
    onSelectedSequencesChange: setOutreachSelectedSequences,
    snapshots: outreachSnapshots,
    loading: outreachLoading,
  };

  const reportingProps: SharedReportingProps = {
    explicitPeriod: reporting.explicitPeriod,
    comparison: reporting.comparison,
    onPeriodChange: reporting.setPeriod,
    onComparisonChange: reporting.setComparison,
  };

  const sixSenseProps: SixSenseSubPageProps = {
    explicitPeriod: reporting.explicitPeriod,
    comparison: reporting.comparison,
    onPeriodChange: reporting.setPeriod,
    onComparisonChange: reporting.setComparison,
    snapshots: sixSenseSnapshots,
    loading: sixSenseLoading,
    upsertSnapshot: upsertSixSenseSnapshot,
    renameSegment: renameSixSenseSegment,
    onNavigate: navigate,
  };

  return (
    <PasswordGate>
      <div className="min-h-screen flex">
        <Sidebar page={page} onNavigate={navigate} />
        <main className="flex-1 min-w-0">
          <PageBody
            page={page}
            onNavigate={navigate}
            funnelProps={funnelProps}
            reportingProps={reportingProps}
            outreachProps={outreachProps}
            sixSenseProps={sixSenseProps}
          />
        </main>
      </div>
    </PasswordGate>
  );
}
