import { useMemo } from 'react';
import type { Channel, Lead } from '../../types/db';
import { STAGE_LABELS } from '../../constants/stages';
import { REGION_LABELS } from '../../constants/regions';
import { formatDate, formatDateTime } from '../../lib/dates';
import LockIcon from '../common/LockIcon';

export type LeadSortKey =
  | 'name'
  | 'email'
  | 'account'
  | 'current_stage'
  | 'country'
  | 'region'
  | 'owner'
  | 'source_channel'
  | 'marketing_sourced_date'
  | 'updated_at';

interface Column {
  key: LeadSortKey;
  label: string;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'account', label: 'Account' },
  { key: 'current_stage', label: 'Stage' },
  { key: 'country', label: 'Country' },
  { key: 'region', label: 'Region' },
  { key: 'owner', label: 'Owner' },
  { key: 'source_channel', label: 'Source channel' },
  { key: 'marketing_sourced_date', label: 'Sourced date' },
  { key: 'updated_at', label: 'Updated' },
];

interface LeadsTableProps {
  leads: Lead[];
  channels: Channel[];
  sortKey: LeadSortKey;
  sortDir: 'asc' | 'desc';
  onSortChange: (key: LeadSortKey) => void;
  onRowClick: (leadId: string) => void;
  selectedLeadId?: string | null;
}

function leadName(l: Lead): string {
  const first = l.first_name ?? '';
  const last = l.last_name ?? '';
  const joined = `${first} ${last}`.trim();
  return joined || l.email;
}

function lockCount(l: Lead): number {
  return Object.values(l.field_locks ?? {}).filter(Boolean).length;
}

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function MissingValue() {
  return <span className="italic text-slate-muted">(none)</span>;
}

function StagePill({ stage }: { stage: Lead['current_stage'] }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-charcoal border border-border">
      {STAGE_LABELS[stage]}
    </span>
  );
}

function CellLockBadge({ lead, field }: { lead: Lead; field: string }) {
  if (!lead.field_locks?.[field]) return null;
  const sfdcRaw = lead.source_sfdc?.[field];
  const sfdcStr =
    sfdcRaw === null || sfdcRaw === undefined || sfdcRaw === ''
      ? 'no SFDC value on record'
      : String(sfdcRaw);
  const editor = lead.last_edited_by ?? 'someone';
  const when = formatDateTime(lead.updated_at);
  const tooltip = `Locked. SFDC: ${sfdcStr}. Last edited by ${editor}${
    when ? ` on ${when}` : ''
  }.`;
  return (
    <span
      title={tooltip}
      className="ml-1 inline-flex text-slate-muted"
      aria-label="Field is locked"
    >
      <LockIcon locked className="w-3 h-3" />
    </span>
  );
}

export default function LeadsTable({
  leads,
  channels,
  sortKey,
  sortDir,
  onSortChange,
  onRowClick,
  selectedLeadId,
}: LeadsTableProps) {
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const sorted = useMemo(() => {
    const copy = [...leads];
    copy.sort((a, b) => {
      let av: unknown;
      let bv: unknown;
      switch (sortKey) {
        case 'name':
          av = (a.last_name ?? '') + ' ' + (a.first_name ?? '');
          bv = (b.last_name ?? '') + ' ' + (b.first_name ?? '');
          break;
        case 'source_channel':
          av = a.source_channel_id ? channelById.get(a.source_channel_id)?.name : '';
          bv = b.source_channel_id ? channelById.get(b.source_channel_id)?.name : '';
          break;
        default:
          av = a[sortKey as keyof Lead];
          bv = b[sortKey as keyof Lead];
      }
      const cmp = compare(av, bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [leads, sortKey, sortDir, channelById]);

  if (leads.length === 0) {
    return (
      <div className="border border-border rounded-lg bg-bg p-12 text-center">
        <p className="text-charcoal font-medium">No leads yet.</p>
        <p className="mt-1 text-sm text-slate-muted">
          The CSV importer arrives in milestone 3. For now, use the new lead
          button above to add a row by hand.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-bg">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted border-b border-border">
              {COLUMNS.map((col) => {
                const active = col.key === sortKey;
                const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
                return (
                  <th
                    key={col.key}
                    onClick={() => onSortChange(col.key)}
                    className={
                      'text-left px-3 py-2 font-medium text-slate-muted cursor-pointer select-none hover:text-charcoal ' +
                      (active ? 'text-charcoal ' : '') +
                      (col.className ?? '')
                    }
                  >
                    {col.label}
                    {arrow}
                  </th>
                );
              })}
              <th className="text-left px-3 py-2 font-medium text-slate-muted">
                Locks
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((lead) => {
              const selected = lead.id === selectedLeadId;
              const channel = lead.source_channel_id
                ? channelById.get(lead.source_channel_id)
                : undefined;
              const locks = lockCount(lead);
              return (
                <tr
                  key={lead.id}
                  onClick={() => onRowClick(lead.id)}
                  className={
                    'border-b border-border last:border-b-0 cursor-pointer transition-colors ' +
                    (selected
                      ? 'bg-indigo/5 border-l-2 border-l-indigo'
                      : 'hover:bg-muted')
                  }
                >
                  <td className="px-3 py-2 text-charcoal">
                    {leadName(lead)}
                    <CellLockBadge lead={lead} field="first_name" />
                    <CellLockBadge lead={lead} field="last_name" />
                  </td>
                  <td className="px-3 py-2 text-charcoal">{lead.email}</td>
                  <td className="px-3 py-2 text-charcoal">
                    {lead.account || <MissingValue />}
                    <CellLockBadge lead={lead} field="account" />
                  </td>
                  <td className="px-3 py-2">
                    <StagePill stage={lead.current_stage} />
                    <CellLockBadge lead={lead} field="current_stage" />
                  </td>
                  <td className="px-3 py-2 text-charcoal">
                    {lead.country || <MissingValue />}
                    <CellLockBadge lead={lead} field="country" />
                  </td>
                  <td
                    className="px-3 py-2 text-charcoal"
                    title={
                      lead.region ? REGION_LABELS[lead.region] : undefined
                    }
                  >
                    {lead.region || <MissingValue />}
                    <CellLockBadge lead={lead} field="region" />
                  </td>
                  <td className="px-3 py-2 text-charcoal">
                    {lead.owner || <MissingValue />}
                    <CellLockBadge lead={lead} field="owner" />
                  </td>
                  <td className="px-3 py-2 text-charcoal">
                    {channel?.name || <MissingValue />}
                    <CellLockBadge lead={lead} field="source_channel_id" />
                  </td>
                  <td className="px-3 py-2 text-charcoal">
                    {lead.marketing_sourced_date ? (
                      formatDate(lead.marketing_sourced_date)
                    ) : (
                      <MissingValue />
                    )}
                    <CellLockBadge lead={lead} field="marketing_sourced_date" />
                  </td>
                  <td className="px-3 py-2 text-slate-muted">
                    {formatDate(lead.updated_at)}
                  </td>
                  <td className="px-3 py-2">
                    {locks > 0 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-indigo/10 text-indigo">
                        <LockIcon locked className="w-3 h-3" />
                        {locks}
                      </span>
                    ) : (
                      <span className="text-slate-muted text-xs">0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
