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
import type { UseAttributionsResult } from '../../hooks/useAttributions';
import type {
  NewTouchInput,
  UseAttributionTouchesResult,
} from '../../hooks/useAttributionTouches';
import { ChannelSelect } from './CreateHPPModal';
import { REGIONS, REGION_LABELS, type RegionKey } from '../../constants/regions';
import { FUNNEL_STAGE_LABELS } from '../../constants/funnelStages';
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
  const [showOtherStages, setShowOtherStages] = useState(false);

  const maxDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const minDate = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().slice(0, 10);
  }, []);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const moveTouch = (idx: number, dir: -1 | 1) => {
    setTouches((prev) => {
      const next = prev.slice();
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
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
        'At least one stage must have a date. To remove the deal entirely, use Delete from the parent modal.',
      );
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
        channel_id: channelId,
        stage_key: stageKey,
        // year + period_index get derived from stage_entered_at inside
        // the hook, so don't pass them here.
        stage_entered_at: stageEnteredAt,
      });
      const newTouches: NewTouchInput[] = touches
        .filter((t) => t.channel_id !== '')
        .map((t) => ({
          channel_id: t.channel_id,
          touched_at: t.touched_at || null,
          notes: t.notes.trim() || null,
        }));
      await touchesHook.setTouches(attributionId, newTouches);

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
              deal_id: attribution.deal_id ?? null,
              stage_entered_at: iso,
            });
            // Touch propagation: new downstream rows inherit the
            // primary row's touch list (consistent with how Promote
            // and the Create HPP bulk path work).
            if (newTouches.length > 0) {
              await touchesHook.setTouches(newRow.id, newTouches);
            }
          } else if (iso && existing) {
            // UPDATE only when the date changed. Preserves any
            // per-stage customization the user made earlier
            // (channel, label, amount, region, touches).
            if (existing.stage_entered_at !== iso) {
              await attributionsHook.update(existing.id, {
                stage_entered_at: iso,
              });
            }
          } else if (!iso && existing) {
            // DELETE: existing row was cleared.
            await attributionsHook.deleteAttribution(existing.id);
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
                    {r} — {REGION_LABELS[r]}
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
                onChange={(e) => setStageEnteredAt(e.target.value)}
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
                      onChange={setOtherHpp}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                    />
                  )}
                  {stageKey !== 'opp' && (
                    <OtherDateField
                      label="Opp entered on"
                      value={otherOpp}
                      onChange={setOtherOpp}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
                    />
                  )}
                  {stageKey !== 'pursuit' && (
                    <OtherDateField
                      label="Pursuit entered on"
                      value={otherPursuit}
                      onChange={setOtherPursuit}
                      min={minDate}
                      max={maxDate}
                      disabled={busy}
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
                      onChange={setOtherCloseLost}
                      min={minDate}
                      max={maxDate}
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

        <footer className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
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
            disabled={!valid || busy}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: string;
  max: string;
  disabled?: boolean;
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
    </Field>
  );
}
