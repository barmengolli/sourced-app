// AttributionEditorModal — opens when the user clicks Edit on a row in
// OpportunitiesListModal. Same shape as CreateHPPModal but in edit mode:
// loads the attribution + its touches, exposes add/remove/reorder for the
// touches, saves via attributionsHook.update + touchesHook.setTouches.

import { useEffect, useMemo, useState } from 'react';
import type {
  Attribution,
  AttributionStageKey,
  Channel,
} from '../../types/db';
import { STAGE_RANK } from '../../hooks/useAttributions';
import type { UseAttributionsResult } from '../../hooks/useAttributions';
import type {
  NewTouchInput,
  UseAttributionTouchesResult,
} from '../../hooks/useAttributionTouches';
import { ChannelSelect } from './CreateHPPModal';
import { REGIONS, type RegionKey } from '../../constants/regions';
import { BDR_OPTIONS } from '../../constants/bdr';
import {
  FUNNEL_STAGE_LABELS,
  LOST_REASONS,
} from '../../constants/funnelStages';
import { describePeriodFromIso, quarterOfIsoDate } from '../../lib/dates';
import { validateDealStageDates } from '../../lib/dealStageValidation';

interface AttributionEditorModalProps {
  attributionId: string;
  channels: Channel[];
  attributionsHook: UseAttributionsResult;
  touchesHook: UseAttributionTouchesResult;
  onClose: () => void;
}

interface TouchDraft {
  channel_id: string;
  touched_at: string; // ISO date or ''
  notes: string;
}

export default function AttributionEditorModal({
  attributionId,
  channels,
  attributionsHook,
  touchesHook,
  onClose,
}: AttributionEditorModalProps) {
  const attribution: Attribution | undefined = useMemo(
    () => attributionsHook.attributions.find((a) => a.id === attributionId),
    [attributionsHook.attributions, attributionId],
  );

  const existingTouches = useMemo(
    () => touchesHook.forAttribution(attributionId),
    [touchesHook, attributionId],
  );

  const [label, setLabel] = useState('');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [sfLink, setSfLink] = useState('');
  const [channelId, setChannelId] = useState('');
  const [region, setRegion] = useState<RegionKey>('NA');
  // BDR credit for the deal (BDR Quota tracker). Deal-level: propagated across
  // the chain on save like region. '' = untagged.
  const [bdrName, setBdrName] = useState<string>('');
  // Year + period_index are derived from stage_entered_at at save time.
  // No standalone year/quarter controls in the editor anymore. The
  // row's stage_key is fixed at whatever the row was created as;
  // users change a row's stage by clearing its date here and filling
  // the target stage's date in the "Other stage dates" section
  // (which does CREATE/UPDATE/DELETE end-to-end).
  const stageKey: AttributionStageKey = attribution?.stage_key ?? 'hpp';
  const [stageEnteredAt, setStageEnteredAt] = useState<string>('');
  const [touches, setTouches] = useState<TouchDraft[]>([]);

  // Other stage dates: one per non-primary stage. Pre-populated from
  // the deal's existing attribution rows (if any) so the user sees
  // the full chain in one modal. Edits across stages save in one
  // submit: CREATE, UPDATE, or DELETE per stage based on whether the
  // input has a value AND a row already exists for that stage.
  const [otherHpp, setOtherHpp] = useState<string>('');
  const [otherOpp, setOtherOpp] = useState<string>('');
  const [otherPursuit, setOtherPursuit] = useState<string>('');
  const [otherCloseWon, setOtherCloseWon] = useState<string>('');
  const [otherCloseLost, setOtherCloseLost] = useState<string>('');
  // Reason attached to the deal's closeLost row (whether that's the primary
  // row being edited or a chain row). Hydrated from the existing row so the
  // user can fill in / correct it on a previously-lost deal. Required only
  // when a closeLost row is actually present in the save.
  const [lostReason, setLostReason] = useState<string>('');
  const [showOtherStages, setShowOtherStages] = useState(false);

  const maxDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const minDate = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().slice(0, 10);
  }, []);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Hydrate from props once we have the attribution.
  useEffect(() => {
    if (!attribution) return;
    setLabel(attribution.label ?? '');
    setAccount(attribution.account ?? '');
    setAmount(
      attribution.amount === null || attribution.amount === undefined
        ? ''
        : String(attribution.amount),
    );
    setSfLink(attribution.sf_link ?? '');
    setRegion((attribution.region as RegionKey) ?? 'NA');
    setBdrName(attribution.bdr_name ?? '');
    setChannelId(attribution.channel_id ?? '');
    setStageEnteredAt(attribution.stage_entered_at);
  }, [attribution]);

  // The full set of attribution rows that share this deal_id, keyed
  // by stage_key. Used both to pre-populate the "Other stage dates"
  // inputs and to drive the CREATE/UPDATE/DELETE branching in submit.
  // Singleton deals (no deal_id) get an empty map and the section
  // suppresses itself.
  const dealRowsByStage = useMemo(() => {
    const map = new Map<AttributionStageKey, Attribution>();
    if (!attribution || !attribution.deal_id) return map;
    for (const r of attributionsHook.attributions) {
      if (r.deal_id !== attribution.deal_id) continue;
      map.set(r.stage_key, r);
    }
    return map;
  }, [attribution, attributionsHook.attributions]);

  const hasDealChain = Boolean(attribution?.deal_id);

  // Pre-populate the other-stage inputs from any existing rows on the
  // deal. Re-runs when the deal chain changes (e.g. another tab
  // added a stage row via realtime).
  useEffect(() => {
    if (!attribution) return;
    const dateFor = (k: AttributionStageKey): string => {
      const row = dealRowsByStage.get(k);
      if (!row) return '';
      // Skip the primary row's own stage; that input lives in the
      // primary section.
      if (row.id === attribution.id) return '';
      return row.stage_entered_at ?? '';
    };
    setOtherHpp(dateFor('hpp'));
    setOtherOpp(dateFor('opp'));
    setOtherPursuit(dateFor('pursuit'));
    setOtherCloseWon(dateFor('closeWon'));
    setOtherCloseLost(dateFor('closeLost'));
    // Lost reason lives on the deal's closeLost row, which may be the primary
    // row being edited or a chain row.
    const lostRow =
      attribution.stage_key === 'closeLost'
        ? attribution
        : dealRowsByStage.get('closeLost');
    setLostReason(lostRow?.lost_reason ?? '');
  }, [attribution, dealRowsByStage]);

  useEffect(() => {
    setTouches(
      existingTouches.map((t) => ({
        channel_id: t.channel_id ?? '',
        touched_at: t.touched_at ?? '',
        notes: t.notes ?? '',
      })),
    );
  }, [existingTouches]);

  const derivedPeriodLabel = describePeriodFromIso(stageEnteredAt);

  // Project the primary row's stage_key + date into the right slot
  // and pull the rest from the other-stage inputs. validateDealStageDates
  // doesn't care which input owns which slot — only that the
  // collected dates per stage are chronological and don't double up
  // on terminal stages.
  const datesByStage = useMemo(() => {
    const ds = {
      hpp: otherHpp,
      opp: otherOpp,
      pursuit: otherPursuit,
      closeWon: otherCloseWon,
      closeLost: otherCloseLost,
    };
    ds[stageKey] = stageEnteredAt;
    return ds;
  }, [
    stageKey,
    stageEnteredAt,
    otherHpp,
    otherOpp,
    otherPursuit,
    otherCloseWon,
    otherCloseLost,
  ]);

  const stageValidation = validateDealStageDates(datesByStage);

  // Number of other-stage dates currently filled; powers the
  // collapsed-section caption so state doesn't get lost behind the
  // toggle.
  const otherDatesFilledCount = [
    stageKey === 'hpp' ? '' : otherHpp,
    stageKey === 'opp' ? '' : otherOpp,
    stageKey === 'pursuit' ? '' : otherPursuit,
    stageKey === 'closeWon' ? '' : otherCloseWon,
    stageKey === 'closeLost' ? '' : otherCloseLost,
  ].filter(Boolean).length;

  if (!attribution) {
    return (
      <div className="fixed inset-0 z-40 bg-charcoal/30 flex items-center justify-center p-4">
        <div className="bg-bg border border-border rounded-lg shadow-sm w-full max-w-sm p-6 space-y-2">
          <p className="text-sm text-charcoal">Loading attribution…</p>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-slate-muted hover:text-charcoal"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const valid =
    label.trim().length > 0 &&
    channelId !== '' &&
    stageEnteredAt !== '' &&
    stageEnteredAt >= minDate &&
    stageEnteredAt <= maxDate &&
    derivedPeriodLabel !== '' &&
    stageValidation.ok;

  // Map of stage_key -> setter for the corresponding date input. The
  // primary stage's slot resolves to setStageEnteredAt; everything
  // else maps to its other-stage setter. Used by clearDownstream to
  // mirror a cleared non-terminal date by wiping the strictly-
  // downstream inputs in the form so the user doesn't see Pursuit
  // filled while Opp is blank. The actual row deletions happen on
  // Save via deleteWithCascade.
  const setterForStage = (k: AttributionStageKey): ((v: string) => void) => {
    if (k === stageKey) return setStageEnteredAt;
    switch (k) {
      case 'hpp':
        return setOtherHpp;
      case 'opp':
        return setOtherOpp;
      case 'pursuit':
        return setOtherPursuit;
      case 'closeWon':
        return setOtherCloseWon;
      case 'closeLost':
        return setOtherCloseLost;
    }
  };

  // Strictly-downstream stages (rank > the cleared stage's rank)
  // that currently have a date filled. closeWon and closeLost share
  // rank 4 so terminals never cascade onto each other.
  const downstreamFilledStages = (k: AttributionStageKey): AttributionStageKey[] => {
    const rank = STAGE_RANK[k];
    const stages: AttributionStageKey[] = ['hpp', 'opp', 'pursuit', 'closeWon', 'closeLost'];
    return stages.filter((s) => {
      if (STAGE_RANK[s] <= rank) return false;
      const v =
        s === stageKey
          ? stageEnteredAt
          : s === 'hpp'
          ? otherHpp
          : s === 'opp'
          ? otherOpp
          : s === 'pursuit'
          ? otherPursuit
          : s === 'closeWon'
          ? otherCloseWon
          : otherCloseLost;
      return Boolean(v);
    });
  };

  // When the user clears a non-terminal stage's date, also clear any
  // strictly-downstream date inputs so the form stays consistent with
  // what Save will do (deleteWithCascade removes the downstream rows).
  const clearDownstreamFor = (k: AttributionStageKey) => {
    for (const s of downstreamFilledStages(k)) {
      setterForStage(s)('');
    }
  };

  // Muted note shown next to a cleared non-terminal date input when
  // strictly-downstream rows exist for the deal. The form's auto-
  // clear already wiped the inputs, but the rows still exist in the
  // DB and will be removed by deleteWithCascade on Save.
  const cascadeNoteFor = (k: AttributionStageKey): string | null => {
    if (!hasDealChain) return null;
    const rank = STAGE_RANK[k];
    const downstreamRowCount = Array.from(dealRowsByStage.values()).filter(
      (r) => STAGE_RANK[r.stage_key] > rank,
    ).length;
    if (downstreamRowCount === 0) return null;
    return `Clearing the ${FUNNEL_STAGE_LABELS[k]} date will also remove ${downstreamRowCount} downstream stage${downstreamRowCount === 1 ? '' : 's'} on save.`;
  };

  const moveTouch = (idx: number, dir: -1 | 1) => {
    setTouches((prev) => {
      const next = prev.slice();
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  // Delete the entire opportunity (every attribution row sharing
  // this deal). Resolves to the HPP row when available so
  // deleteWithCascade removes the strictly-downstream chain in one
  // pass; falls back to the current attribution otherwise (matches
  // the cascade behavior used by OpportunitiesListModal).
  const handleDelete = async () => {
    if (!attribution) return;
    setBusy(true);
    setErr(null);
    try {
      const chain = attributionsHook.attributions.filter(
        (a) =>
          attribution.deal_id
            ? a.deal_id === attribution.deal_id
            : a.id === attribution.id,
      );
      const root =
        chain.find((r) => r.stage_key === 'hpp') ?? chain[0] ?? attribution;
      await attributionsHook.deleteWithCascade(root.id);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!valid) return;
    // Defensive: refuse to save if every date input ended up empty.
    // The primary `stageEnteredAt !== ''` check above already covers
    // the common path, but if a future change loosens that, this
    // catches "user cleared everything" with a clearer message.
    const anyDateEntered = Boolean(
      stageEnteredAt ||
        otherHpp ||
        otherOpp ||
        otherPursuit ||
        otherCloseWon ||
        otherCloseLost,
    );
    if (!anyDateEntered) {
      setErr(
        'At least one stage must have a date. To remove the deal entirely, use Delete opportunity.',
      );
      return;
    }
    // A closeLost row is in this save if the primary row is closeLost or the
    // chain's closeLost slot has a date. When so, a reason is required.
    const primaryIsLost = stageKey === 'closeLost';
    const willHaveLostRow = primaryIsLost || otherCloseLost !== '';
    if (willHaveLostRow && lostReason === '') {
      setErr('Select a lost reason for the close-lost stage.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const parsedAmount = amount.trim() === '' ? null : Number(amount);
      if (parsedAmount !== null && Number.isNaN(parsedAmount)) {
        throw new Error('Amount must be a number');
      }
      await attributionsHook.update(attributionId, {
        label: label.trim() || null,
        account: account.trim() || null,
        amount: parsedAmount,
        sf_link: sfLink.trim() || null,
        region,
        bdr_name: bdrName || null,
        channel_id: channelId,
        stage_key: stageKey,
        // year + period_index get derived from stage_entered_at inside
        // the hook, so don't pass them here.
        stage_entered_at: stageEnteredAt,
        // Set the reason on the primary row only when it IS the lost row;
        // otherwise clear it (a non-lost stage shouldn't carry a reason).
        lost_reason: primaryIsLost ? lostReason : null,
      });
      const newTouches: NewTouchInput[] = touches
        .filter((t) => t.channel_id !== '')
        .map((t) => ({
          channel_id: t.channel_id,
          touched_at: t.touched_at || null,
          notes: t.notes.trim() || null,
        }));
      await touchesHook.setTouches(attributionId, newTouches);

      // Region and BDR are deal-level: one deal, one value each. Propagate the
      // edited values to every row in the deal chain so derived per-deal
      // values stay consistent regardless of which stage row the user edited
      // from (DealVelocity.region reads the HPP/earliest row; the BDR quota
      // compute reads any row's bdr_name).
      const nextBdr = bdrName || null;
      if (hasDealChain && attribution?.deal_id) {
        for (const row of dealRowsByStage.values()) {
          if (row.id === attributionId) continue;
          const patch: Partial<Attribution> = {};
          if ((row.region ?? null) !== region) patch.region = region;
          if ((row.bdr_name ?? null) !== nextBdr) patch.bdr_name = nextBdr;
          if (Object.keys(patch).length > 0) {
            await attributionsHook.update(row.id, patch);
          }
        }
      }

      // Other-stage rows: CREATE / UPDATE / DELETE per slot based on
      // what was entered vs what already existed. Inherits the
      // primary row's EDITED metadata for any new rows so a label
      // correction made in the same Save lands consistently.
      if (hasDealChain && attribution) {
        const otherStages: Array<{
          stage_key: AttributionStageKey;
          iso: string;
        }> = [];
        const pushOther = (k: AttributionStageKey, iso: string) => {
          if (k === stageKey) return; // primary row owns this slot
          otherStages.push({ stage_key: k, iso });
        };
        pushOther('hpp', otherHpp);
        pushOther('opp', otherOpp);
        pushOther('pursuit', otherPursuit);
        pushOther('closeWon', otherCloseWon);
        pushOther('closeLost', otherCloseLost);

        for (const { stage_key, iso } of otherStages) {
          const existing = dealRowsByStage.get(stage_key);
          if (iso && !existing) {
            // CREATE: inherit primary's edited metadata.
            const derived = quarterOfIsoDate(iso);
            if (!derived) throw new Error(`Invalid ${stage_key} date`);
            const newRow = await attributionsHook.create({
              stage_key,
              channel_id: channelId,
              year: derived.year,
              period_index: derived.quarter,
              label: label.trim() || null,
              account: account.trim() || null,
              amount: parsedAmount,
              sf_link: sfLink.trim() || null,
              region,
              bdr_name: nextBdr,
              deal_id: attribution.deal_id ?? null,
              stage_entered_at: iso,
              // Only the closeLost row carries a reason.
              lost_reason: stage_key === 'closeLost' ? lostReason : null,
            });
            // Touch propagation: new downstream rows inherit the
            // primary row's touch list (consistent with how Promote
            // and the Create HPP bulk path work).
            if (newTouches.length > 0) {
              await touchesHook.setTouches(newRow.id, newTouches);
            }
          } else if (iso && existing) {
            // UPDATE only when something changed. Preserves any per-stage
            // customization the user made earlier (channel, label, amount,
            // touches). Region is deal-level and synced above. The closeLost
            // row also gets its reason updated (this is the backfill path for
            // deals lost before the reason field existed).
            const reasonChanged =
              stage_key === 'closeLost' &&
              (existing.lost_reason ?? '') !== lostReason;
            if (existing.stage_entered_at !== iso || reasonChanged) {
              await attributionsHook.update(existing.id, {
                stage_entered_at: iso,
                ...(stage_key === 'closeLost'
                  ? { lost_reason: lostReason }
                  : {}),
              });
            }
          } else if (!iso && existing) {
            // DELETE: existing row was cleared. Use deleteWithCascade
            // so any strictly-downstream rows on the same deal are
            // also removed in one round trip. The auto-clear UI
            // logic already wiped the corresponding inputs above.
            await attributionsHook.deleteWithCascade(existing.id);
          }
        }
      }

      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-charcoal/30 flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-lg shadow-sm w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-charcoal">
            Edit attribution
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-slate-muted hover:text-charcoal text-xl leading-none px-2"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-4 space-y-5">
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
              Opportunity
            </h3>
            <Field label="Label">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              />
            </Field>
            <Field label="Account">
              <input
                type="text"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              />
            </Field>
            <Field label="Amount (USD)">
              <input
                type="text"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              />
            </Field>
            <Field label="Salesforce link">
              <input
                type="url"
                value={sfLink}
                onChange={(e) => setSfLink(e.target.value)}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              />
            </Field>
            <Field label="Region (required)">
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value as RegionKey)}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              >
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="BDR (for quota tracking)">
              <select
                value={bdrName}
                onChange={(e) => setBdrName(e.target.value)}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              >
                <option value="">None</option>
                {BDR_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
              Primary channel and date
            </h3>
            <Field label="Channel">
              <ChannelSelect
                channels={channels}
                value={channelId}
                onChange={setChannelId}
                disabled={busy}
              />
            </Field>
            <Field label={`Entered ${FUNNEL_STAGE_LABELS[stageKey]} on (required)`}>
              <input
                type="date"
                value={stageEnteredAt}
                min={minDate}
                max={maxDate}
                onChange={(e) => {
                  const next = e.target.value;
                  setStageEnteredAt(next);
                  if (!next) clearDownstreamFor(stageKey);
                }}
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              />
            </Field>
            <p className="text-xs text-slate-muted">
              Will count as:{' '}
              <span className="text-charcoal font-medium">
                {derivedPeriodLabel || '—'}
              </span>
            </p>
            {!stageEnteredAt && cascadeNoteFor(stageKey) && (
              <p className="text-xs text-slate-muted italic">
                {cascadeNoteFor(stageKey)}
              </p>
            )}
            {stageKey === 'closeLost' && (
              <LostReasonField
                value={lostReason}
                onChange={setLostReason}
                disabled={busy}
              />
            )}
          </section>

          {/* Other stage dates — pre-populated from existing rows on
              this deal. Lets the user edit/add/remove the full
              attribution chain in one modal. Suppressed for
              singleton attributions (no deal_id). */}
          {hasDealChain && (
            <section className="space-y-2">
              <button
                type="button"
                onClick={() => setShowOtherStages((v) => !v)}
                className="w-full flex items-center justify-between text-left"
                aria-expanded={showOtherStages}
              >
                <span className="text-xs font-medium text-slate-muted uppercase tracking-wide">
                  Other stage dates
                </span>
                <span className="flex items-center gap-2 text-xs text-slate-muted">
                  {!showOtherStages && (
                    <span>
                      {otherDatesFilledCount === 0
                        ? 'Add stage dates'
                        : `${otherDatesFilledCount} date${
                            otherDatesFilledCount === 1 ? '' : 's'
                          } set`}
                    </span>
                  )}
                  <span className="text-[10px]">
                    {showOtherStages ? '▼' : '▶'}
                  </span>
                </span>
              </button>
              {showOtherStages && (
                <div className="space-y-2">
                  {stageKey !== 'hpp' && (
                    <OtherDateField
                      label="HPP entered on"
                      value={otherHpp}
                      onChange={(v) => {
                        setOtherHpp(v);
                        if (!v) clearDownstreamFor('hpp');
                      }}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                      cascadeNote={cascadeNoteFor('hpp')}
                    />
                  )}
                  {stageKey !== 'opp' && (
                    <OtherDateField
                      label="Opp entered on"
                      value={otherOpp}
                      onChange={(v) => {
                        setOtherOpp(v);
                        if (!v) clearDownstreamFor('opp');
                      }}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                      cascadeNote={cascadeNoteFor('opp')}
                    />
                  )}
                  {stageKey !== 'pursuit' && (
                    <OtherDateField
                      label="Pursuit entered on"
                      value={otherPursuit}
                      onChange={(v) => {
                        setOtherPursuit(v);
                        if (!v) clearDownstreamFor('pursuit');
                      }}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                      cascadeNote={cascadeNoteFor('pursuit')}
                    />
                  )}
                  {stageKey !== 'closeWon' && (
                    <OtherDateField
                      label="Close-Won entered on"
                      value={otherCloseWon}
                      onChange={setOtherCloseWon}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                    />
                  )}
                  {stageKey !== 'closeLost' && (
                    <OtherDateField
                      label="Close-Lost entered on"
                      value={otherCloseLost}
                      onChange={(v) => {
                        setOtherCloseLost(v);
                        if (!v) setLostReason('');
                      }}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                    />
                  )}
                  {stageKey !== 'closeLost' && otherCloseLost !== '' && (
                    <LostReasonField
                      value={lostReason}
                      onChange={setLostReason}
                      disabled={busy}
                    />
                  )}
                  {stageValidation.error && (
                    <p className="text-xs text-danger">
                      {stageValidation.error}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide flex items-center justify-between">
              <span>Touches ({touches.length})</span>
              <button
                type="button"
                onClick={() =>
                  setTouches((prev) => [
                    ...prev,
                    { channel_id: '', touched_at: '', notes: '' },
                  ])
                }
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-border text-charcoal hover:bg-muted"
              >
                + Add touch
              </button>
            </h3>
            <p className="text-xs text-slate-muted italic">
              Touches apply to this stage. Other stages keep their own
              touches.
            </p>
            {touches.length === 0 ? (
              <p className="text-xs text-slate-muted italic">
                No touches yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {touches.map((t, i) => (
                  <li
                    key={i}
                    className="border border-border rounded-md bg-muted/40 p-2 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-muted w-12">
                        #{i + 1}
                      </span>
                      <ChannelSelect
                        channels={channels}
                        value={t.channel_id}
                        onChange={(id) =>
                          setTouches((prev) =>
                            prev.map((p, idx) =>
                              idx === i ? { ...p, channel_id: id } : p,
                            ),
                          )
                        }
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() => moveTouch(i, -1)}
                        disabled={busy || i === 0}
                        className="text-xs px-2 py-1 rounded border border-border text-charcoal disabled:opacity-30"
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveTouch(i, 1)}
                        disabled={busy || i === touches.length - 1}
                        className="text-xs px-2 py-1 rounded border border-border text-charcoal disabled:opacity-30"
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setTouches((prev) =>
                            prev.filter((_, idx) => idx !== i),
                          )
                        }
                        disabled={busy}
                        className="text-xs text-danger hover:underline px-2"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="flex gap-2 items-center">
                      <input
                        type="date"
                        value={t.touched_at}
                        onChange={(e) =>
                          setTouches((prev) =>
                            prev.map((p, idx) =>
                              idx === i
                                ? { ...p, touched_at: e.target.value }
                                : p,
                            ),
                          )
                        }
                        disabled={busy}
                        className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                      />
                      <input
                        type="text"
                        value={t.notes}
                        onChange={(e) =>
                          setTouches((prev) =>
                            prev.map((p, idx) =>
                              idx === i ? { ...p, notes: e.target.value } : p,
                            ),
                          )
                        }
                        disabled={busy}
                        placeholder="Notes (optional)"
                        className="flex-1 text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {err && (
            <p className="text-xs text-danger border border-danger/40 bg-danger/5 rounded px-2 py-1">
              {err}
            </p>
          )}
        </div>

        <footer className="px-5 py-4 border-t border-border flex items-center gap-2">
          {confirmingDelete ? (
            <div className="flex items-center gap-2 mr-auto text-xs">
              <span className="text-charcoal">
                Delete this opportunity and all of its stage rows? This
                cannot be undone.
              </span>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="text-xs px-2 py-1 rounded bg-danger text-white disabled:opacity-40"
              >
                {busy ? 'Deleting' : 'Confirm delete'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
              className="text-sm px-3 py-1.5 mr-auto text-danger hover:underline disabled:opacity-40"
            >
              Delete opportunity
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-sm px-3 py-1.5 text-slate-muted hover:text-charcoal"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!valid || busy || confirmingDelete}
            className="text-sm px-3 py-1.5 rounded bg-indigo text-white disabled:opacity-40"
          >
            {busy ? 'Saving' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs text-slate-muted space-y-1">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Required dropdown shown wherever a closeLost row is being set or edited.
// "No reason set" is selectable only as the empty placeholder so existing
// reason-less deals don't silently look chosen.
function LostReasonField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field label="Lost reason (required)">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
      >
        <option value="">Select a reason…</option>
        {LOST_REASONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </Field>
  );
}

// One row in the "Other stage dates" section: date input + an
// inline "Will count as: Qx YYYY" hint when filled. Mirrors the
// equivalent helper in CreateHPPModal so the two modals read the
// same way at the field level.
function OtherDateField({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  cascadeNote,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: string;
  max: string;
  disabled?: boolean;
  cascadeNote?: string | null;
}) {
  const period = describePeriodFromIso(value);
  return (
    <Field label={label}>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
      />
      {value && (
        <p className="text-xs text-slate-muted">
          Will count as:{' '}
          <span className="text-charcoal font-medium">{period || '—'}</span>
        </p>
      )}
      {!value && cascadeNote && (
        <p className="text-xs text-slate-muted italic">{cascadeNote}</p>
      )}
    </Field>
  );
}
