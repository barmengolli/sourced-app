// OpportunityQueueManager: Opportunity review-queue UI.
//
// This component consumes the OpportunityQueueRepository interface ONLY. It
// never imports the Supabase client. Live access is supplied through the
// authenticated same-origin API adapter; tests can use the synthetic
// in-memory adapter without weakening the production boundary.
//
// Marketing must manually approve an opportunity before it enters Sourced
// reporting: approval always requires an explicit channel selection, lead
// association is optional, and evidence fields (BDR, creator, Primary
// Campaign Source, Customer Expansion) inform but never decide.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BLOCKING_ISSUE_CODES,
  REVIEW_STATE_LABELS,
  filterQueueItems,
  isApprovable,
} from '../../lib/opportunityQueue';
import type { OpportunityQueueItem, QueueFilters } from '../../lib/opportunityQueue';
import type {
  OpportunityQueueRepository,
  QueueActionResult,
} from '../../lib/opportunityQueueRepository';
import type { ReviewState } from '../../lib/opportunityImportStorage';
import { REGIONS } from '../../constants/regions';

export interface QueueChannelOption {
  id: string;
  name: string;
}

export interface OpportunityQueueManagerProps {
  repository: OpportunityQueueRepository;
  // Sourced channels for the mandatory approval selection.
  channels: QueueChannelOption[];
  actorId?: string | null;
  // Injected clock so tests stay deterministic.
  getNow?: () => string;
  live?: boolean;
}

type LoadStatus = 'loading' | 'error' | 'ready';

const REVIEW_STATUS_OPTIONS: Array<{ value: ReviewState | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'blocked', label: 'Blocked' },
];

const RECORD_TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'hpp', label: 'HPP' },
  { value: 'opp', label: 'Opportunity' },
  { value: 'pursuit', label: 'Pursuit' },
  { value: 'unknown', label: 'Unknown' },
] as const;

const TRISTATE = [
  { value: 'all', label: 'All' },
  { value: 'present', label: 'Present' },
  { value: 'missing', label: 'Missing' },
] as const;

const selectClass = 'text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal';
const chipBase = 'text-xs px-2 py-1 rounded border transition-colors ';
const chipOn = 'bg-indigo text-white border-indigo';
const chipOff = 'bg-bg text-charcoal border-border hover:border-charcoal/30';

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return 'n/a';
  try {
    return new Intl.NumberFormat('en-US', {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'n/a';
}

const ISSUE_LABELS: Record<string, string> = {
  missing_channel: 'Missing channel',
  missing_region: 'Missing region',
  missing_required_field: 'Missing required field',
  unknown_record_type: 'Unknown record type',
  unknown_stage_value: 'Unknown stage value',
  conflicting_history_id: 'Conflicting history',
  ambiguous_same_timestamp: 'Ambiguous timestamps',
  incomplete_history: 'Incomplete history',
  possible_existing_deal: 'Possible existing deal',
  invalid_source_row: 'Invalid source row',
};

export default function OpportunityQueueManager({
  repository,
  channels,
  actorId = null,
  getNow = () => new Date().toISOString(),
  live = false,
}: OpportunityQueueManagerProps) {
  const [view, setView] = useState<'active' | 'notSelected'>('active');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<OpportunityQueueItem[]>([]);
  const [filters, setFilters] = useState<QueueFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [note, setNote] = useState('');
  const [bdrName, setBdrName] = useState('');
  const [marketOverride, setMarketOverride] = useState('');
  const [commercialRegionOverride, setCommercialRegionOverride] = useState('');
  const [gtmCubeOverride, setGtmCubeOverride] = useState('');
  const [hppEnteredAt, setHppEnteredAt] = useState('');
  const [oppEnteredAt, setOppEnteredAt] = useState('');
  const [pursuitEnteredAt, setPursuitEnteredAt] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<string[]>([]);
  const [actionPending, setActionPending] = useState(false);

  const [generation, setGeneration] = useState(0);

  // All load state changes happen asynchronously when the repository call
  // settles; a stale response from an unmounted or superseded effect run is
  // discarded. Reload (retry, post-action refresh) bumps the generation.
  useEffect(() => {
    let cancelled = false;
    const list = view === 'active' ? repository.listQueue() : repository.listNotSelected();
    list.then(
      (queue) => {
        if (cancelled) return;
        setItems(queue);
        setStatus('ready');
        setLoadError(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'queue load failed');
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repository, generation, view]);

  const switchView = useCallback((next: 'active' | 'notSelected') => {
    setView(next);
    setFilters({});
    setSelectedId(null);
    setActionMessage(null);
    setActionErrors([]);
    setStatus('loading');
    setGeneration((g) => g + 1);
  }, []);

  const reload = useCallback(() => {
    setStatus('loading');
    setLoadError(null);
    setGeneration((g) => g + 1);
  }, []);

  const visible = useMemo(() => filterQueueItems(items, filters), [items, filters]);
  // Selection and every repository call key on the opaque internal review
  // identity, never the Salesforce Opportunity ID.
  const selected = visible.find((i) => i.reviewId === selectedId) ?? null;

  const ctx = useCallback(
    (actionNote?: string) => ({
      actorId,
      occurredAt: getNow(),
      note: actionNote?.trim() ? actionNote.trim() : null,
    }),
    [actorId, getNow],
  );

  const runAction = useCallback(
    async (label: string, action: () => Promise<QueueActionResult>) => {
      if (actionPending) return;
      setActionMessage(null);
      setActionErrors([]);
      setActionPending(true);
      try {
        const result = await action();
        if (result.ok) {
          setActionMessage(
            live
              ? `${label} saved. The review, audit history, link, and reporting rows reconciled together.`
              : `${label} recorded locally with its audit event (in-memory preview; no production write).`,
          );
          setSelectedId(null);
          setChannelId('');
          setLeadId('');
          setNote('');
          setGeneration((g) => g + 1);
        } else {
          setActionErrors(result.reasons);
        }
      } finally {
        setActionPending(false);
      }
    },
    [actionPending, live],
  );

  const selectItem = (item: OpportunityQueueItem) => {
    setSelectedId(item.reviewId);
    setChannelId(item.review?.channelId ?? '');
    setLeadId(item.review?.leadId ?? '');
    setBdrName(item.editable.bdrName ?? item.evidence.suggestedBdrName ?? '');
    setMarketOverride(item.editable.marketOverride ?? item.editable.sourceMarket ?? '');
    setCommercialRegionOverride(
      item.editable.commercialRegionOverride ?? item.editable.sourceCommercialRegion ?? '',
    );
    setGtmCubeOverride(item.editable.gtmCubeOverride ?? item.editable.sourceGtmCube ?? '');
    setHppEnteredAt(item.editable.hppEnteredAt ?? item.createdAt?.slice(0, 10) ?? '');
    setOppEnteredAt(item.editable.oppEnteredAt ?? '');
    setPursuitEnteredAt(item.editable.pursuitEnteredAt ?? '');
    setActionErrors([]);
    setActionMessage(null);
  };

  const set = (patch: Partial<QueueFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="p-8 space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-charcoal">Opportunity queue</h1>
        <p className="mt-1 text-sm text-slate-muted">
          Staged Salesforce opportunities awaiting a manual marketing decision. Approval always
          requires a channel selection; evidence never decides.
        </p>
        {!live && (
          <p className="mt-1 text-xs text-warning">
            Preview foundation: this queue is not connected to production data. Live wiring requires
            the authenticated review API.
          </p>
        )}
      </header>

      <div className="flex items-center gap-2" role="group" aria-label="Queue view">
        <button
          type="button"
          aria-pressed={view === 'active'}
          onClick={() => switchView('active')}
          className={chipBase + (view === 'active' ? chipOn : chipOff)}
        >
          Active queue
        </button>
        <button
          type="button"
          aria-pressed={view === 'notSelected'}
          onClick={() => switchView('notSelected')}
          className={chipBase + (view === 'notSelected' ? chipOn : chipOff)}
        >
          Not selected
        </button>
      </div>

      {view === 'notSelected' && (
        <p className="text-xs text-slate-muted">
          Opportunities marketing previously decided not to import. Reconsidering one returns it to
          the pending queue for a fresh decision; it is never approved, linked, or imported by
          recovery alone.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search opportunity or account"
          placeholder="Search opportunity or account"
          value={filters.search ?? ''}
          onChange={(e) => set({ search: e.target.value })}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal w-56"
        />
        {view === 'active' && (
          <label className="flex items-center gap-1 text-xs text-slate-muted">
            Status
            <select
              value={filters.reviewStatus ?? 'all'}
              onChange={(e) => set({ reviewStatus: e.target.value as QueueFilters['reviewStatus'] })}
              className={selectClass}
            >
              {REVIEW_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1 text-xs text-slate-muted">
          Type
          <select
            value={filters.recordType ?? 'all'}
            onChange={(e) => set({ recordType: e.target.value as QueueFilters['recordType'] })}
            className={selectClass}
          >
            {RECORD_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-muted">
          Open or closed
          <select
            value={filters.openClosed ?? 'all'}
            onChange={(e) => set({ openClosed: e.target.value as QueueFilters['openClosed'] })}
            className={selectClass}
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-muted">
          Created from
          <input
            type="date"
            value={filters.createdFrom ?? ''}
            onChange={(e) => set({ createdFrom: e.target.value || undefined })}
            className={selectClass}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-muted">
          Created to
          <input
            type="date"
            value={filters.createdTo ?? ''}
            onChange={(e) => set({ createdTo: e.target.value || undefined })}
            className={selectClass}
          />
        </label>
        {view === 'active' && (
          <>
            <label className="flex items-center gap-1 text-xs text-slate-muted">
              Campaign evidence
              <select
                value={filters.campaignEvidence ?? 'all'}
                onChange={(e) =>
                  set({ campaignEvidence: e.target.value as QueueFilters['campaignEvidence'] })
                }
                className={selectClass}
              >
                {TRISTATE.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-muted">
              BDR evidence
              <select
                value={filters.bdrEvidence ?? 'all'}
                onChange={(e) => set({ bdrEvidence: e.target.value as QueueFilters['bdrEvidence'] })}
                className={selectClass}
              >
                {TRISTATE.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-pressed={!!filters.missingChannelOnly}
              onClick={() => set({ missingChannelOnly: !filters.missingChannelOnly })}
              className={chipBase + (filters.missingChannelOnly ? chipOn : chipOff)}
            >
              Missing channel
            </button>
            <button
              type="button"
              aria-pressed={!!filters.blockingIssueOnly}
              onClick={() => set({ blockingIssueOnly: !filters.blockingIssueOnly })}
              className={chipBase + (filters.blockingIssueOnly ? chipOn : chipOff)}
            >
              Blocking issue
            </button>
          </>
        )}
        <button type="button" onClick={() => setFilters({})} className={chipBase + chipOff}>
          Clear filters
        </button>
      </div>

      {actionMessage && (
        <p role="status" className="text-xs text-success border border-border rounded px-3 py-2 bg-muted/40">
          {actionMessage}
        </p>
      )}

      {status === 'loading' && <p className="text-sm text-slate-muted">Loading queue…</p>}

      {status === 'error' && (
        <div className="text-sm text-danger border border-border rounded px-4 py-3 bg-muted/40">
          <p>Queue could not be loaded: {loadError}</p>
          <button
            type="button"
            onClick={reload}
            className={chipBase + chipOff + ' mt-2'}
          >
            Retry
          </button>
        </div>
      )}

      {status === 'ready' && visible.length === 0 && (
        <p className="text-sm text-slate-muted italic px-4 py-6 border border-border rounded bg-muted/40">
          {view === 'active'
            ? 'No opportunities currently require review.'
            : 'No not-selected opportunities are available to reconsider.'}
        </p>
      )}

      {status === 'ready' && visible.length > 0 && (
        <div className="border border-border rounded overflow-x-auto bg-bg">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-muted border-b border-border">
                <th className="px-3 py-2 font-medium">Opportunity</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">SaaS Revenue USD</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Modified</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Issues</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr
                  key={item.reviewId ?? item.diagnostics.sfOpportunityId}
                  onClick={() => selectItem(item)}
                  className="border-b border-border last:border-b-0 cursor-pointer hover:bg-muted/40"
                >
                  <td className="px-3 py-2 text-charcoal font-medium">{item.opportunityName}</td>
                  <td className="px-3 py-2">{item.accountName ?? 'n/a'}</td>
                  <td className="px-3 py-2 uppercase">{item.recordTypeState}</td>
                  <td className="px-3 py-2">
                    {item.stageName ?? 'n/a'}
                    <span className="text-slate-muted"> · {item.isClosed ? 'closed' : 'open'}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatAmount(item.saasRevenueUsd, 'USD')}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatDate(item.createdAt)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDate(item.lastModifiedAt)}</td>
                  <td className="px-3 py-2">{item.owner ?? 'n/a'}</td>
                  <td className="px-3 py-2">
                    {(item.review?.issueCodes ?? []).map((code) => (
                      <span
                        key={code}
                        className={
                          'inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded border text-[11px] ' +
                          (BLOCKING_ISSUE_CODES.has(code)
                            ? 'border-danger/40 text-danger'
                            : 'border-border text-slate-muted')
                        }
                      >
                        {ISSUE_LABELS[code] ?? code}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    {item.review ? REVIEW_STATE_LABELS[item.review.reviewState] : 'n/a'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && selected.review && (
        <section className="border border-border rounded bg-bg p-4 space-y-3">
          <header className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-charcoal">{selected.opportunityName}</h2>
              <p className="text-xs text-slate-muted">
                {selected.accountName ?? 'No account'} · {selected.recordTypeState.toUpperCase()} ·{' '}
                {REVIEW_STATE_LABELS[selected.review.reviewState]}
              </p>
            </div>
            <button type="button" onClick={() => setSelectedId(null)} className={chipBase + chipOff}>
              Close
            </button>
          </header>

          <div className="text-xs text-charcoal space-y-1">
            <h3 className="font-medium">Evidence (informational only, never a decision)</h3>
            <p>BDR evidence: {selected.evidence.bdrUserId ?? 'none'}</p>
            <p>Creator evidence: {selected.evidence.creatorUserId ?? 'none'}</p>
            <p>Suggested BDR: {selected.evidence.suggestedBdrName ?? 'none'}</p>
            <p>Primary campaign source: {selected.evidence.primaryCampaignSource ?? 'none'}</p>
            <p>Customer expansion (raw): {selected.evidence.customerExpansionRaw ?? 'none'}</p>
            <p>Salesforce Market: {selected.editable.sourceMarket ?? 'none'}</p>
            <p>Salesforce Commercial Region: {selected.editable.sourceCommercialRegion ?? 'none'}</p>
            <p>Salesforce GTM Cube: {selected.editable.sourceGtmCube ?? 'none'}</p>
          </div>

          {actionErrors.length > 0 && (
            <ul role="alert" className="text-xs text-danger list-disc pl-4">
              {actionErrors.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          {selected.review.reviewState === 'ignored' && (
            <form
              className="text-xs space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void runAction('Reconsider', () =>
                  repository.reconsiderReview(selected.reviewId ?? '', ctx(note)),
                );
              }}
            >
              <h3 className="font-medium text-charcoal">Reconsider opportunity</h3>
              <p className="text-slate-muted">
                Returns this record to the pending queue for a fresh decision. The original
                not-selected decision stays in the audit history. Reconsidering does not approve,
                link, or import anything; a channel must still be selected before approval.
              </p>
              <label className="flex items-center gap-2 text-slate-muted">
                Reason (required)
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Short, non-sensitive reason"
                  className={selectClass + ' w-72'}
                />
              </label>
              <button type="submit" disabled={actionPending}
                className="text-xs px-3 py-1 rounded bg-indigo text-white hover:bg-indigo/90 disabled:opacity-50">
                {actionPending ? 'Saving…' : 'Reconsider'}
              </button>
            </form>
          )}

          {selected.review.reviewState === 'blocked' && (
            <div className="text-xs text-charcoal space-y-2">
              <p className="text-danger">
                This review is blocked. Resolve the blocker, then reopen it to pending.
              </p>
              <button
                type="button"
                disabled={actionPending}
                onClick={() =>
                  void runAction('Reopen', () =>
                    repository.reopenReview(selected.reviewId ?? '', ctx()),
                  )
                }
                className={chipBase + chipOff + ' disabled:opacity-50'}
              >
                Reopen review
              </button>
            </div>
          )}

          {selected.review.reviewState === 'pending' && !isApprovable(selected) && (
            <p className="text-xs text-danger">
              This record cannot be approved until its blocking issues are resolved:{' '}
              {selected.review.issueCodes
                .filter((c) => BLOCKING_ISSUE_CODES.has(c))
                .map((c) => ISSUE_LABELS[c] ?? c)
                .join(', ') || 'unknown record type'}
              .
            </p>
          )}

          {selected.review.reviewState === 'pending' && isApprovable(selected) && (
            <form
              className="text-xs space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void runAction('Approval', () =>
                  repository.approveReview(
                    selected.reviewId ?? '',
                    {
                      channelId,
                      leadId: leadId.trim() || null,
                      bdrName: bdrName.trim() || null,
                      marketOverride: marketOverride.trim() || null,
                      commercialRegionOverride,
                      gtmCubeOverride: gtmCubeOverride.trim() || null,
                      hppEnteredAt,
                      oppEnteredAt: oppEnteredAt || null,
                      pursuitEnteredAt: pursuitEnteredAt || null,
                    },
                    ctx(),
                  ),
                );
              }}
            >
              <h3 className="font-medium text-charcoal">Approve into Sourced reporting</h3>
              <label className="flex items-center gap-2 text-slate-muted">
                Channel (required)
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select a channel…</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1 text-slate-muted">
                  <span className="block">Commercial Region (required)</span>
                  <select
                    aria-label="Commercial Region (required)"
                    value={commercialRegionOverride}
                    onChange={(e) => setCommercialRegionOverride(e.target.value)}
                    className={selectClass + ' w-full'}
                  >
                    <option value="">Select a region…</option>
                    {REGIONS.map((region) => <option key={region} value={region}>{region}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-slate-muted">
                  <span className="block">BDR</span>
                  <select
                    aria-label="BDR"
                    value={bdrName}
                    onChange={(e) => setBdrName(e.target.value)}
                    className={selectClass + ' w-full'}
                  >
                    <option value="">No BDR</option>
                    <option value="Dave Cummins">Dave Cummins</option>
                    <option value="Garrett McNally">Garrett McNally</option>
                  </select>
                </label>
                <label className="space-y-1 text-slate-muted">
                  <span className="block">Market override</span>
                  <input aria-label="Market override" value={marketOverride}
                    onChange={(e) => setMarketOverride(e.target.value)} className={selectClass + ' w-full'} />
                </label>
                <label className="space-y-1 text-slate-muted">
                  <span className="block">GTM Cube override</span>
                  <input aria-label="GTM Cube override" value={gtmCubeOverride}
                    onChange={(e) => setGtmCubeOverride(e.target.value)} className={selectClass + ' w-full'} />
                </label>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="space-y-1 text-slate-muted">
                  <span className="block">HPP date (required)</span>
                  <input type="date" aria-label="HPP date (required)" value={hppEnteredAt}
                    onChange={(e) => setHppEnteredAt(e.target.value)} className={selectClass + ' w-full'} />
                </label>
                {selected.recordTypeState !== 'hpp' && (
                  <label className="space-y-1 text-slate-muted">
                    <span className="block">Opportunity date (required)</span>
                    <input type="date" aria-label="Opportunity date" value={oppEnteredAt}
                      onChange={(e) => setOppEnteredAt(e.target.value)} className={selectClass + ' w-full'} />
                  </label>
                )}
                {selected.recordTypeState === 'pursuit' && (
                  <label className="space-y-1 text-slate-muted">
                    <span className="block">Pursuit date (required)</span>
                  <input type="date" aria-label="Pursuit date (required)" value={pursuitEnteredAt}
                    onChange={(e) => setPursuitEnteredAt(e.target.value)} className={selectClass + ' w-full'} />
                  </label>
                )}
              </div>
              <p className="text-slate-muted">
                HPP defaults to the Salesforce creation date. Downstream dates stay blank until
                Salesforce history or your review can prove them.
              </p>
              <label className="flex items-center gap-2 text-slate-muted">
                Lead (optional)
                <input
                  type="text"
                  value={leadId}
                  onChange={(e) => setLeadId(e.target.value)}
                  placeholder="Sourced lead id"
                  className={selectClass}
                />
              </label>
              <button type="submit" disabled={actionPending}
                className="text-xs px-3 py-1 rounded bg-indigo text-white hover:bg-indigo/90 disabled:opacity-50">
                {actionPending ? 'Saving…' : 'Approve'}
              </button>
            </form>
          )}

          {selected.review.reviewState === 'pending' && (
            <div className="text-xs space-y-2 border-t border-border pt-2">
              <label className="flex items-center gap-2 text-slate-muted">
                Note
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional for ignore; required reason for block"
                  className={selectClass + ' w-72'}
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() =>
                    void runAction('Ignore', () =>
                      repository.ignoreReview(selected.reviewId ?? '', ctx(note)),
                    )
                  }
                  className={chipBase + chipOff + ' disabled:opacity-50'}
                >
                  Ignore
                </button>
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() =>
                    void runAction('Block', () =>
                      repository.blockReview(selected.reviewId ?? '', ctx(note)),
                    )
                  }
                  className={chipBase + chipOff + ' disabled:opacity-50'}
                >
                  Block
                </button>
              </div>
            </div>
          )}

          <details className="text-xs text-slate-muted">
            <summary className="cursor-pointer">Diagnostics</summary>
            <p className="mt-1">Salesforce opportunity id: {selected.diagnostics.sfOpportunityId}</p>
            <p>Link status: {selected.linkStatus}</p>
          </details>
        </section>
      )}
    </div>
  );
}
