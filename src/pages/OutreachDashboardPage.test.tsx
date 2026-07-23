// @vitest-environment jsdom
//
// Component tests for the migrated Outreach Dashboard (Bite 3B). Synthetic
// data only; no network; fixed dates. The harness mimics App.tsx's lifted
// state so default-derivation, persistence, and realtime behavior are
// exercised through the real prop contract.

import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OutreachDashboardPage from './OutreachDashboardPage';
import type { OutreachSubPageProps } from '../App';
import type { OutreachSnapshot } from '../types/db';
import type { ComparisonMode, ReportingPeriod } from '../types/reporting';
import { OUTREACH_REGIONS, type OutreachRegionKey } from '../constants/outreachRegions';

afterEach(cleanup);

let idc = 0;
function snap(over: Partial<OutreachSnapshot> = {}): OutreachSnapshot {
  idc += 1;
  return {
    id: `s${idc}`,
    export_date: '2026-07-09',
    week_number: 28,
    year: 2026,
    sequence_id: 1,
    sequence_name: '[2026] - NA - Seq A',
    enabled: true,
    step_count: 5,
    duration_days: 30,
    total_sent: 0,
    delivered: 0,
    bounced: 0,
    failed: 0,
    opened: 0,
    clicked: 0,
    replied: 0,
    positive_replies: 0,
    neutral_replies: 0,
    negative_replies: 0,
    opted_out: 0,
    delivery_rate: 0,
    open_rate: 0,
    click_rate: 0,
    reply_rate: 0,
    bounce_rate: 0,
    opt_out_rate: 0,
    contacted_prospects: 0,
    replied_prospects: 0,
    prospects_added: 0,
    prospects_active: 0,
    total_tasks: 0,
    overdue_tasks: 0,
    outbound_calls: 0,
    linkedin_tasks_completed: 0,
    created_at: '2026-07-09T08:00:00Z',
    ...over,
  };
}

// A complete June + July for one sequence: exact Thursday cadence with the
// pre-June boundary (May 28) present, all June Thursdays (Jun 4..25), all July
// Thursdays (Jul 2..30). Counters grow steadily; July totals are computable
// with complete baselines both months.
function fullSummer(seq = 1, name = '[2026] - NA - Seq A'): OutreachSnapshot[] {
  const dates = [
    '2026-05-28', // June's required boundary Thursday
    '2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25', // June Thursdays; Jun 25 is July's boundary
    '2026-07-02', '2026-07-09', '2026-07-16', '2026-07-23', '2026-07-30', // July Thursdays
  ];
  return dates.map((d, i) =>
    snap({
      export_date: d,
      sequence_id: seq,
      sequence_name: name,
      total_sent: 100 + i * 10,
      delivered: 90 + i * 9,
      opened: 40 + i * 4,
      clicked: 12 + i * 2,
      replied: 5 + i,
      outbound_calls: 20 + i * 2,
      linkedin_tasks_completed: 10 + i,
      created_at: `${d}T08:00:00Z`,
    }),
  );
}

// Stateful harness mirroring App.tsx's lifted state contract.
function Harness({
  initialSnapshots,
  initialPeriod = null,
  initialComparison = 'previous_period',
}: {
  initialSnapshots: OutreachSnapshot[];
  initialPeriod?: ReportingPeriod | null;
  initialComparison?: ComparisonMode;
}) {
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [period, setPeriod] = useState<ReportingPeriod | null>(initialPeriod);
  const [comparison, setComparison] = useState<ComparisonMode>(initialComparison);
  const [regions, setRegions] = useState<Set<OutreachRegionKey>>(new Set(OUTREACH_REGIONS));
  const [seqs, setSeqs] = useState<Set<number>>(new Set());
  const [mounted, setMounted] = useState(true);
  const props: OutreachSubPageProps = {
    year: 2026,
    quarter: 3,
    week: 28,
    dashboardPeriod: period,
    dashboardComparison: comparison,
    regions,
    selectedSequences: seqs,
    onYearChange: () => {},
    onQuarterChange: () => {},
    onWeekChange: () => {},
    onDashboardPeriodChange: setPeriod,
    onDashboardComparisonChange: setComparison,
    onRegionsChange: setRegions,
    onSelectedSequencesChange: setSeqs,
    snapshots,
    loading: false,
  };
  return (
    <div>
      <button type="button" onClick={() => setSnapshots((s) => [...s, snap({ export_date: '2026-08-06', sequence_id: 99, sequence_name: '[2026] - NA - Late' })])}>
        simulate-realtime-insert
      </button>
      <button type="button" onClick={() => setMounted((m) => !m)}>toggle-tab</button>
      {mounted ? <OutreachDashboardPage {...props} /> : <div data-testid="other-tab">Data tab</div>}
    </div>
  );
}

describe('controls', () => {
  it('exposes Month, Quarter, Year and no Week option or W-pills', () => {
    render(<Harness initialSnapshots={fullSummer()} />);
    const tf = screen.getByRole('radiogroup', { name: 'Timeframe' });
    expect(within(tf).getByRole('radio', { name: 'Month' })).toBeTruthy();
    expect(within(tf).getByRole('radio', { name: 'Quarter' })).toBeTruthy();
    expect(within(tf).getByRole('radio', { name: 'Year' })).toBeTruthy();
    expect(within(tf).queryByRole('radio', { name: 'Week' })).toBeNull();
    expect(screen.queryByText(/^W\d+$/)).toBeNull();
  });

  it('defaults to the month containing the latest export_date', () => {
    render(<Harness initialSnapshots={fullSummer()} />);
    expect((screen.getByRole('combobox', { name: 'Month' }) as HTMLSelectElement).value).toBe('7');
    expect((screen.getByRole('combobox', { name: 'Year' }) as HTMLSelectElement).value).toBe('2026');
  });

  it('a realtime insert does not override a user-selected period', async () => {
    const user = userEvent.setup();
    render(<Harness initialSnapshots={fullSummer()} />);
    // User selects June explicitly.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '6');
    expect((screen.getByRole('combobox', { name: 'Month' }) as HTMLSelectElement).value).toBe('6');
    // Realtime insert lands an August row; selection must stay June.
    await user.click(screen.getByRole('button', { name: 'simulate-realtime-insert' }));
    expect((screen.getByRole('combobox', { name: 'Month' }) as HTMLSelectElement).value).toBe('6');
  });

  it('period and comparison selections persist across tab navigation', async () => {
    const user = userEvent.setup();
    render(<Harness initialSnapshots={fullSummer()} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '6');
    const compare = screen.getByRole('radiogroup', { name: 'Compare to' });
    await user.click(within(compare).getByRole('radio', { name: 'Off' }));
    // Navigate away and back (state is lifted, page unmounts and remounts).
    await user.click(screen.getByRole('button', { name: 'toggle-tab' }));
    expect(screen.getByTestId('other-tab')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'toggle-tab' }));
    expect((screen.getByRole('combobox', { name: 'Month' }) as HTMLSelectElement).value).toBe('6');
    const compare2 = screen.getByRole('radiogroup', { name: 'Compare to' });
    expect(within(compare2).getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('Off');
  });
});

describe('disclosure, completeness, and suppression', () => {
  it('shows the Derived activity disclosure and the global data-through date', () => {
    render(<Harness initialSnapshots={fullSummer()} />);
    const note = screen.getByRole('note', { name: 'Reporting basis: Derived activity' });
    expect(note.textContent).toBe('Derived activity');
    expect(screen.getByTestId('reporting-basis-disclosure').textContent).toContain(
      'Weekly lifetime counters converted to period activity using exact Thursday baselines.',
    );
    expect(screen.getByTestId('outreach-data-through').textContent).toContain('Data through Jul 30, 2026');
  });

  it('renders deltas for a complete period with a complete comparison', () => {
    render(<Harness initialSnapshots={fullSummer()} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    // July current (complete) vs June comparison (complete) -> deltas visible.
    expect(screen.getAllByTestId('delta-display').length).toBeGreaterThan(0);
    expect(screen.getByText(/· vs June/)).toBeTruthy();
  });

  it('a partial current period suppresses all deltas and shows the marker', () => {
    // Drop the final July Thursday (Jul 30): July becomes partial.
    const partial = fullSummer().filter((s) => s.export_date !== '2026-07-30');
    render(<Harness initialSnapshots={partial} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    expect(screen.getByText('Partial period')).toBeTruthy();
    expect(screen.queryByTestId('delta-display')).toBeNull();
    expect(screen.queryByText(/· vs June/)).toBeNull();
  });

  it('a partial/missing comparison period suppresses deltas', () => {
    // Complete July but no May 28 boundary and only 2 June Thursdays: June is
    // partial -> the July-vs-June deltas are suppressed at the cadence layer.
    const gappyJune = fullSummer().filter(
      (s) => s.export_date !== '2026-06-11' , // missing expected June Thursday
    );
    render(<Harness initialSnapshots={gappyJune} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    expect(screen.queryByTestId('delta-display')).toBeNull();
  });

  it('comparison Off hides every delta and comparison label even when clean', async () => {
    const user = userEvent.setup();
    render(<Harness initialSnapshots={fullSummer()} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    expect(screen.getAllByTestId('delta-display').length).toBeGreaterThan(0);
    const compare = screen.getByRole('radiogroup', { name: 'Compare to' });
    await user.click(within(compare).getByRole('radio', { name: 'Off' }));
    expect(screen.queryByTestId('delta-display')).toBeNull();
    expect(screen.queryByText(/·\s*vs /)).toBeNull();
  });

  it('shows No data for selected period on an empty month', async () => {
    const user = userEvent.setup();
    render(<Harness initialSnapshots={fullSummer()} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '3'); // March: no rows
    expect(screen.getByTestId('outreach-no-period-data').textContent).toContain('No data for selected period.');
    expect(screen.getByTestId('outreach-data-through').textContent).toContain('Jul 30, 2026'); // global preserved
  });
});

describe('LinkedIn coverage gap (verified dates)', () => {
  it('treats the gap dates as missing (not zero) while other metrics stay usable', () => {
    // fullSummer includes 2026-07-16 and 2026-07-23 rows whose linkedin values
    // the adapter nulls. July linkedin end-of-period valid value is Jul 30.
    render(<Harness initialSnapshots={fullSummer()} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    // linkedin KPI is present (Jul 30 valid) but INCOMPLETE (interior nulls).
    const li = screen.getByTestId('kpi-linkedin_tasks_completed');
    expect(within(li).getByTestId('kpi-linkedin_tasks_completed-incomplete')).toBeTruthy();
    // Emails Sent has full coverage -> no incomplete label.
    const sent = screen.getByTestId('kpi-total_sent');
    expect(within(sent).queryByTestId('kpi-total_sent-incomplete')).toBeNull();
  });
});

describe('panels on the safe engine', () => {
  it('KPI cards show safe period totals (never lifetime debuts)', () => {
    render(<Harness initialSnapshots={fullSummer()} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    // July total_sent: Jul 30 (190) - Jun 25 boundary (140) = 50. NOT the
    // lifetime 190 and NOT a debut-volume figure.
    const sent = screen.getByTestId('kpi-total_sent');
    expect(sent.textContent).toContain('50');
    expect(sent.textContent).not.toContain('190');
  });

  it('Region Performance renders selected regions with data, not hardcoded NA/EMEA', () => {
    const rows = [
      ...fullSummer(1, '[2026] - NA - Seq A'),
      ...fullSummer(2, '[2026] - APAC - Seq B'),
    ];
    render(<Harness initialSnapshots={rows} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    const card = screen.getByTestId('outreach-region-performance');
    expect(within(card).getByText('NA')).toBeTruthy();
    expect(within(card).getByText('APAC')).toBeTruthy();
  });

  it('Engagement Funnel recomputes conversion from aggregate stage totals', () => {
    render(<Harness initialSnapshots={fullSummer()} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    const funnel = screen.getByTestId('outreach-funnel');
    // July: sent +50, delivered +45 -> 90.0% delivered/sent conversion.
    expect(funnel.textContent).toContain('90.0%');
  });

  it('Sequence Rankings excludes reset sequences with a visible count instead of ranking them as zero', async () => {
    const user = userEvent.setup();
    const resetSeq = [
      // seq 2 resets inside July (100 -> 40) then partially recovers.
      snap({ export_date: '2026-06-25', sequence_id: 2, sequence_name: '[2026] - NA - Reset', outbound_calls: 100 }),
      snap({ export_date: '2026-07-09', sequence_id: 2, sequence_name: '[2026] - NA - Reset', outbound_calls: 40 }),
      snap({ export_date: '2026-07-30', sequence_id: 2, sequence_name: '[2026] - NA - Reset', outbound_calls: 60 }),
    ];
    render(
      <Harness initialSnapshots={[...fullSummer(), ...resetSeq]} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />,
    );
    const rankings = screen.getByTestId('outreach-rankings');
    // Select the Outbound Calls count metric: seq 1 qualifies (+10), seq 2 is
    // a reset and must be EXCLUDED with a visible count, never ranked as 0.
    await user.selectOptions(
      within(rankings).getByRole('combobox', { name: 'Ranking metric' }),
      '3', // index of Outbound Calls in RANK_METRICS
    );
    expect(within(rankings).getByTestId('outreach-rankings-excluded').textContent).toContain(
      '1 sequence excluded (incomplete data)',
    );
    expect(within(rankings).queryByText('[2026] - NA - Reset')).toBeNull();
  });

  it('Heatmap renders missing cells blank and distinct from measured zeros', () => {
    // Seq with a measured zero July delta (flat counters) + a month gap.
    const flat = ['2026-05-28', '2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25', '2026-07-02', '2026-07-09', '2026-07-16', '2026-07-23', '2026-07-30'].map((d) =>
      snap({ export_date: d, sequence_id: 3, sequence_name: '[2026] - NA - Flat', total_sent: 500, created_at: `${d}T08:00:00Z` }),
    );
    render(<Harness initialSnapshots={flat} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    const heatmap = screen.getByTestId('outreach-heatmap');
    const cells = heatmap.querySelectorAll('td[data-state]');
    const states = [...cells].map((c) => c.getAttribute('data-state'));
    // July + June are measured (zero activity -> present with 0); March/April
    // predate the feed -> missing (blank), visually distinct.
    expect(states).toContain('present');
    expect(states).toContain('missing');
    // A present zero renders "0", a missing cell renders empty.
    const presentCell = [...cells].find((c) => c.getAttribute('data-state') === 'present');
    expect(presentCell?.textContent).toBe('0');
    const missingCell = [...cells].find((c) => c.getAttribute('data-state') === 'missing');
    expect(missingCell?.textContent).toBe('');
  });
});

describe('filters apply identically to both periods', () => {
  it('a region filter scopes current and comparison the same way', async () => {
    const user = userEvent.setup();
    const rows = [
      ...fullSummer(1, '[2026] - NA - Seq A'),
      // EMEA sequence with huge July numbers that must vanish when EMEA is off.
      ...fullSummer(2, '[2026] - EMEA - Seq B').map((s) => ({ ...s, total_sent: s.total_sent * 100 })),
    ];
    render(<Harness initialSnapshots={rows} initialPeriod={{ grain: 'month', year: 2026, month: 7 }} />);
    // Turn EMEA off via the region chip.
    await user.click(screen.getByRole('button', { name: 'EMEA', pressed: true }));
    const sent = screen.getByTestId('kpi-total_sent');
    // Only seq 1's +50 remains; the EMEA +5000 is gone from current AND the
    // comparison side (the delta reflects NA-only on both).
    expect(sent.textContent).toContain('50');
    expect(sent.textContent).not.toContain('5,050');
  });
});
