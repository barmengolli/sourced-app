// OpportunitiesListModal — opens when the user clicks an HPP/Opp/Pursuit/Won
// ACT cell on the Funnel Data Entry grid that has at least one attribution.
// Lists matching attributions with Edit / Promote / Delete actions per row.

import { useState } from 'react';
import type {
  Attribution,
  AttributionStageKey,
  PeriodIndex,
} from '../../types/db';
import type { UseAttributionsResult } from '../../hooks/useAttributions';
import type { UseAttributionTouchesResult } from '../../hooks/useAttributionTouches';
import {
  FUNNEL_STAGE_LABELS,
  LOSS_ELIGIBLE_STAGES,
} from '../../constants/funnelStages';
import { describePeriodFromIso } from '../../lib/dates';

interface OpportunitiesListModalProps {
  attributions: Attribution[];
  channelName: string;
  stageKey: AttributionStageKey;
  year: number;
  periodIndex: PeriodIndex;
  attributionsHook: UseAttributionsResult;
  touchesHook: UseAttributionTouchesResult;
  onClose: () => void;
  onEdit: (id: string) => void;
}

const STAGE_NEXT: Record<AttributionStageKey, AttributionStageKey | null> = {
  hpp: 'opp',
  opp: 'pursuit',
  pursuit: 'closeWon',
  closeWon: null,
  closeLost: null,
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function minDateIso(): string {
  // Five years before today: a sane floor for stage entry dates so a
  // typo (e.g. accidentally typing 1980 instead of 2026) can't sneak in.
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export default function OpportunitiesListModal({
  attributions,
  channelName,
  stageKey,
  year,
  periodIndex,
  attributionsHook,
  touchesHook,
  onClose,
  onEdit,
}: OpportunitiesListModalProps) {
  const [promoteFor, setPromoteFor] = useState<string | null>(null);
  const [closeLostFor, setCloseLostFor] = useState<string | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [topErr, setTopErr] = useState<string | null>(null);

  const nextStage = STAGE_NEXT[stageKey];
  const lossEligible = LOSS_ELIGIBLE_STAGES.includes(stageKey);
  // The full attribution set powers per-row downstream-existence checks
  // below. Read once at this level so the row map's predicate is just a
  // .some() over a stable array reference.
  const allAttributions = attributionsHook.attributions;

  const wrap = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setTopErr(null);
    try {
      await fn();
    } catch (e) {
      setTopErr(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-charcoal/30 flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-lg shadow-sm w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-charcoal">
              {FUNNEL_STAGE_LABELS[stageKey]} deals
            </h2>
            <p className="text-xs text-slate-muted mt-0.5">
              {channelName} · {year} Q{periodIndex} · {attributions.length} deal
              {attributions.length === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-muted hover:text-charcoal text-xl leading-none px-2"
          >
            ×
          </button>
        </header>

        {topErr && (
          <div className="mx-5 mt-3 px-3 py-2 rounded border border-danger/40 bg-danger/5 text-danger text-xs">
            {topErr}
          </div>
        )}

        <ul className="px-5 py-3 divide-y divide-border">
          {attributions.length === 0 ? (
            <li className="py-3 text-sm text-slate-muted italic">
              No deals at this stage.
            </li>
          ) : (
            attributions.map((a) => {
              const touchCount = touchesHook.forAttribution(a.id).length;
              const isBusy = busyId === a.id;
              const isPromoting = promoteFor === a.id;
              const isClosingLost = closeLostFor === a.id;
              const isConfirmingDelete = confirmDeleteFor === a.id;

              // Duplicate-promote guard: when the deal already has a row
              // at the would-be downstream stage, block Promote at the UI
              // layer. The hook itself stays permissive (a deal can
              // legitimately re-enter a stage after a closeLost via
              // Delete-then-Promote), but the common case is an
              // accidental double-click on a stale modal view, which the
              // UI should not let through. Rows without a deal_id keep
              // the old free-promote behavior.
              const hasDownstreamPromoteRow =
                nextStage !== null &&
                a.deal_id != null &&
                a.deal_id !== '' &&
                allAttributions.some(
                  (other) =>
                    other.id !== a.id &&
                    other.deal_id === a.deal_id &&
                    other.stage_key === nextStage,
                );

              // Same idea for Close Lost: any other row with this
              // deal_id at stage_key='closeLost' blocks the action.
              const hasDownstreamLostRow =
                a.deal_id != null &&
                a.deal_id !== '' &&
                allAttributions.some(
                  (other) =>
                    other.id !== a.id &&
                    other.deal_id === a.deal_id &&
                    other.stage_key === 'closeLost',
                );
              return (
                <li key={a.id} className="py-3 space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-charcoal truncate">
                        {a.label || '(unnamed deal)'}
                      </div>
                      <div className="text-xs text-slate-muted truncate">
                        {a.account || 'No account'}
                        {a.amount !== null && a.amount !== undefined ? (
                          <>
                            {' · '}
                            {fmtMoney(a.amount)}
                          </>
                        ) : null}
                        {' · '}
                        {touchCount} touch{touchCount === 1 ? '' : 'es'}
                        {a.sf_link ? (
                          <>
                            {' · '}
                            <a
                              href={a.sf_link}
                              target="_blank"
                              rel="noreferrer"
                              className="text-indigo hover:underline"
                            >
                              SF
                            </a>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => onEdit(a.id)}
                        disabled={isBusy}
                        className="text-xs px-2 py-1 rounded border border-border text-charcoal hover:bg-muted"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPromoteFor(isPromoting ? null : a.id)
                        }
                        disabled={
                          isBusy ||
                          nextStage === null ||
                          hasDownstreamPromoteRow
                        }
                        title={
                          nextStage === null
                            ? 'Already at the final stage'
                            : hasDownstreamPromoteRow
                              ? `Already promoted to ${FUNNEL_STAGE_LABELS[nextStage]}. Delete the downstream row to re-promote.`
                              : `Promote to ${FUNNEL_STAGE_LABELS[nextStage]}`
                        }
                        className={
                          'text-xs px-2 py-1 rounded border border-border text-charcoal hover:bg-muted disabled:opacity-40 ' +
                          (hasDownstreamPromoteRow
                            ? 'opacity-50 cursor-not-allowed'
                            : '')
                        }
                      >
                        Promote
                      </button>
                      {lossEligible && (
                        <button
                          type="button"
                          onClick={() =>
                            setCloseLostFor(isClosingLost ? null : a.id)
                          }
                          disabled={isBusy || hasDownstreamLostRow}
                          title={
                            hasDownstreamLostRow
                              ? 'Already marked Closed Lost. Delete that row to re-mark.'
                              : 'Close as lost'
                          }
                          className={
                            'text-xs px-2 py-1 rounded text-danger hover:bg-danger/10 ' +
                            (hasDownstreamLostRow
                              ? 'opacity-50 cursor-not-allowed'
                              : '')
                          }
                        >
                          Close Lost
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmDeleteFor(isConfirmingDelete ? null : a.id)
                        }
                        disabled={isBusy}
                        className="text-xs px-2 py-1 rounded text-danger hover:bg-danger/10"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {isPromoting && nextStage && !hasDownstreamPromoteRow && (
                    <PromotePanel
                      onCancel={() => setPromoteFor(null)}
                      onConfirm={async (enteredAt) => {
                        await wrap(a.id, async () => {
                          await attributionsHook.promote(a.id, {
                            stage_entered_at: enteredAt,
                          });
                          setPromoteFor(null);
                        });
                      }}
                      busy={isBusy}
                      nextStageLabel={FUNNEL_STAGE_LABELS[nextStage]}
                    />
                  )}

                  {isClosingLost && lossEligible && !hasDownstreamLostRow && (
                    <CloseLostPanel
                      onCancel={() => setCloseLostFor(null)}
                      onConfirm={async (enteredAt) => {
                        await wrap(a.id, async () => {
                          await attributionsHook.markLost(a.id, {
                            stage_entered_at: enteredAt,
                          });
                          setCloseLostFor(null);
                        });
                      }}
                      busy={isBusy}
                      sourceStageLabel={FUNNEL_STAGE_LABELS[stageKey]}
                    />
                  )}

                  {isConfirmingDelete && (
                    <div className="ml-4 p-3 border border-border rounded-md bg-muted space-y-2">
                      <p className="text-xs text-charcoal">
                        Delete <span className="font-medium">{a.label}</span>?
                        Touches will be removed too. This is irreversible.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void wrap(a.id, async () => {
                              await attributionsHook.deleteAttribution(a.id);
                              setConfirmDeleteFor(null);
                            })
                          }
                          disabled={isBusy}
                          className="text-xs px-3 py-1 rounded bg-danger text-white"
                        >
                          {isBusy ? 'Deleting' : 'Confirm delete'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteFor(null)}
                          disabled={isBusy}
                          className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })
          )}
        </ul>

        <footer className="px-5 py-4 border-t border-border flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 text-slate-muted hover:text-charcoal"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

// Close-Lost confirmation: same shape as PromotePanel but red-accented and
// pre-filled from the source row's period (not today's quarter), since
// "this deal closed lost in the same quarter we last touched it" is the
// common case. Year/quarter are still editable in case the close-lost
// conversation actually happened later.
function CloseLostPanel({
  onCancel,
  onConfirm,
  busy,
  sourceStageLabel,
}: {
  onCancel: () => void;
  onConfirm: (stageEnteredAt: string) => Promise<void>;
  busy: boolean;
  sourceStageLabel: string;
}) {
  const [enteredAt, setEnteredAt] = useState<string>(todayIso());
  const max = todayIso();
  const min = minDateIso();
  const derived = describePeriodFromIso(enteredAt);
  const valid = enteredAt >= min && enteredAt <= max && derived !== '';
  return (
    <div className="ml-4 p-3 border border-danger/40 rounded-md bg-danger/5 space-y-2">
      <p className="text-xs text-charcoal">
        Close <span className="font-medium">{sourceStageLabel}</span> deal as
        lost. A new attribution row tagged Closed Lost will be created.
      </p>
      <label className="block text-xs text-slate-muted space-y-1">
        <span>Lost on (required)</span>
        <input
          type="date"
          value={enteredAt}
          min={min}
          max={max}
          onChange={(e) => setEnteredAt(e.target.value)}
          disabled={busy}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
        />
      </label>
      <p className="text-xs text-slate-muted">
        Will count as:{' '}
        <span className="text-charcoal font-medium">{derived || '—'}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onConfirm(enteredAt)}
          disabled={busy || !valid}
          className="text-xs px-3 py-1 rounded bg-danger text-white disabled:opacity-40"
        >
          {busy ? 'Closing' : 'Confirm close-lost'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PromotePanel({
  onCancel,
  onConfirm,
  busy,
  nextStageLabel,
}: {
  onCancel: () => void;
  onConfirm: (stageEnteredAt: string) => Promise<void>;
  busy: boolean;
  nextStageLabel: string;
}) {
  const [enteredAt, setEnteredAt] = useState<string>(todayIso());

  const max = todayIso();
  const min = minDateIso();
  const derived = describePeriodFromIso(enteredAt);
  const valid = enteredAt >= min && enteredAt <= max && derived !== '';

  return (
    <div className="ml-4 p-3 border border-border rounded-md bg-muted space-y-2">
      <p className="text-xs text-charcoal">
        Promote to <span className="font-medium">{nextStageLabel}</span>.
      </p>
      <label className="block text-xs text-slate-muted space-y-1">
        <span>Promoted to {nextStageLabel} on (required)</span>
        <input
          type="date"
          value={enteredAt}
          min={min}
          max={max}
          onChange={(e) => setEnteredAt(e.target.value)}
          disabled={busy}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
        />
      </label>
      <p className="text-xs text-slate-muted">
        Will count as:{' '}
        <span className="text-charcoal font-medium">{derived || '—'}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onConfirm(enteredAt)}
          disabled={busy || !valid}
          className="text-xs px-3 py-1 rounded bg-indigo text-white disabled:opacity-40"
        >
          {busy ? 'Promoting' : 'Confirm promote'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
