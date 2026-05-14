import { useMemo, useState } from 'react';
import { useLeads, type BulkSyncResult, type SfdcSync } from '../hooks/useLeads';
import {
  type ColumnMapping,
  type CoalesceResult,
  type LeadCandidate,
  type ParsedCsv,
  coalesceRows,
} from '../lib/csv';
import type { EditableLeadField } from '../constants/leadFields';
import DropZone from '../components/import/DropZone';
import ColumnMapper from '../components/import/ColumnMapper';
import ImportDiff from '../components/import/ImportDiff';
import ImportProgressModal from '../components/import/ImportProgressModal';

type Step = 'upload' | 'map' | 'diff' | 'running' | 'complete';

function candidateToSync(c: LeadCandidate): SfdcSync {
  const values: Partial<Record<EditableLeadField, unknown>> = {};
  // Copy only EditableLeadField-shaped keys.
  if (c.first_name !== undefined) values.first_name = c.first_name;
  if (c.last_name !== undefined) values.last_name = c.last_name;
  if (c.account !== undefined) values.account = c.account;
  if (c.title !== undefined) values.title = c.title;
  if (c.country !== undefined) values.country = c.country;
  if (c.region !== undefined) values.region = c.region;
  if (c.owner !== undefined) values.owner = c.owner;
  if (c.lead_source !== undefined) values.lead_source = c.lead_source;
  if (c.current_stage !== undefined) values.current_stage = c.current_stage;
  if (c.marketing_sourced_date !== undefined) {
    values.marketing_sourced_date = c.marketing_sourced_date;
  }
  if (c.event_activations !== undefined) {
    values.event_activations = c.event_activations;
  }
  // source_channel_id is resolved by bulkSyncFromSfdc Phase 0 from
  // (parentChannelName, subChannelName); the candidate doesn't carry it.
  return {
    email: c.email,
    values,
    parentChannelName: c.parent_campaign,
    subChannelName: c.sub_campaign,
    sfdc_lead_id: c.sfdc_lead_id,
    sfdc_contact_id: c.sfdc_contact_id,
  };
}

export default function FunnelImportPage() {
  const { leads, bulkSyncFromSfdc } = useLeads();

  const [step, setStep] = useState<Step>('upload');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BulkSyncResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const coalesce: CoalesceResult | null = useMemo(() => {
    if (!parsed || !mapping) return null;
    return coalesceRows(parsed.rows, mapping);
  }, [parsed, mapping]);

  const reset = () => {
    setStep('upload');
    setParsed(null);
    setMapping(null);
    setProgress({ done: 0, total: 0 });
    setResult(null);
    setTopError(null);
  };

  const apply = async (candidates: LeadCandidate[]) => {
    setTopError(null);
    setStep('running');
    const syncs = candidates.map(candidateToSync);
    setProgress({ done: 0, total: syncs.length });
    try {
      const r = await bulkSyncFromSfdc(syncs, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(r);
      setStep('complete');
    } catch (e) {
      setTopError(e instanceof Error ? e.message : 'Import failed');
      setStep('diff');
    }
  };

  return (
    <div className="p-8 space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-charcoal">Import</h1>
        <p className="mt-1 text-sm text-slate-muted">
          Upload a SFDC report. Locked fields are preserved; source_sfdc is
          updated either way so you can see drift.
        </p>
      </header>

      {topError && (
        <div className="px-3 py-2 rounded border border-danger/40 bg-danger/5 text-danger text-xs">
          {topError}
        </div>
      )}

      {parsed && parsed.errors.length > 0 && (
        <details className="text-xs text-slate-muted border border-border rounded p-2">
          <summary className="cursor-pointer">
            {parsed.errors.length} parser warning(s)
          </summary>
          <ul className="mt-1 space-y-0.5 list-disc list-inside">
            {parsed.errors.slice(0, 10).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {parsed.errors.length > 10 && (
              <li>...and {parsed.errors.length - 10} more</li>
            )}
          </ul>
        </details>
      )}

      <ol className="flex items-center gap-2 text-xs text-slate-muted">
        {(['upload', 'map', 'diff'] as Step[]).map((s, i) => {
          const active =
            (step === s) ||
            (step === 'running' && s === 'diff') ||
            (step === 'complete' && s === 'diff');
          const labels: Record<Step, string> = {
            upload: '1. Upload',
            map: '2. Map columns',
            diff: '3. Review diff',
            running: '',
            complete: '',
          };
          return (
            <li
              key={s}
              className={
                'px-2 py-1 rounded border ' +
                (active
                  ? 'border-indigo text-indigo bg-indigo/5'
                  : 'border-border')
              }
            >
              {labels[s]}
              {i < 2 && <span className="ml-2 text-border">→</span>}
            </li>
          );
        })}
      </ol>

      {step === 'upload' && (
        <DropZone
          onParsed={(p) => {
            setParsed(p);
            setStep('map');
          }}
        />
      )}

      {step === 'map' && parsed && (
        <ColumnMapper
          parsed={parsed}
          onContinue={(m) => {
            setMapping(m);
            setStep('diff');
          }}
          onBack={() => setStep('upload')}
        />
      )}

      {step === 'diff' && parsed && coalesce && (
        <ImportDiff
          parseSummary={{ totalRows: parsed.rows.length }}
          coalesce={coalesce}
          existingLeads={leads}
          onApply={(candidates) => void apply(candidates)}
          onBack={() => setStep('map')}
        />
      )}

      {(step === 'running' || step === 'complete') && (
        <ImportProgressModal
          total={progress.total}
          done={progress.done}
          result={result}
          onDone={reset}
        />
      )}
    </div>
  );
}
