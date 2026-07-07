// CampaignTagsPage — the central mapping screen for the Campaigns section.
// Two parts: (1) manage campaign tags (create / rename / recolor / delete),
// and (2) map every silo asset (parent channels, 6Sense segments, Outreach
// sequences) to a campaign via an inline picker. This is where the manual
// tag layer that unifies the silos gets set up.

import { useMemo, useState } from 'react';
import type { PageKey } from '../App';
import type {
  Channel,
  OutreachSnapshot,
  SixSenseSnapshot,
  LinkedinAdSnapshot,
  CampaignAssetType,
} from '../types/db';
import type { UseCampaignTagsResult } from '../hooks/useCampaignTags';
import { OVERALL_SEGMENT, orderSegments } from '../constants/sixsense';
import CampaignTagPicker from '../components/campaigns/CampaignTagPicker';

const TAG_COLORS = [
  '#4F46E5', '#06B6D4', '#10B981', '#F59E0B',
  '#EF4444', '#8B5CF6', '#EC4899', '#64748B',
];

export default function CampaignTagsPage({
  tagsHook,
  channels,
  outreachSnapshots,
  sixSenseSnapshots,
  linkedinSnapshots,
}: {
  tagsHook: UseCampaignTagsResult;
  channels: Channel[];
  outreachSnapshots: OutreachSnapshot[];
  sixSenseSnapshots: SixSenseSnapshot[];
  linkedinSnapshots: LinkedinAdSnapshot[];
  onNavigate: (p: PageKey) => void;
}) {
  const { tags, createTag, renameTag, setColor, deleteTag, linkAsset, unlinkAsset, tagFor } =
    tagsHook;

  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  // Channel rows for tagging: each visible parent, immediately followed by its
  // sub-channels (indented). Campaigns like Content Syndication split into
  // sub-channels (L&A, Group Benefits) that each map to a different campaign,
  // so both levels are taggable, not just the parent.
  const channelRows = useMemo(() => {
    const parents = channels
      .filter((c) => !c.parent_channel_id && !c.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));
    const childrenOf = (pid: string) =>
      channels
        .filter((c) => c.parent_channel_id === pid && !c.hidden)
        .sort((a, b) => a.name.localeCompare(b.name));
    const rows: { channel: Channel; depth: number }[] = [];
    for (const p of parents) {
      rows.push({ channel: p, depth: 0 });
      for (const child of childrenOf(p.id)) {
        rows.push({ channel: child, depth: 1 });
      }
    }
    return rows;
  }, [channels]);

  // Distinct 6Sense segments, excluding the overall report.
  const segments = useMemo(
    () =>
      orderSegments(sixSenseSnapshots.map((s) => s.segment)).filter(
        (s) => s !== OVERALL_SEGMENT,
      ),
    [sixSenseSnapshots],
  );

  // Distinct Outreach sequences (id + name).
  const sequences = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of outreachSnapshots) {
      if (!m.has(s.sequence_id)) m.set(s.sequence_id, s.sequence_name);
    }
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [outreachSnapshots]);

  // Distinct LinkedIn ad sets (adset_id = adset_name; the tag asset_ref).
  const adsets = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const s of linkedinSnapshots) {
      if (!m.has(s.adset_id)) {
        m.set(s.adset_id, { id: s.adset_id, name: s.adset_name });
      }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [linkedinSnapshots]);

  const add = async () => {
    setError(null);
    try {
      const color = TAG_COLORS[tags.length % TAG_COLORS.length];
      await createTag(newName, color);
      setNewName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create campaign');
    }
  };

  const saveRename = async (id: string) => {
    setError(null);
    try {
      await renameTag(id, editDraft);
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    }
  };

  // Small helper to render a picker for one asset.
  const picker = (type: CampaignAssetType, ref: string) => (
    <CampaignTagPicker
      tags={tags}
      current={tagFor(type, ref)}
      onAssign={(tagId) => linkAsset(tagId, type, ref)}
      onClear={() => unlinkAsset(type, ref)}
    />
  );

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold text-charcoal">
          Campaigns — Tags
        </h1>
        <p className="mt-1 text-sm text-slate-muted">
          Create a campaign, then tag the assets that belong to it in each silo.
          Leads and opportunities are pulled in through the tagged channels.
        </p>
      </div>

      {/* Campaign tags */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-charcoal">Campaigns</h2>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="New campaign name (e.g. L&A)"
            className="text-sm px-2 py-1 rounded border border-border bg-bg text-charcoal min-w-[260px] focus:outline-none focus:ring-2 focus:ring-indigo/30"
          />
          <button
            type="button"
            onClick={() => void add()}
            className="text-sm px-3 py-1 rounded bg-indigo text-white hover:bg-indigo/90"
          >
            Add
          </button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}

        {tags.length === 0 ? (
          <p className="text-xs text-slate-muted italic">
            No campaigns yet. Add one above.
          </p>
        ) : (
          <ul className="space-y-1">
            {tags.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 border border-border rounded px-3 py-2"
              >
                {/* Color swatches */}
                <div className="flex items-center gap-1">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      title="Set color"
                      onClick={() => void setColor(t.id, c)}
                      className={
                        'w-4 h-4 rounded-full border ' +
                        ((t.color || '#4F46E5') === c
                          ? 'border-charcoal'
                          : 'border-transparent')
                      }
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>

                {editingId === t.id ? (
                  <>
                    <input
                      type="text"
                      value={editDraft}
                      autoFocus
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(t.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="text-sm px-2 py-0.5 rounded border border-border text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo/30"
                    />
                    <button
                      type="button"
                      onClick={() => void saveRename(t.id)}
                      className="text-xs px-2 py-1 rounded bg-indigo text-white hover:bg-indigo/90"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium text-charcoal">
                      {t.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(t.id);
                        setEditDraft(t.name);
                        setError(null);
                      }}
                      className="text-xs text-slate-muted hover:text-charcoal"
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete campaign "${t.name}"? Its asset tags will be removed.`,
                          )
                        )
                          void deleteTag(t.id);
                      }}
                      className="ml-auto text-xs text-danger hover:underline"
                      title="Delete"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Asset mapping */}
      <AssetGroup
        title="Channels"
        hint="Drives leads, MQLs, and opportunities. Tag a parent or its sub-channels. A sub-channel's own tag wins over its parent's."
      >
        {channelRows.length === 0 ? (
          <Empty label="No channels yet." />
        ) : (
          channelRows.map(({ channel, depth }) => (
            <AssetRow key={channel.id} name={channel.name} depth={depth}>
              {picker('channel', channel.id)}
            </AssetRow>
          ))
        )}
      </AssetGroup>

      <AssetGroup title="6Sense segments" hint="Drives reach and engagement.">
        {segments.length === 0 ? (
          <Empty label="No campaign segments imported yet." />
        ) : (
          segments.map((seg) => (
            <AssetRow key={seg} name={seg}>
              {picker('sixsense_segment', seg)}
            </AssetRow>
          ))
        )}
      </AssetGroup>

      <AssetGroup title="Outreach sequences" hint="Drives sent, replied, calls.">
        {sequences.length === 0 ? (
          <Empty label="No Outreach sequences yet." />
        ) : (
          sequences.map((seq) => (
            <AssetRow key={seq.id} name={seq.name}>
              {picker('outreach_sequence', String(seq.id))}
            </AssetRow>
          ))
        )}
      </AssetGroup>

      <AssetGroup
        title="LinkedIn ad sets"
        hint="Drives spend, impressions, and clicks."
      >
        {adsets.length === 0 ? (
          <Empty label="No LinkedIn ad sets imported yet." />
        ) : (
          adsets.map((a) => (
            <AssetRow key={a.id} name={a.name}>
              {picker('linkedin_adset', a.id)}
            </AssetRow>
          ))
        )}
      </AssetGroup>
    </div>
  );
}

function AssetGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-charcoal">{title}</h2>
        <p className="text-xs text-slate-muted">{hint}</p>
      </div>
      <div className="border border-border rounded divide-y divide-border">
        {children}
      </div>
    </section>
  );
}

function AssetRow({
  name,
  children,
  depth = 0,
}: {
  name: string;
  children: React.ReactNode;
  depth?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span
        className={
          'text-sm truncate ' +
          (depth > 0 ? 'text-slate-muted' : 'text-charcoal')
        }
        style={depth > 0 ? { paddingLeft: depth * 20 } : undefined}
      >
        {depth > 0 && <span className="text-slate-muted mr-1">↳</span>}
        {name}
      </span>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="px-3 py-3 text-xs text-slate-muted italic">{label}</p>;
}
