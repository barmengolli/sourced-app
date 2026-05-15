import { useEffect, useMemo, useRef, useState } from 'react';
import type { CampaignCost, Channel } from '../../types/db';
import {
  descendantIds,
  type UseChannelMutationsResult,
} from '../../hooks/useChannelMutations';
import type { UseCampaignCostsResult } from '../../hooks/useCampaignCosts';
import MergePicker from './MergePicker';
import MovePicker from './MovePicker';
import BudgetEditor from './BudgetEditor';

interface ChannelManagerProps {
  channels: Channel[];
  leadCounts: Map<string, number>;
  mutations: UseChannelMutationsResult;
  // Budget editing extras. costs is the full list; the row component
  // filters to its own channel_id. costsHook is the same handle so
  // BudgetEditor can call insert / update / deleteCost.
  costs: CampaignCost[];
  costsHook: UseCampaignCostsResult;
  budgetYear: number;
}

interface RowMeta {
  channel: Channel;
  // True when at least one other channel points at this one as parent. Under
  // N-level the binary parent/child distinction collapses; "has children"
  // (non-leaf) is the meaningful predicate.
  hasChildren: boolean;
  // 1 = top-level, 2 = direct child of a root, 3 = grandchild, ...
  depth: number;
  topInGroup: boolean;
  bottomInGroup: boolean;
  childCount: number;
  leadCount: number;
}

function buildOrderedRows(
  channels: Channel[],
  leadCounts: Map<string, number>,
): RowMeta[] {
  const sortGroup = (group: Channel[]) =>
    group.slice().sort((a, b) => {
      if (a.display_order !== b.display_order) {
        return a.display_order - b.display_order;
      }
      return a.name.localeCompare(b.name);
    });

  const childrenByParent = new Map<string, Channel[]>();
  for (const c of channels) {
    if (!c.parent_channel_id) continue;
    const arr = childrenByParent.get(c.parent_channel_id) ?? [];
    arr.push(c);
    childrenByParent.set(c.parent_channel_id, arr);
  }

  const rows: RowMeta[] = [];
  const visit = (group: Channel[], depth: number) => {
    const sorted = sortGroup(group);
    sorted.forEach((channel, i) => {
      const kids = childrenByParent.get(channel.id) ?? [];
      rows.push({
        channel,
        hasChildren: kids.length > 0,
        depth,
        topInGroup: i === 0,
        bottomInGroup: i === sorted.length - 1,
        childCount: kids.length,
        leadCount: leadCounts.get(channel.id) ?? 0,
      });
      if (kids.length > 0) visit(kids, depth + 1);
    });
  };
  visit(channels.filter((c) => !c.parent_channel_id), 1);

  // Orphans: channels whose parent_channel_id points at a missing row. Render
  // them as roots so they're visible and editable.
  const seen = new Set(rows.map((r) => r.channel.id));
  for (const c of channels) {
    if (seen.has(c.id)) continue;
    rows.push({
      channel: c,
      hasChildren: false,
      depth: 1,
      topInGroup: true,
      bottomInGroup: true,
      childCount: 0,
      leadCount: leadCounts.get(c.id) ?? 0,
    });
  }
  return rows;
}

interface ChannelRowProps {
  meta: RowMeta;
  channels: Channel[];
  mutations: UseChannelMutationsResult;
  mergeOpen: boolean;
  onOpenMerge: () => void;
  onCloseMerge: () => void;
  moveOpen: boolean;
  onOpenMove: () => void;
  onCloseMove: () => void;
  budgetOpen: boolean;
  onToggleBudget: () => void;
  costsForChannel: CampaignCost[];
  costsHook: UseCampaignCostsResult;
  budgetYear: number;
}

function ChannelRow({
  meta,
  channels,
  mutations,
  mergeOpen,
  onOpenMerge,
  onCloseMerge,
  moveOpen,
  onOpenMove,
  onCloseMove,
  budgetOpen,
  onToggleBudget,
  costsForChannel,
  costsHook,
  budgetYear,
}: ChannelRowProps) {
  const {
    channel,
    hasChildren,
    depth,
    topInGroup,
    bottomInGroup,
    childCount,
    leadCount,
  } = meta;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmingPromote, setConfirmingPromote] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the local draft in sync with prop changes when not editing
  // (e.g. realtime brought a rename from another tab).
  useEffect(() => {
    if (!editing) setDraft(channel.name);
  }, [channel.name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === channel.name) {
      setDraft(channel.name);
      return;
    }
    await wrap(async () => {
      try {
        await mutations.rename(channel.id, next);
      } catch (e) {
        setDraft(channel.name);
        throw e;
      }
    });
  };

  const cancelRename = () => {
    setDraft(channel.name);
    setEditing(false);
  };

  const deleteDisabledReason = (() => {
    if (childCount > 0)
      return `Has ${childCount} sub-channel${childCount === 1 ? '' : 's'}`;
    if (leadCount > 0)
      return `Has ${leadCount} lead${leadCount === 1 ? '' : 's'}, merge first`;
    return null;
  })();

  const mergeDisabledReason = (() => {
    if (childCount > 0)
      return 'Merge is leaf-only. This channel has sub-channels.';
    return null;
  })();

  // Merge candidates: every other leaf channel that itself has no children.
  const mergeCandidates = useMemo(() => {
    if (childCount > 0) return [];
    const childIds = new Set(
      channels
        .filter((c) => c.parent_channel_id)
        .map((c) => c.parent_channel_id),
    );
    return channels
      .filter((c) => c.id !== channel.id)
      .filter((c) => !childIds.has(c.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, channel.id, childCount]);

  // Move candidates: every channel that is NOT this one or a descendant of
  // this one. Moving under a descendant would create a cycle. Sorted by name
  // for the search list; the picker also offers a "Top level (no parent)"
  // option pinned at the top.
  const moveCandidates = useMemo(() => {
    const forbidden = descendantIds(channels, channel.id);
    return channels
      .filter((c) => !forbidden.has(c.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, channel.id]);

  // Delete-and-promote is offered when this channel has children but no
  // direct leads. If it has direct leads, the user must merge first; if it
  // has no children, the regular delete handles it.
  const canPromoteChildren = childCount > 0 && leadCount === 0;
  const promoteDisabledReason: string | null = (() => {
    if (childCount === 0) return 'No children to promote';
    if (leadCount > 0)
      return `Has ${leadCount} direct lead${leadCount === 1 ? '' : 's'}. Merge first; promote would orphan them.`;
    return null;
  })();

  return (
    <div>
      <div
        className={
          'flex items-center gap-2 px-3 py-2 border-b border-border last:border-b-0 transition-colors ' +
          (channel.hidden ? 'opacity-50 bg-muted/40' : 'bg-bg hover:bg-muted/40')
        }
      >
        <div
          className="flex-1 min-w-0 flex items-center gap-2"
          style={{ paddingLeft: (depth - 1) * 24 }}
        >
          {depth > 1 && <span className="text-slate-muted text-xs">↳</span>}
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  cancelRename();
                  e.currentTarget.blur();
                }
              }}
              disabled={busy}
              className="flex-1 text-sm px-2 py-0.5 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={
                'flex-1 text-left text-sm cursor-text truncate ' +
                (depth === 1 ? 'font-medium text-charcoal' : 'text-charcoal')
              }
              title="Click to rename"
            >
              {channel.name}
            </button>
          )}
        </div>

        <div className="text-xs text-slate-muted w-20 text-right tabular-nums">
          {leadCount > 0
            ? `${leadCount} lead${leadCount === 1 ? '' : 's'}`
            : hasChildren && childCount > 0
              ? `${childCount} child${childCount === 1 ? '' : 'ren'}`
              : ''}
        </div>

        <div className="flex items-center gap-0.5">
          <IconButton
            label="Move up"
            disabled={topInGroup || busy}
            onClick={() => void wrap(() => mutations.moveUp(channel.id))}
          >
            ↑
          </IconButton>
          <IconButton
            label="Move down"
            disabled={bottomInGroup || busy}
            onClick={() => void wrap(() => mutations.moveDown(channel.id))}
          >
            ↓
          </IconButton>
          <IconButton
            label="Move to a different parent"
            disabled={busy}
            onClick={moveOpen ? onCloseMove : onOpenMove}
            active={moveOpen}
          >
            ⇪
          </IconButton>
          <IconButton
            label={channel.hidden ? 'Unhide' : 'Hide'}
            disabled={busy}
            onClick={() =>
              void wrap(() => mutations.setHidden(channel.id, !channel.hidden))
            }
          >
            {channel.hidden ? '◐' : '○'}
          </IconButton>
          <IconButton
            label="Rename"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            ✎
          </IconButton>
          <IconButton
            label={budgetOpen ? 'Hide budgets' : 'Edit budgets'}
            disabled={busy}
            onClick={onToggleBudget}
            active={budgetOpen}
          >
            $
          </IconButton>
          <IconButton
            label={mergeDisabledReason ?? 'Merge into another channel'}
            disabled={Boolean(mergeDisabledReason) || busy}
            onClick={mergeOpen ? onCloseMerge : onOpenMerge}
            active={mergeOpen}
          >
            ⇆
          </IconButton>
          <IconButton
            label={
              promoteDisabledReason ??
              'Delete and promote children to my parent'
            }
            disabled={!canPromoteChildren || busy}
            onClick={() => setConfirmingPromote((v) => !v)}
            active={confirmingPromote}
          >
            ⇡
          </IconButton>
          <IconButton
            label={deleteDisabledReason ?? 'Delete'}
            disabled={Boolean(deleteDisabledReason) || busy}
            onClick={() => void wrap(() => mutations.deleteChannel(channel.id))}
            danger
          >
            🗑
          </IconButton>
        </div>
      </div>

      {err && (
        <div
          className="px-3 py-1 text-xs text-danger bg-danger/5"
          style={{ paddingLeft: 12 + (depth - 1) * 24 }}
        >
          {err}
        </div>
      )}

      {mergeOpen && (
        <MergePicker
          source={channel}
          candidates={mergeCandidates}
          sourceLeadCount={leadCount}
          onConfirm={async (targetId) => {
            await mutations.merge(channel.id, targetId);
            onCloseMerge();
          }}
          onCancel={onCloseMerge}
        />
      )}

      {moveOpen && (
        <MovePicker
          source={channel}
          candidates={moveCandidates}
          currentParentId={channel.parent_channel_id ?? null}
          onConfirm={async (newParentId) => {
            await mutations.reparent(channel.id, newParentId);
            onCloseMove();
          }}
          onCancel={onCloseMove}
        />
      )}

      {budgetOpen && (
        <div
          className="mt-1 mb-2 mr-3 p-3 border border-border rounded-md bg-bg space-y-2"
          style={{ marginLeft: 12 + (meta.depth - 1) * 24 }}
        >
          <p className="text-xs text-slate-muted">
            Budgets for{' '}
            <span className="font-medium text-charcoal">
              {meta.channel.name}
            </span>
          </p>
          <BudgetEditor
            channelId={meta.channel.id}
            channelName={meta.channel.name}
            costs={costsForChannel}
            hook={costsHook}
            defaultYear={budgetYear}
          />
        </div>
      )}

      {confirmingPromote && (
        <div className="ml-12 mt-1 mb-2 p-3 border border-border rounded-md bg-muted space-y-2">
          <p className="text-xs text-charcoal">
            Delete <span className="font-medium">{channel.name}</span> and
            promote its {childCount} child
            {childCount === 1 ? '' : 'ren'} to{' '}
            {channel.parent_channel_id ? (
              <>
                its parent (
                <span className="font-medium">
                  {channels.find((c) => c.id === channel.parent_channel_id)
                    ?.name ?? 'unknown'}
                </span>
                )
              </>
            ) : (
              'top level (no parent)'
            )}
            . This is irreversible.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void wrap(async () => {
                  try {
                    await mutations.deleteAndPromoteChildren(channel.id);
                    setConfirmingPromote(false);
                  } catch (e) {
                    setConfirmingPromote(false);
                    throw e;
                  }
                })
              }
              disabled={busy}
              className="text-xs px-3 py-1 rounded bg-danger text-white disabled:opacity-40"
            >
              {busy ? 'Promoting' : 'Confirm promote and delete'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingPromote(false)}
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

// CreateChannelForm — inline form rendered above the channel list
// when the user clicks "+ New channel" (or always-visible on the
// empty-state card). The parent dropdown lists every channel in DFS
// order so the user can see the hierarchy when picking; hidden
// channels are still selectable but marked "(hidden)" so the choice
// is intentional.
//
// When `keepOpen` is true (empty-state case), the form stays mounted
// after a successful create — the caller has no toggle state to flip
// off and the user often wants to create several in a row.
function CreateChannelForm({
  channels,
  mutations,
  onClose,
  keepOpen = false,
}: {
  channels: Channel[];
  mutations: UseChannelMutationsResult;
  onClose: () => void;
  keepOpen?: boolean;
}) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // DFS-ordered channel list for the parent dropdown. Reuses the
  // same recursive walk that powers the main table so the dropdown
  // visually mirrors the tree the user sees below.
  const dropdownOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    const childrenByParent = new Map<string, Channel[]>();
    for (const c of channels) {
      if (!c.parent_channel_id) continue;
      const arr = childrenByParent.get(c.parent_channel_id) ?? [];
      arr.push(c);
      childrenByParent.set(c.parent_channel_id, arr);
    }
    const sortGroup = (group: Channel[]) =>
      group.slice().sort((a, b) => {
        if (a.display_order !== b.display_order) {
          return a.display_order - b.display_order;
        }
        return a.name.localeCompare(b.name);
      });
    const visit = (group: Channel[], depth: number) => {
      for (const c of sortGroup(group)) {
        out.push({
          id: c.id,
          label:
            ' '.repeat(depth) +
            c.name +
            (c.hidden ? ' (hidden)' : ''),
        });
        const kids = childrenByParent.get(c.id) ?? [];
        if (kids.length > 0) visit(kids, depth + 1);
      }
    };
    visit(channels.filter((c) => !c.parent_channel_id), 0);
    return out;
  }, [channels]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await mutations.create(trimmed, parentId === '' ? null : parentId);
      setName('');
      // Keep parentId so the user can rapid-fire create siblings.
      if (!keepOpen) onClose();
      // Refocus for the next create when keepOpen.
      if (keepOpen) inputRef.current?.focus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3 border border-border rounded-md bg-muted/40 space-y-2">
      <p className="text-xs font-medium text-charcoal text-left">
        New channel
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
          disabled={busy}
          placeholder="Channel name"
          className="flex-1 min-w-[12rem] text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        />
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          disabled={busy}
          className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
        >
          <option value="">Top level (no parent)</option>
          {dropdownOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || name.trim() === ''}
          className="text-xs px-3 py-1 rounded bg-indigo text-white disabled:opacity-40"
        >
          {busy ? 'Creating' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
        >
          Cancel
        </button>
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
    </div>
  );
}

interface IconButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  children: React.ReactNode;
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  active,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={
        'inline-flex items-center justify-center w-7 h-7 rounded text-sm transition-colors ' +
        (disabled
          ? 'text-slate-muted/40 cursor-not-allowed'
          : danger
            ? 'text-slate-muted hover:bg-danger/10 hover:text-danger'
            : active
              ? 'bg-indigo/10 text-indigo'
              : 'text-slate-muted hover:bg-muted hover:text-charcoal')
      }
    >
      {children}
    </button>
  );
}

export default function ChannelManager({
  channels,
  leadCounts,
  mutations,
  costs,
  costsHook,
  budgetYear,
}: ChannelManagerProps) {
  const [mergeOpenFor, setMergeOpenFor] = useState<string | null>(null);
  const [moveOpenFor, setMoveOpenFor] = useState<string | null>(null);
  const [budgetOpenFor, setBudgetOpenFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(
    () => buildOrderedRows(channels, leadCounts),
    [channels, leadCounts],
  );

  // Pre-bucket costs by channel_id so each row only re-derives its
  // own slice. Realtime echoes recompute the whole map; fine at N
  // budgets (small).
  const costsByChannel = useMemo(() => {
    const m = new Map<string, CampaignCost[]>();
    for (const c of costs) {
      const arr = m.get(c.channel_id) ?? [];
      arr.push(c);
      m.set(c.channel_id, arr);
    }
    return m;
  }, [costs]);

  const summary = useMemo(() => {
    const parents = channels.filter((c) => !c.parent_channel_id).length;
    const subs = channels.length - parents;
    let totalSorted = 0;
    for (const v of leadCounts.values()) totalSorted += v;
    return { parents, subs, totalSorted };
  }, [channels, leadCounts]);

  if (channels.length === 0) {
    return (
      <div className="space-y-3">
        <div className="border border-border rounded-lg bg-bg p-8 text-center space-y-3">
          <div>
            <p className="text-charcoal font-medium">No channels yet.</p>
            <p className="mt-1 text-sm text-slate-muted">
              Run the CSV importer to seed the channel tree from SFDC, or
              create one manually below.
            </p>
          </div>
          {/* Empty-state always exposes the form (no toggle) so the
              user can bootstrap a channel without running the
              importer first. */}
          <CreateChannelForm
            channels={channels}
            mutations={mutations}
            onClose={() => undefined}
            keepOpen
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-slate-muted">
          {summary.parents} parent{summary.parents === 1 ? '' : 's'},{' '}
          {summary.subs} sub-channel{summary.subs === 1 ? '' : 's'},{' '}
          {summary.totalSorted} lead{summary.totalSorted === 1 ? '' : 's'} sorted.
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className={
            'text-xs px-2 py-1 rounded border transition-colors ' +
            (creating
              ? 'bg-indigo/10 text-indigo border-indigo'
              : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
          }
        >
          {creating ? 'Cancel' : '+ New channel'}
        </button>
      </div>

      {creating && (
        <CreateChannelForm
          channels={channels}
          mutations={mutations}
          onClose={() => setCreating(false)}
        />
      )}

      <div className="border border-border rounded-lg bg-bg overflow-hidden">
        {rows.map((meta) => (
          <ChannelRow
            key={meta.channel.id}
            meta={meta}
            channels={channels}
            mutations={mutations}
            mergeOpen={mergeOpenFor === meta.channel.id}
            onOpenMerge={() => {
              setMergeOpenFor(meta.channel.id);
              setMoveOpenFor(null);
            }}
            onCloseMerge={() => setMergeOpenFor(null)}
            moveOpen={moveOpenFor === meta.channel.id}
            onOpenMove={() => {
              setMoveOpenFor(meta.channel.id);
              setMergeOpenFor(null);
            }}
            onCloseMove={() => setMoveOpenFor(null)}
            budgetOpen={budgetOpenFor === meta.channel.id}
            onToggleBudget={() =>
              setBudgetOpenFor((prev) =>
                prev === meta.channel.id ? null : meta.channel.id,
              )
            }
            costsForChannel={costsByChannel.get(meta.channel.id) ?? []}
            costsHook={costsHook}
            budgetYear={budgetYear}
          />
        ))}
      </div>
    </div>
  );
}
