import { useEffect, useMemo, useState } from 'react';
import {
  type ColumnMapping,
  type MappableField,
  type MappingValue,
  type ParsedCsv,
  MAPPABLE_FIELDS,
  isCoalesceField,
  headerSetKey,
  suggestMapping,
} from '../../lib/csv';
import { readJson, writeJson } from '../../lib/storage';

const MAPPING_KEY_PREFIX = 'sourced.csvMapping.';

const FIELD_LABELS: Record<MappableField, string> = {
  email: 'Email (required)',
  first_name: 'First name',
  last_name: 'Last name',
  account: 'Account',
  title: 'Title',
  country: 'Country',
  owner: 'Owner',
  lead_source: 'Lead source',
  current_stage: 'Lifecycle stage',
  marketing_sourced_date: 'Marketing sourced date',
  sfdc_lead_id: 'SFDC lead id',
  sfdc_contact_id: 'SFDC contact id',
  parent_campaign: 'Parent campaign (stash)',
  sub_campaign: 'Sub campaign (stash)',
};

interface ColumnMapperProps {
  parsed: ParsedCsv;
  onContinue: (mapping: ColumnMapping) => void;
  onBack: () => void;
}

function getPrimary(value: MappingValue | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.primary;
}
function getFallback(value: MappingValue | undefined): string {
  if (!value || typeof value === 'string') return '';
  return value.fallback ?? '';
}

export default function ColumnMapper({
  parsed,
  onContinue,
  onBack,
}: ColumnMapperProps) {
  const storageKey = useMemo(
    () => MAPPING_KEY_PREFIX + headerSetKey(parsed.headers),
    [parsed.headers],
  );

  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    const saved = readJson<ColumnMapping | null>(storageKey, null);
    if (saved) return saved;
    return suggestMapping(parsed.headers);
  });

  // Persist on every change.
  useEffect(() => {
    writeJson(storageKey, mapping);
  }, [storageKey, mapping]);

  const setField = (field: MappableField, primary: string) => {
    setMapping((prev) => {
      const next: ColumnMapping = { ...prev };
      const wasFallback = getFallback(prev[field]);
      if (!primary) {
        delete next[field];
      } else if (isCoalesceField(field) && wasFallback) {
        next[field] = { primary, fallback: wasFallback };
      } else {
        next[field] = primary;
      }
      return next;
    });
  };

  const setFallback = (field: MappableField, fallback: string) => {
    setMapping((prev) => {
      const next: ColumnMapping = { ...prev };
      const primary = getPrimary(prev[field]);
      if (!primary) return next;
      if (!fallback) {
        next[field] = primary;
      } else {
        next[field] = { primary, fallback };
      }
      return next;
    });
  };

  const reset = () => setMapping(suggestMapping(parsed.headers));

  const emailMapped = Boolean(getPrimary(mapping.email));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-charcoal">
            Map CSV columns
          </h2>
          <p className="text-sm text-slate-muted">
            {parsed.headers.length} columns, {parsed.rows.length} rows. Mapping
            saved per header set in localStorage.
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="text-sm px-3 py-1.5 rounded border border-border text-charcoal hover:bg-muted"
        >
          Reset to suggested
        </button>
      </div>

      <div className="border border-border rounded-lg bg-bg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted border-b border-border">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-slate-muted w-1/3">
                Lead field
              </th>
              <th className="text-left px-3 py-2 font-medium text-slate-muted">
                CSV column
              </th>
              <th className="text-left px-3 py-2 font-medium text-slate-muted">
                Fallback (Lead: side)
              </th>
            </tr>
          </thead>
          <tbody>
            {MAPPABLE_FIELDS.map((field) => {
              const primary = getPrimary(mapping[field]);
              const fallback = getFallback(mapping[field]);
              const coalesce = isCoalesceField(field);
              return (
                <tr
                  key={field}
                  className="border-b border-border last:border-b-0"
                >
                  <td className="px-3 py-2 text-charcoal align-top">
                    {FIELD_LABELS[field]}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={primary}
                      onChange={(e) => setField(field, e.target.value)}
                      className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                    >
                      <option value="">(skip)</option>
                      {parsed.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {coalesce ? (
                      <select
                        value={fallback}
                        disabled={!primary}
                        onChange={(e) => setFallback(field, e.target.value)}
                        className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal disabled:opacity-50"
                      >
                        <option value="">(none)</option>
                        {parsed.headers
                          .filter((h) => h !== primary)
                          .map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <span className="text-xs text-slate-muted italic">
                        not coalesced
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-sm px-3 py-1.5 rounded text-slate-muted hover:text-charcoal"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => onContinue(mapping)}
          disabled={!emailMapped}
          className="text-sm px-3 py-1.5 rounded bg-indigo text-white disabled:opacity-40"
        >
          Continue to diff
        </button>
        {!emailMapped && (
          <span className="text-xs text-slate-muted">
            Email mapping is required.
          </span>
        )}
      </div>
    </div>
  );
}
