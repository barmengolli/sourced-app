// BudgetEditor — inline budget list + add/edit form for one channel
// inside the Channel Manager. Renders existing campaign_costs rows as
// a compact list (start → end · amount · notes) with Edit / Delete
// per row, plus a "+ Add budget" toggle that exposes an inline form
// with quick-fill helpers for annual and quarterly ranges.
//
// All writes flow through the parent-supplied UseCampaignCostsResult
// so realtime echoes (from another tab or session) coexist cleanly.

import { useEffect, useMemo, useState } from 'react';
import type { CampaignCost } from '../../types/db';
import type {
  NewCampaignCostInput,
  UseCampaignCostsResult,
} from '../../hooks/useCampaignCosts';
import { formatCurrency } from '../../lib/formatters';

interface BudgetEditorProps {
  channelId: string;
  channelName: string;
  costs: CampaignCost[];          // already filtered to this channel
  hook: UseCampaignCostsResult;
  // Year used by the quick-fill date helpers (This year / Q1 / Q2 /
  // Q3 / Q4). Defaults to the current calendar year when omitted.
  defaultYear?: number;
}

function quarterRange(year: number, q: 1 | 2 | 3 | 4): { start: string; end: string } {
  const startMonth = (q - 1) * 3;
  const endMonth = startMonth + 2;
  const lastDayUtc = new Date(Date.UTC(year, endMonth + 1, 0));
  const m = String(startMonth + 1).padStart(2, '0');
  const lastMonth = String(endMonth + 1).padStart(2, '0');
  const lastDay = String(lastDayUtc.getUTCDate()).padStart(2, '0');
  return { start: `${year}-${m}-01`, end: `${year}-${lastMonth}-${lastDay}` };
}

interface DraftState {
  // null when creating a new row, otherwise the id of the row being edited.
  editingId: string | null;
  startDate: string;
  endDate: string;
  amount: string;
  notes: string;
}

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  startDate: '',
  endDate: '',
  amount: '',
  notes: '',
};

export default function BudgetEditor({
  channelId,
  channelName,
  costs,
  hook,
  defaultYear,
}: BudgetEditorProps) {
  const year = defaultYear ?? new Date().getFullYear();
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Sort by start_date ascending so older budgets show first. The
  // hook already orders this way but the caller may pass a filtered
  // slice in either order.
  const sortedCosts = useMemo(
    () => [...costs].sort((a, b) => a.start_date.localeCompare(b.start_date)),
    [costs],
  );

  // Reset draft and close the form when the channel changes (a user
  // collapsing one row's editor and opening another's shouldn't see
  // stale form values).
  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setShowForm(false);
    setErr(null);
  }, [channelId]);

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setShowForm(true);
    setErr(null);
  };

  const openEdit = (cost: CampaignCost) => {
    setDraft({
      editingId: cost.id,
      startDate: cost.start_date,
      endDate: cost.end_date,
      amount: String(cost.amount),
      notes: cost.notes ?? '',
    });
    setShowForm(true);
    setErr(null);
  };

  const cancel = () => {
    setDraft(EMPTY_DRAFT);
    setShowForm(false);
    setErr(null);
  };

  const applyQuickFill = (start: string, end: string) => {
    setDraft((d) => ({ ...d, startDate: start, endDate: end }));
  };

  const save = async () => {
    setErr(null);
    const trimmedAmount = draft.amount.trim();
    if (!draft.startDate) {
      setErr('Start date required');
      return;
    }
    if (!draft.endDate) {
      setErr('End date required');
      return;
    }
    if (draft.endDate < draft.startDate) {
      setErr('End date must be on or after start date');
      return;
    }
    if (trimmedAmount === '') {
      setErr('Amount required');
      return;
    }
    const amountNum = Number(trimmedAmount);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      setErr('Amount must be a non-negative number');
      return;
    }
    setBusy(true);
    try {
      const input: NewCampaignCostInput = {
        channel_id: channelId,
        amount: amountNum,
        start_date: draft.startDate,
        end_date: draft.endDate,
        notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      };
      if (draft.editingId) {
        await hook.update(draft.editingId, input);
      } else {
        await hook.insert(input);
      }
      setDraft(EMPTY_DRAFT);
      setShowForm(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await hook.deleteCost(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {sortedCosts.length === 0 ? (
        <p className="text-xs text-slate-muted italic">
          No budgets yet for {channelName}.
        </p>
      ) : (
        <ul className="space-y-1">
          {sortedCosts.map((c) => {
            const isEditing = draft.editingId === c.id && showForm;
            return (
              <li
                key={c.id}
                className={
                  'flex items-center gap-3 text-xs text-charcoal py-1 ' +
                  (isEditing ? 'opacity-40' : '')
                }
              >
                <span className="tabular-nums text-slate-muted">
                  {c.start_date} → {c.end_date}
                </span>
                <span className="tabular-nums font-medium">
                  {formatCurrency(c.amount)}
                </span>
                {c.notes && (
                  <span className="text-slate-muted truncate flex-1">
                    {c.notes}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    disabled={busy}
                    className="text-xs px-2 py-0.5 rounded border border-border text-charcoal hover:bg-muted disabled:opacity-40"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(c.id)}
                    disabled={busy}
                    className="text-xs px-2 py-0.5 rounded text-danger hover:bg-danger/10 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!showForm && (
        <button
          type="button"
          onClick={openCreate}
          className="text-xs px-2 py-1 rounded border border-border text-charcoal hover:bg-muted"
        >
          + Add budget
        </button>
      )}

      {showForm && (
        <div className="border border-border rounded-md bg-muted/40 p-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-muted space-y-0.5">
              <span className="block">Start date</span>
              <input
                type="date"
                value={draft.startDate}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, startDate: e.target.value }))
                }
                disabled={busy}
                className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
              />
            </label>
            <label className="text-xs text-slate-muted space-y-0.5">
              <span className="block">End date</span>
              <input
                type="date"
                value={draft.endDate}
                min={draft.startDate || undefined}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, endDate: e.target.value }))
                }
                disabled={busy}
                className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
              />
            </label>
            <label className="text-xs text-slate-muted space-y-0.5">
              <span className="block">Amount (USD)</span>
              <input
                type="text"
                inputMode="decimal"
                value={draft.amount}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, amount: e.target.value }))
                }
                disabled={busy}
                placeholder="0"
                className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal w-28"
              />
            </label>
          </div>
          {/* Quick-fill helpers use the year from props; the parent
              passes the Channel Manager's selected year. */}
          <div className="flex items-center gap-1 flex-wrap text-xs">
            <span className="text-slate-muted mr-1">Quick fill:</span>
            <button
              type="button"
              onClick={() =>
                applyQuickFill(`${year}-01-01`, `${year}-12-31`)
              }
              disabled={busy}
              className="px-2 py-0.5 rounded border border-border text-charcoal hover:bg-muted"
            >
              This year ({year})
            </button>
            {([1, 2, 3, 4] as const).map((q) => {
              const r = quarterRange(year, q);
              return (
                <button
                  key={q}
                  type="button"
                  onClick={() => applyQuickFill(r.start, r.end)}
                  disabled={busy}
                  className="px-2 py-0.5 rounded border border-border text-charcoal hover:bg-muted"
                >
                  Q{q}
                </button>
              );
            })}
          </div>
          <label className="text-xs text-slate-muted block space-y-0.5">
            <span className="block">Notes (optional)</span>
            <input
              type="text"
              value={draft.notes}
              onChange={(e) =>
                setDraft((d) => ({ ...d, notes: e.target.value }))
              }
              disabled={busy}
              placeholder="Contract ID, vendor, internal note…"
              className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal w-full"
            />
          </label>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-indigo text-white disabled:opacity-40"
            >
              {busy ? 'Saving' : draft.editingId ? 'Save' : 'Add'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
