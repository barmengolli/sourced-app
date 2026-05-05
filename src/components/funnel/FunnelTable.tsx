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
import { useCollapsedChannels } from '../../hooks/useCollapsedChannels';
import { getFEColor, getOTColor } from '../../lib/formatters';
import { readJson, writeJson } from '../../lib/storage';

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
  // M7: per-leaf attribution counts. Key = `${channelId}|${stage}`. When a
  // count > 0 exists for a leaf row's ACT cell, the cell becomes a clickable
  // "N deals" badge that opens OpportunitiesListModal instead of the inline
  // numeric editor (which writes to funnel_actuals as a fallback).
  attributionsByCell?: Map<string, number>;
  onAttributionCellClick?: (
    channelId: string,
    stage: AttributionStageKey,
  ) => void;
  // When true, all editable numeric cells (Projections on every row +
  // manual Actuals on leaf rows for HPP/Opp/Pursuit/CloseWon) become
  // non-editable as a guard against accidental clicks. Computed Lead/MQL
  // actuals and the attribution-badge modal flow are unaffected.
  editsLocked?: boolean;
}

export function attributionCellKey(
  channelId: string,
  stage: AttributionStageKey,
): string {
  return `${channelId}|${stage}`;
}

// --- column-index math --------------------------------------------------
// Channel name lives at colIdx 0. Lead has 3 sub-cols (proj/act/ot), every
// other stage has 4 (proj/act/ot/fe). Keeping this as a pure function lets
// RowCells emit a stable colIdx per cell so the crosshair highlight matches
// what the user sees.
function baseColForStage(stageIdx: number): number {
  // Lead starts at col 1; subsequent stages each occupy 4 cols.
  return stageIdx === 0 ? 1 : 4 * stageIdx;
}

const TOTALS_ROW_ID = '__totals__';
const SELECTED_ROWS_STORAGE_KEY = 'sourced.funnel.selectedRows';

interface FocusedCell {
  rowId: string;
  colIdx: number;
}

function fmtNum(v: number | null): string {
  if (v === null || v === undefined) return '';
  return v.toLocaleString();
}
function fmtPct(p: number | null): string {
  if (p === null) return '—';
  return `${p.toFixed(0)}%`;
}

interface CrosshairState {
  inRow: boolean;
  inCol: boolean;
  exact: boolean;
}

function crosshairFor(
  focusedCell: FocusedCell | null,
  rowId: string,
  colIdx: number,
): CrosshairState {
  if (!focusedCell) return { inRow: false, inCol: false, exact: false };
  const inRow = focusedCell.rowId === rowId;
  const inCol = focusedCell.colIdx === colIdx;
  return { inRow, inCol, exact: inRow && inCol };
}

function crosshairClasses({ inRow, inCol, exact }: CrosshairState): string {
  if (exact) return ' bg-indigo/15 ring-2 ring-inset ring-indigo';
  if (inRow || inCol) return ' bg-indigo/5';
  return '';
}

interface NumericCellProps {
  value: number | null;
  editable: boolean;
  onCommit?: (next: number | null) => Promise<void>;
  align?: 'left' | 'right';
  emphasize?: boolean;
  className?: string;
  crosshair: CrosshairState;
  onCellFocus?: () => void;
  // When true, the cell is conceptually editable (real value, not a roll-up
  // or computed stage) but the lock guard prevents click-to-edit. Visual
  // styling stays normal (no muted text), only the cursor + click handler
  // are gated. Different from editable=false, which represents a cell that
  // structurally can't be edited (totals row, parent rows, computed stages).
  locked?: boolean;
}

function NumericCell({
  value,
  editable,
  onCommit,
  align = 'right',
  emphasize,
  className = '',
  crosshair,
  onCellFocus,
  locked = false,
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
    crosshairClasses(crosshair) +
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

  // Three states for styling/behavior:
  //   editable && !locked → cursor-pointer + hover, click enters edit mode
  //   editable && locked  → cursor-default, no edit on click, value renders
  //                         normally (this is a real value the user just
  //                         can't edit right now)
  //   !editable           → cursor-default + muted text (totals, computed)
  const interactionClasses =
    editable && !locked
      ? ' cursor-pointer hover:bg-indigo/5'
      : editable && locked
        ? ' cursor-default'
        : ' cursor-default text-slate-muted';

  return (
    <td
      className={cellBase + interactionClasses}
      onClick={() => {
        onCellFocus?.();
        if (editable && !locked) setEditing(true);
      }}
      title={
        editable && !locked
          ? 'Click to edit'
          : editable && locked
            ? 'Locked. Toggle the lock at the top of the grid to edit.'
            : undefined
      }
    >
      {value === null ? (
        <span className="text-slate-muted">{editable ? '—' : ''}</span>
      ) : (
        fmtNum(value)
      )}
    </td>
  );
}

// kind selects the DataVis-ported color helper. OT% colors against on-target
// thresholds (>=1 green, >=0.75 yellow, else red). FE% is a single blue
// accent (or slate when null). Sourced's onTarget/funnelEfficiency helpers
// return 0-100 values, but the DataVis getOTColor/getFEColor helpers take
// raw decimals; divide here so the helpers port verbatim.
function PctCell({
  value,
  kind,
  crosshair,
  onCellFocus,
}: {
  value: number | null;
  kind: 'ot' | 'fe';
  crosshair: CrosshairState;
  onCellFocus?: () => void;
}) {
  const decimal = value === null ? null : value / 100;
  const color =
    kind === 'ot' ? getOTColor(decimal) : getFEColor(decimal);
  return (
    <td
      className={
        'px-2 py-1 text-xs text-right tabular-nums border-r border-border last:border-r-0 cursor-pointer ' +
        color +
        crosshairClasses(crosshair)
      }
      onClick={() => onCellFocus?.()}
    >
      {fmtPct(value)}
    </td>
  );
}

interface RowCellsProps {
  rowId: string;
  cells: Record<FunnelStageKey, CellValues>;
  onProjectionChange?: (stage: FunnelStageKey, value: number | null) => Promise<void>;
  onActualChange?: (stage: AttributionStageKey, value: number | null) => Promise<void>;
  projectionsEditable: boolean;
  manualActualsEditable: boolean;
  // M7: per-stage attribution count for this row (leaves only). When > 0,
  // the ACT cell renders as a clickable badge that calls onAttributionClick.
  attributionCounts?: Partial<Record<AttributionStageKey, number>>;
  onAttributionClick?: (stage: AttributionStageKey) => void;
  focusedCell: FocusedCell | null;
  onCellFocus: (rowId: string, colIdx: number) => void;
  editsLocked?: boolean;
}

// Renders the 3 (Lead) + 4*5 (other stages) = 23 numeric/percent cells for a
// single row. projectionsEditable is true for every node (every channel owns
// its own projection independently in funnel_projections); only the totals
// row sets it false. manualActualsEditable is true only for leaves (nodes
// with no children) — non-leaf ACTs are recursive roll-ups.
function RowCells({
  rowId,
  cells,
  onProjectionChange,
  onActualChange,
  projectionsEditable,
  manualActualsEditable,
  attributionCounts,
  onAttributionClick,
  focusedCell,
  onCellFocus,
  editsLocked = false,
}: RowCellsProps) {
  return (
    <>
      {FUNNEL_STAGES.map((stage, idx) => {
        const c = cells[stage];
        const isLead = stage === 'lead';
        const isLost = stage === 'closeLost';
        const isComputed = COMPUTED_STAGES.has(stage);
        const prevStage = idx > 0 ? FUNNEL_STAGES[idx - 1] : null;
        // Closed Lost is a parallel terminal stage, not a step downstream
        // of Closed Won. lost/won as a "funnel efficiency" reads as a
        // win-rate inverse, which is misleading next to the other FE%
        // values. Suppress it; the dedicated Win/Loss block in the
        // ConversionsPanel covers that math.
        const fe =
          prevStage === null || isLost
            ? null
            : funnelEfficiencyPercent(c.actual, cells[prevStage].actual);
        const ot = onTargetPercent(c.actual, c.projection);

        const attribCount =
          isAttributionStage(stage) && attributionCounts
            ? attributionCounts[stage as AttributionStageKey] ?? 0
            : 0;
        const showAttribBadge =
          attribCount > 0 &&
          manualActualsEditable &&
          isAttributionStage(stage);

        const baseCol = baseColForStage(idx);
        const projCol = baseCol;
        const actCol = baseCol + 1;
        const otCol = baseCol + 2;
        const feCol = baseCol + 3;

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
              crosshair={crosshairFor(focusedCell, rowId, projCol)}
              onCellFocus={() => onCellFocus(rowId, projCol)}
              locked={editsLocked}
            />
            {showAttribBadge ? (
              <AttributionBadgeCell
                key={`${stage}-act`}
                count={attribCount}
                onClick={() => {
                  onCellFocus(rowId, actCol);
                  onAttributionClick?.(stage as AttributionStageKey);
                }}
                crosshair={crosshairFor(focusedCell, rowId, actCol)}
              />
            ) : (
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
                // Closed Lost ACTs are tinted red at the cell level when
                // there's actual signal, so the column reads as a parallel
                // negative outcome next to the indigo Closed Won column.
                className={
                  isLost && c.actual !== null && c.actual > 0
                    ? 'text-danger'
                    : ''
                }
                crosshair={crosshairFor(focusedCell, rowId, actCol)}
                onCellFocus={() => onCellFocus(rowId, actCol)}
                locked={editsLocked}
              />
            )}
            <PctCell
              key={`${stage}-ot`}
              value={ot}
              kind="ot"
              crosshair={crosshairFor(focusedCell, rowId, otCol)}
              onCellFocus={() => onCellFocus(rowId, otCol)}
            />
            {!isLead && (
              <PctCell
                key={`${stage}-fe`}
                value={fe}
                kind="fe"
                crosshair={crosshairFor(focusedCell, rowId, feCol)}
                onCellFocus={() => onCellFocus(rowId, feCol)}
              />
            )}
          </>
        );
      })}
    </>
  );
}

function AttributionBadgeCell({
  count,
  onClick,
  crosshair,
}: {
  count: number;
  onClick: () => void;
  crosshair: CrosshairState;
}) {
  return (
    <td
      className={
        'px-2 py-1 text-xs tabular-nums text-right border-r border-border last:border-r-0' +
        crosshairClasses(crosshair)
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 rounded bg-indigo/10 text-indigo font-medium text-xs hover:bg-indigo/20 transition-colors"
        title={`${count} deal${count === 1 ? '' : 's'}, click to view`}
      >
        {count}
      </button>
    </td>
  );
}

export default function FunnelTable({
  grid,
  channels,
  onProjectionChange,
  onActualChange,
  attributionsByCell,
  onAttributionCellClick,
  editsLocked = false,
}: FunnelTableProps) {
  const channelById = new Map(channels.map((c) => [c.id, c] as const));

  // Per-channel collapse state, persisted in localStorage and shared with
  // the Funnel Compare view via useCollapsedChannels. Defaults to collapsed
  // for parents with no stored entry; explicit prior expands are honored.
  const { collapsedSet, toggle: toggleCollapsed } =
    useCollapsedChannels(channels);

  // Row selection (click name → toggle, shift-click → multi-select). Persists
  // across reloads since users use it to keep an eye on a channel for days.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => {
    const arr = readJson<string[]>(SELECTED_ROWS_STORAGE_KEY, []);
    return new Set(arr);
  });
  useEffect(() => {
    writeJson(SELECTED_ROWS_STORAGE_KEY, [...selectedRowIds]);
  }, [selectedRowIds]);

  // Cell crosshair focus (in-memory; resets on reload).
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);

  const toggleSelection = (channelId: string, shiftKey: boolean) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (shiftKey) {
        if (next.has(channelId)) next.delete(channelId);
        else next.add(channelId);
        return next;
      }
      // No-shift click: if it's the only selected row, clear; if not selected,
      // make it the sole selection; if selected alongside others, replace.
      if (next.has(channelId) && next.size === 1) {
        next.delete(channelId);
        return next;
      }
      next.clear();
      next.add(channelId);
      return next;
    });
  };

  const handleCellFocus = (rowId: string, colIdx: number) => {
    setFocusedCell((prev) => {
      // Click the same cell again to clear focus (matches DataVis behavior).
      if (prev && prev.rowId === rowId && prev.colIdx === colIdx) return null;
      return { rowId, colIdx };
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
              const isLost = stage === 'closeLost';
              return (
                <th
                  key={stage}
                  colSpan={span}
                  className={
                    'text-center px-2 py-1 text-xs font-semibold border-r border-border last:border-r-0 ' +
                    (isLost
                      ? 'text-danger bg-danger/10'
                      : 'text-charcoal')
                  }
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

            const isSelected = selectedRowIds.has(row.channelId);
            const isCrosshairRow = focusedCell?.rowId === row.channelId;

            // 3-tier shading: roots clean, depth 2 lightly muted, depth 3+
            // slightly more. Selected wins over shading; crosshair-row wins
            // over selected only when not selected (so amber stays visible
            // for an explicitly selected row).
            const rowBg = isSelected
              ? 'bg-warning/10'
              : isCrosshairRow
                ? 'bg-indigo/5'
                : row.depth === 1
                  ? 'bg-bg'
                  : row.depth === 2
                    ? 'bg-muted/20'
                    : 'bg-muted/30';

            const nameTdBg = isSelected
              ? 'bg-warning/15'
              : isCrosshairRow
                ? 'bg-indigo/5'
                : '';

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
                    'px-3 py-1 text-xs border-r border-border whitespace-nowrap cursor-pointer select-none ' +
                    nameTdBg +
                    ' ' +
                    (row.depth === 1
                      ? 'font-semibold text-charcoal'
                      : 'text-charcoal')
                  }
                  style={{ paddingLeft }}
                  onClick={(e) => toggleSelection(row.channelId, e.shiftKey)}
                  title={
                    isSelected
                      ? 'Click to deselect, shift-click to keep with others'
                      : 'Click to select, shift-click to add to selection'
                  }
                >
                  {row.hasChildren ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        // Don't let the chevron toggle row selection too.
                        e.stopPropagation();
                        toggleCollapsed(row.channelId);
                      }}
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
                  rowId={row.channelId}
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
                  attributionCounts={
                    row.hasChildren || !attributionsByCell
                      ? undefined
                      : (() => {
                          const counts: Partial<
                            Record<AttributionStageKey, number>
                          > = {};
                          for (const s of [
                            'hpp',
                            'opp',
                            'pursuit',
                            'closeWon',
                            'closeLost',
                          ] as AttributionStageKey[]) {
                            const v = attributionsByCell.get(
                              attributionCellKey(row.channelId, s),
                            );
                            if (v && v > 0) counts[s] = v;
                          }
                          return counts;
                        })()
                  }
                  onAttributionClick={(stage) =>
                    onAttributionCellClick?.(row.channelId, stage)
                  }
                  focusedCell={focusedCell}
                  onCellFocus={handleCellFocus}
                  editsLocked={editsLocked}
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
              rowId={TOTALS_ROW_ID}
              cells={grid.totals}
              projectionsEditable={false}
              manualActualsEditable={false}
              focusedCell={focusedCell}
              onCellFocus={handleCellFocus}
            />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
