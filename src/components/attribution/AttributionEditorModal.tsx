// AttributionEditorModal — opens when the user clicks Edit on a row in
// OpportunitiesListModal. Same shape as CreateHPPModal but in edit mode:
// loads the attribution + its touches, exposes add/remove/reorder for the
// touches, saves via attributionsHook.update + touchesHook.setTouches.

import { useEffect, useMemo, useState } from 'react';
import type {
  Attribution,
  AttributionStageKey,
  Channel,
  PeriodIndex,
} from '../../types/db';
import type { UseAttributionsResult } from '../../hooks/useAttributions';
import type {
  NewTouchInput,
  UseAttributionTouchesResult,
} from '../../hooks/useAttributionTouches';
import { ChannelSelect } from './CreateHPPModal';
import { REGIONS, REGION_LABELS, type RegionKey } from '../../constants/regions';
import {
  FUNNEL_STAGE_LABELS,
  MANUAL_ACTUAL_STAGES,
} from '../../constants/funnelStages';

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

const QUARTERS: PeriodIndex[] = [1, 2, 3, 4];

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
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [periodIndex, setPeriodIndex] = useState<PeriodIndex>(1);
  const [stageKey, setStageKey] = useState<AttributionStageKey>('hpp');
  const [touches, setTouches] = useState<TouchDraft[]>([]);

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
    setYear(attribution.year);
    setPeriodIndex(attribution.period_index);
    setStageKey(attribution.stage_key);
  }, [attribution]);

  useEffect(() => {
    setTouches(
      existingTouches.map((t) => ({
        channel_id: t.channel_id ?? '',
        touched_at: t.touched_at ?? '',
        notes: t.notes ?? '',
      })),
    );
  }, [existingTouches]);

  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 1, y, y + 1];
  }, []);

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

  const valid = label.trim().length > 0 && channelId !== '';

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
        year,
        period_index: periodIndex,
        stage_key: stageKey,
      });
      const newTouches: NewTouchInput[] = touches
        .filter((t) => t.channel_id !== '')
        .map((t) => ({
          channel_id: t.channel_id,
          touched_at: t.touched_at || null,
          notes: t.notes.trim() || null,
        }));
      await touchesHook.setTouches(attributionId, newTouches);
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
              Primary channel and period
            </h3>
            <Field label="Channel">
              <ChannelSelect
                channels={channels}
                value={channelId}
                onChange={setChannelId}
                disabled={busy}
              />
            </Field>
            <Field label="Stage">
              <select
                value={stageKey}
                onChange={(e) =>
                  setStageKey(e.target.value as AttributionStageKey)
                }
                disabled={busy}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
              >
                {MANUAL_ACTUAL_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {FUNNEL_STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2">
              <Field label="Year">
                <select
                  value={year}
                  onChange={(e) => setYear(parseInt(e.target.value, 10))}
                  disabled={busy}
                  className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                >
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quarter">
                <div className="flex gap-1">
                  {QUARTERS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setPeriodIndex(q)}
                      disabled={busy}
                      className={
                        'text-xs px-2 py-1 rounded border ' +
                        (periodIndex === q
                          ? 'bg-indigo text-white border-indigo'
                          : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                      }
                    >
                      Q{q}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </section>

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
