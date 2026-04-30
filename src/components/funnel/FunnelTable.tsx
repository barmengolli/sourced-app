import { useEffect, useRef, useState } from 'react';
import type { AttributionStageKey, Channel } from '../../types/db';
import {
  COMPUTED_STAGES,
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import {
  funnelEfficiencyPercent,
  isAttributionStage,
  onTargetPercent,
  type CellValues,
  type ComputedGrid,
  type ComputedRow,
} from '../../lib/compute';
import { readJson, writeJson } from '../../lib/storage';

const COLLAPSE_KEY_PREFIX = 'sourced.funnelCollapsed.';

interface FunnelTableProps {
  grid: ComputedGrid;
  channels: Channel[];
  onProjectionChange: (
    channelId: string,
    stage: FunnelStageKey,
    value: number | null,
  ) => Promise<void>;
  onActualChange: (
    channelId: string,
    stage: AttributionStageKey,
    value: number | null,
  ) => Promise<void>;
}

function fmtNum(v: number | null): string {
  if (v === null || v === undefined) return '';
  return v.toLocaleString();
}
function fmtPct(p: number | null): string {
  if (p === null) return '—';
  return `${p.toFixed(0)}%`;
}

interface NumericCellProps {
  value: number | null;
  editable: boolean;
  onCommit?: (next: number | null) => Promise<void>;
  align?: 'left' | 'right';
  emphasize?: boolean;
  className?: string;
}

function NumericCell({
  value,
  editable,
  onCommit,
  align = 'right',
  emphasize,
  className = '',
}: NumericCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep draft in sync with prop changes when not editing.
  useEffect(() => {
    if (!editing) setDraft(value === null ? '' : String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    if (!onCommit) {
      setEditing(false);
      return;
    }
    const trimmed = draft.trim();
    let parsed: number | null = null;
    if (trimmed !== '') {
      const n = Math.round(Number(trimmed));
      if (Number.isNaN(n)) {
        setEditing(false);
        setDraft(value === null ? '' : String(value));
        return;
      }
      parsed = n;
    }
    if (parsed === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onCommit(parsed);
      setEditing(false);
    } catch (e) {
      console.error('cell commit failed', e);
      setDraft(value === null ? '' : String(value));
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const cellBase =
    'px-2 py-1 text-xs tabular-nums border-r border-border last:border-r-0 ' +
    (align === 'right' ? 'text-right' : 'text-left') +
    (emphasize ? ' font-medium text-charcoal' : ' text-charcoal') +
    ' ' +
    className;

  if (editable && editing) {
    return (
      <td className={cellBase}>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setDraft(value === null ? '' : String(value));
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
          className="w-full bg-bg border border-indigo rounded px-1 py-0.5 text-right text-xs outline-none focus:ring-2 focus:ring-indigo/30"
        />
      </td>
    );
  }

  return (
    <td
      className={
        cellBase +
        (editable
          ? ' cursor-pointer hover:bg-indigo/5'
          : ' cursor-default text-slate-muted')
      }
      onClick={editable ? () => setEditing(true) : undefined}
      title={editable ? 'Click to edit' : undefined}
    >
      {value === null ? (
        <span className="text-slate-muted">{editable ? '—' : ''}</span>
      ) : (
        fmtNum(value)
      )}
    </td>
  );
}

function PctCell({ value }: { value: number | null }) {
  return (
    <td className="px-2 py-1 text-xs text-right tabular-nums text-slate-muted border-r border-border last:border-r-0">
      {fmtPct(value)}
    </td>
  );
}

interface RowCellsProps {
  cells: Record<FunnelStageKey, CellValues>;
  onProjectionChange?: (stage: FunnelStageKey, value: number | null) => Promise<void>;
  onActualChange?: (stage: AttributionStageKey, value: number | null) => Promise<void>;
  projectionsEditable: boolean;
  manualActualsEditable: boolean;
}

// Renders the 3 (Lead) + 4*5 (other stages) = 23 numeric/percent cells for a
// single row. projectionsEditable is true for every node (every channel owns
// its own projection independently in funnel_projections); only the totals
// row sets it false. manualActualsEditable is true only for leaves (nodes
// with no children) — non-leaf ACTs are recursive roll-ups.
function RowCells({
  cells,
  onProjectionChange,
  onActualChange,
  projectionsEditable,
  manualActualsEditable,
}: RowCellsProps) {
  return (
    <>
      {FUNNEL_STAGES.map((stage, idx) => {
        const c = cells[stage];
        const isLead = stage === 'lead';
        const isComputed = COMPUTED_STAGES.has(stage);
        const prevStage = idx > 0 ? FUNNEL_STAGES[idx - 1] : null;
        const fe =
          prevStage === null
            ? null
            : funnelEfficiencyPercent(c.actual, cells[prevStage].actual);
        const ot = onTargetPercent(c.actual, c.projection);
        return (
          <>
            <NumericCell
              key={`${stage}-proj`}
              value={c.projection}
              editable={projectionsEditable}
              onCommit={
                projectionsEditable && onProjectionChange
                  ? (v) => onProjectionChange(stage, v)
                  : undefined
              }
            />
            <NumericCell
              key={`${stage}-act`}
              value={c.actual}
              editable={
                !isComputed && manualActualsEditable && isAttributionStage(stage)
              }
              onCommit={
                !isComputed && manualActualsEditable && isAttributionStage(stage) && onActualChange
                  ? (v) => onActualChange(stage as AttributionStageKey, v)
                  : undefined
              }
              emphasize
            />
            <PctCell key={`${stage}-ot`} value={ot} />
            {!isLead && <PctCell key={`${stage}-fe`} value={fe} />}
          </>
        );
      })}
    </>
  );
}

export default function FunnelTable({
  grid,
  channels,
  onProjectionChange,
  onActualChange,
}: FunnelTableProps) {
  const channelById = new Map(channels.map((c) => [c.id, c] as const));

  // Per-channel collapse state, persisted in localStorage. Any non-leaf node
  // can be collapsed, at any depth. localStorage is keyed per channel id so
  // toggling one node doesn't disturb others.
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const c of channels) {
      const v = readJson<boolean>(COLLAPSE_KEY_PREFIX + c.id, false);
      if (v) initial.add(c.id);
    }
    return initial;
  });

  const toggleCollapsed = (nodeId: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
        writeJson(COLLAPSE_KEY_PREFIX + nodeId, false);
      } else {
        next.add(nodeId);
        writeJson(COLLAPSE_KEY_PREFIX + nodeId, true);
      }
      return next;
    });
  };

  return (
    <div className="flex-1 min-w-0 border border-border rounded-lg bg-bg overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          {/* Stage spanner row */}
          <tr className="bg-muted">
            <th className="text-left px-3 py-2 text-xs font-medium text-slate-muted border-r border-border align-bottom">
              Channel
            </th>
            {FUNNEL_STAGES.map((stage) => {
              const span = stage === 'lead' ? 3 : 4;
              return (
                <th
                  key={stage}
                  colSpan={span}
                  className="text-center px-2 py-1 text-xs font-semibold text-charcoal border-r border-border last:border-r-0"
                >
                  {FUNNEL_STAGE_LABELS[stage]}
                </th>
              );
            })}
          </tr>
          {/* Sub-header row: PROJ / ACT / OT% / FE% */}
          <tr className="bg-muted/60 text-slate-muted">
            <th className="border-r border-border" />
            {FUNNEL_STAGES.map((stage) => {
              const isLead = stage === 'lead';
              return (
                <>
                  <th key={`${stage}-h-proj`} className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wide border-r border-border">
                    Proj
                  </th>
                  <th key={`${stage}-h-act`} className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wide border-r border-border">
                    Act
                  </th>
                  <th key={`${stage}-h-ot`} className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wide border-r border-border last:border-r-0">
                    OT%
                  </th>
                  {!isLead && (
                    <th key={`${stage}-h-fe`} className="px-2 py-1 text-right text-[10px] font-medium uppercase tracking-wide border-r border-border last:border-r-0">
                      FE%
                    </th>
                  )}
                </>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row: ComputedRow) => {
            const channel = channelById.get(row.channelId);
            if (!channel) return null;
            const isHidden = channel.hidden;

            // Hide this row if ANY ancestor is collapsed. Under N-level a
            // grandchild must stay hidden when its grandparent is collapsed
            // even if its direct parent isn't in collapsedSet.
            if (row.ancestors.some((aid) => collapsedSet.has(aid))) {
              return null;
            }

            const isCollapsed =
              row.hasChildren && collapsedSet.has(row.channelId);

            // 4px reserved for chevron alignment; 24px per depth level
            // beyond root (depth=1 → 4px, depth=2 → 28px, depth=3 → 52px).
            const paddingLeft = 4 + (row.depth - 1) * 24;

            // 3-tier shading: roots clean, depth 2 lightly muted, depth 3+
            // slightly more. Replaces the binary parent/child styling.
            const rowBg =
              row.depth === 1
                ? 'bg-bg'
                : row.depth === 2
                  ? 'bg-muted/20'
                  : 'bg-muted/30';

            return (
              <tr
                key={row.channelId}
                className={
                  'border-t border-border ' +
                  rowBg +
                  (isHidden ? ' opacity-60' : '')
                }
              >
                <td
                  className={
                    'px-3 py-1 text-xs border-r border-border whitespace-nowrap ' +
                    (row.depth === 1
                      ? 'font-semibold text-charcoal'
                      : 'text-charcoal')
                  }
                  style={{ paddingLeft }}
                >
                  {row.hasChildren ? (
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(row.channelId)}
                      aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                      className="inline-flex items-center justify-center w-5 h-5 mr-1 text-slate-muted hover:text-charcoal align-middle"
                    >
                      <span className="text-[10px]">
                        {isCollapsed ? '▶' : '▼'}
                      </span>
                    </button>
                  ) : null}
                  {channel.name}
                </td>
                <RowCells
                  cells={row.cells}
                  onProjectionChange={(stage, v) =>
                    onProjectionChange(row.channelId, stage, v)
                  }
                  onActualChange={
                    row.hasChildren
                      ? undefined
                      : (stage, v) => onActualChange(row.channelId, stage, v)
                  }
                  projectionsEditable={true}
                  manualActualsEditable={!row.hasChildren}
                />
              </tr>
            );
          })}
          {/* Totals row */}
          <tr className="border-t-2 border-charcoal/20 bg-muted">
            <td className="px-3 py-2 text-xs font-bold text-charcoal border-r border-border">
              Totals
            </td>
            <RowCells
              cells={grid.totals}
              projectionsEditable={false}
              manualActualsEditable={false}
            />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
