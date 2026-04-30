import { useState } from 'react';
import type { Channel, Lead, StageHistoryEntry } from '../../types/db';
import {
  EDITABLE_LEAD_FIELDS,
  type EditableLeadField,
} from '../../constants/leadFields';
import { formatDateTime } from '../../lib/dates';
import LeadFieldRow from './LeadFieldRow';
import StageHistoryEditor from './StageHistoryEditor';

interface LeadDetailDrawerProps {
  lead: Lead;
  channels: Channel[];
  onClose: () => void;
  onEditField: (
    field: EditableLeadField,
    value: unknown,
  ) => Promise<void>;
  onToggleLock: (
    field: EditableLeadField,
    locked: boolean,
  ) => Promise<void>;
  onRevertField: (field: EditableLeadField) => Promise<void>;
  onSetStageHistory: (entries: StageHistoryEntry[]) => Promise<void>;
  onDelete: () => Promise<void>;
}

function leadName(l: Lead): string {
  const first = l.first_name ?? '';
  const last = l.last_name ?? '';
  const joined = `${first} ${last}`.trim();
  return joined || l.email;
}

function ReadOnlyRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex justify-between items-baseline gap-3 text-sm">
      <span className="text-xs text-slate-muted">{label}</span>
      <span className="text-charcoal font-mono text-xs break-all">
        {value || <span className="italic text-slate-muted">(none)</span>}
      </span>
    </div>
  );
}

export default function LeadDetailDrawer({
  lead,
  channels,
  onClose,
  onEditField,
  onToggleLock,
  onRevertField,
  onSetStageHistory,
  onDelete,
}: LeadDetailDrawerProps) {
  const [topError, setTopError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const wrapEdit = async (field: EditableLeadField, value: unknown) => {
    try {
      setTopError(null);
      await onEditField(field, value);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : 'Save failed');
      throw e;
    }
  };
  const wrapToggle = async (field: EditableLeadField, locked: boolean) => {
    try {
      setTopError(null);
      await onToggleLock(field, locked);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : 'Save failed');
      throw e;
    }
  };
  const wrapRevert = async (field: EditableLeadField) => {
    try {
      setTopError(null);
      await onRevertField(field);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : 'Revert failed');
      throw e;
    }
  };

  const lockCount = Object.values(lead.field_locks ?? {}).filter(Boolean).length;

  return (
    <aside className="w-full lg:w-[480px] lg:flex-shrink-0 border-l border-border bg-bg overflow-y-auto">
      <div className="sticky top-0 z-10 bg-bg border-b border-border px-5 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-charcoal truncate">
            {leadName(lead)}
          </h2>
          <p className="text-xs text-slate-muted truncate">{lead.email}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-slate-muted hover:text-charcoal text-xl leading-none px-2"
        >
          ×
        </button>
      </div>

      {topError && (
        <div className="mx-5 mt-3 px-3 py-2 rounded border border-danger/40 bg-danger/5 text-danger text-xs">
          {topError}
        </div>
      )}

      <section className="px-5 py-4 space-y-2 border-b border-border">
        <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
          Identity
        </h3>
        <ReadOnlyRow label="Lead id" value={lead.id} />
        <ReadOnlyRow label="SFDC lead id" value={lead.sfdc_lead_id} />
        <ReadOnlyRow label="SFDC contact id" value={lead.sfdc_contact_id} />
        <ReadOnlyRow label="HubSpot contact id" value={lead.hubspot_contact_id} />
      </section>

      <section className="px-5 py-4 space-y-4 border-b border-border">
        <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
          Editable fields
        </h3>
        {EDITABLE_LEAD_FIELDS.map((f) => (
          <LeadFieldRow
            key={f}
            lead={lead}
            field={f}
            channels={channels}
            onCommit={(v) => wrapEdit(f, v)}
            onToggleLock={(locked) => wrapToggle(f, locked)}
            onRevert={() => wrapRevert(f)}
          />
        ))}
      </section>

      <section className="px-5 py-4 space-y-3 border-b border-border">
        <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
          Stage history
        </h3>
        <StageHistoryEditor
          history={lead.stage_history ?? []}
          currentStage={lead.current_stage}
          onSave={onSetStageHistory}
        />
      </section>

      <section className="px-5 py-4 space-y-2 border-b border-border">
        <h3 className="text-xs font-medium text-slate-muted uppercase tracking-wide">
          Bookkeeping
        </h3>
        <ReadOnlyRow label="Created" value={formatDateTime(lead.created_at)} />
        <ReadOnlyRow label="Updated" value={formatDateTime(lead.updated_at)} />
        <ReadOnlyRow
          label="Last synced"
          value={lead.last_synced_at ? formatDateTime(lead.last_synced_at) : null}
        />
        <ReadOnlyRow label="Last edited by" value={lead.last_edited_by} />
        <ReadOnlyRow label="Locked fields" value={String(lockCount)} />
      </section>

      <section className="px-5 py-4 flex items-center gap-2">
        {confirmDelete ? (
          <>
            <span className="text-xs text-charcoal">Delete this lead?</span>
            <button
              type="button"
              onClick={async () => {
                try {
                  setTopError(null);
                  await onDelete();
                } catch (e) {
                  setTopError(e instanceof Error ? e.message : 'Delete failed');
                  setConfirmDelete(false);
                }
              }}
              className="text-xs px-2 py-1 rounded bg-danger text-white"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-xs px-2 py-1 rounded text-slate-muted hover:text-charcoal"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-danger hover:underline"
          >
            Delete lead
          </button>
        )}
      </section>
    </aside>
  );
}
