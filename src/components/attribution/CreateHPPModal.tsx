// CreateHPPModal — opens via the "+ Create HPP" button in the Funnel Data
// Entry page header. Lets the user enter opportunity metadata, a required
// first touch, and N optional additional touches. On submit, inserts one
// attribution row at stage_key='hpp' plus the touches via setTouches.

import { useMemo, useState } from 'react';
import type { Channel, PeriodIndex } from '../../types/db';
import type { UseAttributionsResult } from '../../hooks/useAttributions';
import type { UseAttributionTouchesResult, NewTouchInput } from '../../hooks/useAttributionTouches';
import { describePeriodFromIso, quarterOfIsoDate } from '../../lib/dates';
import { REGIONS, REGION_LABELS, type RegionKey } from '../../constants/regions';

interface CreateHPPModalProps {
  channels: Channel[];
  defaultYear: number;
  defaultPeriodIndex: PeriodIndex;
  attributionsHook: UseAttributionsResult;
  touchesHook: UseAttributionTouchesResult;
  onClose: () => void;
  onCreated?: (attributionId: string) => void;
}

interface TouchDraft {
  channel_id: string;
  touched_at: string;     // ISO date or ''
  notes: string;
}

function newTouch(): TouchDraft {
  return { channel_id: '', touched_at: '', notes: '' };
}

// Build <optgroup>-grouped channel options. Top-level channels become group
// labels; their entire subtree (any depth) is flattened into the group as
// selectable leaves with depth-prefixed indentation.
export function ChannelSelect({
  channels,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  channels: Channel[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const groups = useMemo(() => {
    const tops = channels
      .filter((c) => !c.parent_channel_id)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const childrenByParent = new Map<string, Channel[]>();
    for (const c of channels) {
      if (!c.parent_channel_id) continue;
      const arr = childrenByParent.get(c.parent_channel_id) ?? [];
      arr.push(c);
      childrenByParent.set(c.parent_channel_id, arr);
    }

    return tops.map((top) => {
      const flat: { id: string; name: string; depth: number }[] = [];
      const visit = (node: Channel, depth: number) => {
        const kids = (childrenByParent.get(node.id) ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name));
        if (kids.length === 0) {
          flat.push({ id: node.id, name: node.name, depth });
          return;
        }
        // Non-leaf: still selectable (covers leaf-only deals at mid-level).
        flat.push({ id: node.id, name: node.name, depth });
        for (const k of kids) visit(k, depth + 1);
      };
      // Top-level itself is the group label, not a flat entry. Walk its
      // subtree; if the top has no children, expose it as the only entry.
      const kids = (childrenByParent.get(top.id) ?? []).slice();
      if (kids.length === 0) {
        flat.push({ id: top.id, name: top.name, depth: 0 });
      } else {
        for (const k of kids.sort((a, b) => a.name.localeCompare(b.name))) {
          visit(k, 0);
        }
      }
      return { topName: top.name, options: flat };
    });
  }, [channels]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
    >
      <option value="">{placeholder ?? 'Select a channel'}</option>
      {groups.map((g) => (
        <optgroup key={g.topName} label={g.topName}>
          {g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {' '.repeat(o.depth * 2)}
              {o.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function CreateHPPModal({
  channels,
  defaultYear,
  defaultPeriodIndex,
  attributionsHook,
  touchesHook,
  onClose,
  onCreated,
}: CreateHPPModalProps) {
  const [label, setLabel] = useState('');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [sfLink, setSfLink] = useState('');
  const [region, setRegion] = useState<RegionKey>('NA');

  const [firstChannelId, setFirstChannelId] = useState('');
  // Period (year + quarter) is derived from stage_entered_at at submit
  // time. Removed the year + quarter selectors so the date and period
  // can never disagree. The defaultYear / defaultPeriodIndex props are
  // intentionally unused here; we kept them on the props type to avoid
  // touching every call site.
  void defaultYear;
  void defaultPeriodIndex;
  const [stageEnteredAt, setStageEnteredAt] = useState<string>(
    () => new Date().toISOString().slice(0, 10),
  );
  const maxDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const minDate = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().slice(0, 10);
  }, []);

  const [additional, setAdditional] = useState<TouchDraft[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const derivedPeriodLabel = describePeriodFromIso(stageEnteredAt);

  const valid =
    label.trim().length > 0 &&
    firstChannelId !== '' &&
    stageEnteredAt >= minDate &&
    stageEnteredAt <= maxDate &&
    derivedPeriodLabel !== '';

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      const parsedAmount = amount.trim() === '' ? null : Number(amount);
      if (parsedAmount !== null && Number.isNaN(parsedAmount)) {
        throw new Error('Amount must be a number');
      }
      // Generate a stable deal id so future Promote calls keep the deal
      // linked across stages.
      const dealId = crypto.randomUUID();
      // Derive year + period_index from the date. The hook does this too
      // (and overrides any caller-passed values); we pass the derived
      // pair here to keep the call site self-documenting and to satisfy
      // NewAttributionInput's required year/period_index fields.
      const derived = quarterOfIsoDate(stageEnteredAt);
      if (!derived) throw new Error('Invalid stage entered date');
      const created = await attributionsHook.create({
        stage_key: 'hpp',
        channel_id: firstChannelId,
        year: derived.year,
        period_index: derived.quarter,
        label: label.trim(),
        account: account.trim() || null,
        amount: parsedAmount,
        sf_link: sfLink.trim() || null,
        region,
        deal_id: dealId,
        stage_entered_at: stageEnteredAt,
      });

      const touches: NewTouchInput[] = [
        { channel_id: firstChannelId, touched_at: null, notes: null },
        ...additional
          .filter((t) => t.channel_id !== '')
          .map((t) => ({
            channel_id: t.channel_id,
            touched_at: t.touched_at || null,
            notes: t.notes.trim() || null,
          })),
      ];
      await touchesHook.setTouches(created.id, touches);

      onCreated?.(created.id);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-charcoal/30 flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-lg shadow-sm w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-charcoal">Create HPP</h2>
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
          {/* Metadata */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
              Opportunity
            </h3>
            <Field label="Label (required)">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={busy}
                placeholder="Acme Corp expansion"
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
                placeholder="https://"
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

          {/* First touch */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
              First touch (primary)
            </h3>
            <Field label="Channel (required)">
              <ChannelSelect
                channels={channels}
                value={firstChannelId}
                onChange={setFirstChannelId}
                disabled={busy}
              />
            </Field>
            <Field label="HPP entered on (required)">
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

          {/* Additional touches */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide flex items-center justify-between">
              <span>Additional touches</span>
              <button
                type="button"
                onClick={() =>
                  setAdditional((prev) => [...prev, newTouch()])
                }
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-border text-charcoal hover:bg-muted"
              >
                + Add touch
              </button>
            </h3>
            {additional.length === 0 ? (
              <p className="text-xs text-slate-muted italic">
                No additional touches yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {additional.map((t, i) => (
                  <li
                    key={i}
                    className="border border-border rounded-md bg-muted/40 p-2 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-muted w-12">
                        #{i + 2}
                      </span>
                      <ChannelSelect
                        channels={channels}
                        value={t.channel_id}
                        onChange={(id) =>
                          setAdditional((prev) =>
                            prev.map((p, idx) =>
                              idx === i ? { ...p, channel_id: id } : p,
                            ),
                          )
                        }
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setAdditional((prev) =>
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
                          setAdditional((prev) =>
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
                          setAdditional((prev) =>
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
            {busy ? 'Creating' : 'Create HPP'}
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
