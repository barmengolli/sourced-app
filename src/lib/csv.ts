import Papa from 'papaparse';
import type { StageKey } from '../types/db';
import { mapLifecycleStage } from '../constants/stageMapping';
import {
  regionForCountry,
  type RegionKey,
} from '../constants/regions';
import {
  parseEventActivations,
  type EventActivationValue,
} from '../constants/eventActivations';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
}

export interface LeadCandidate {
  email: string;
  first_name?: string;
  last_name?: string;
  account?: string;
  title?: string;
  country?: string;
  region?: RegionKey;
  owner?: string;
  lead_source?: string;
  current_stage?: StageKey;
  marketing_sourced_date?: string;
  sfdc_lead_id?: string;
  sfdc_contact_id?: string;
  parent_campaign?: string;
  sub_campaign?: string;
  // Parsed from the SFDC "Event Activation" column (semicolon-
  // separated). Always set: empty array when the cell is empty or
  // contains only unknown values. Letting this be `undefined` would
  // make field_locks behave inconsistently between leads with a
  // mapped-but-empty column and leads from a CSV that didn't map it.
  event_activations?: EventActivationValue[];
}

export type MappingValue = string | { primary: string; fallback?: string };
export type ColumnMapping = Record<string, MappingValue | undefined>;

export interface CoalesceResult {
  candidates: LeadCandidate[];
  duplicatesCollapsed: number;
  rowsSkipped: number;
  parseWarnings: string[];
}

export const MAPPABLE_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'account',
  'title',
  'country',
  'owner',
  'lead_source',
  'current_stage',
  'marketing_sourced_date',
  'sfdc_lead_id',
  'sfdc_contact_id',
  'parent_campaign',
  'sub_campaign',
  'event_activations',
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

const COALESCE_FIELDS: ReadonlySet<MappableField> = new Set([
  'country',
  'lead_source',
  'current_stage',
  // SFDC exports "Contact: Event Activation" and "Lead: Event
  // Activation" (one per record type). Coalesce Contact-first, Lead
  // fallback, matching the other prefixed fields.
  'event_activations',
]);

export function isCoalesceField(f: MappableField): boolean {
  return COALESCE_FIELDS.has(f);
}

export function parseCsv(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        const rows = (results.data ?? []).filter(
          (r): r is Record<string, string> => r !== null && typeof r === 'object',
        );
        const errors = results.errors.map(
          (e) => `${e.type ?? 'Error'} (row ${e.row ?? '?'}): ${e.message}`,
        );
        resolve({ headers, rows, errors });
      },
      error: (err) => reject(err),
    });
  });
}

const MD_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export function parseSfdcDate(input: string | undefined | null): string | null {
  if (!input) return null;
  const m = MD_RE.exec(input.trim());
  if (!m) return null;
  const month = m[1].padStart(2, '0');
  const day = m[2].padStart(2, '0');
  const year = m[3];
  return `${year}-${month}-${day}`;
}

function readMapped(
  row: Record<string, string>,
  mapping: MappingValue | undefined,
): string | undefined {
  if (!mapping) return undefined;
  if (typeof mapping === 'string') {
    const v = row[mapping];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  const primary = row[mapping.primary]?.trim();
  if (primary) return primary;
  if (mapping.fallback) {
    const fallback = row[mapping.fallback]?.trim();
    if (fallback) return fallback;
  }
  return undefined;
}

export function coalesceRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): CoalesceResult {
  const byEmail = new Map<string, LeadCandidate>();
  let rowsSkipped = 0;
  let duplicatesCollapsed = 0;
  const warnings: string[] = [];
  let badDateCount = 0;
  const skippedSamples: number[] = [];

  rows.forEach((row, idx) => {
    const rawEmail = readMapped(row, mapping.email);
    const email = rawEmail?.toLowerCase();
    if (!email) {
      rowsSkipped += 1;
      if (skippedSamples.length < 10) skippedSamples.push(idx + 2); // +2 for header + 1-index
      return;
    }
    if (byEmail.has(email)) {
      duplicatesCollapsed += 1;
      return;
    }

    const dateRaw = readMapped(row, mapping.marketing_sourced_date);
    let parsedDate: string | undefined;
    if (dateRaw) {
      const ok = parseSfdcDate(dateRaw);
      if (ok) {
        parsedDate = ok;
      } else {
        badDateCount += 1;
        if (badDateCount <= 5) {
          warnings.push(
            `Row ${idx + 2}: could not parse "${dateRaw}" as M/D/YYYY`,
          );
        }
      }
    }

    const stageRaw = readMapped(row, mapping.current_stage);
    const stage: StageKey | undefined =
      stageRaw !== undefined ? mapLifecycleStage(stageRaw) : undefined;

    const country = readMapped(row, mapping.country);
    // Event activations: only set when the column is mapped (so a CSV
    // without the column doesn't clobber existing values on
    // re-import). Empty cell → empty array, which is semantically
    // "no activations" and will overwrite stored values for unlocked
    // leads (intended; that's how the lock contract works elsewhere).
    let eventActivations: EventActivationValue[] | undefined;
    if (mapping.event_activations) {
      const raw = readMapped(row, mapping.event_activations) ?? '';
      eventActivations = parseEventActivations(raw);
    }
    const candidate: LeadCandidate = {
      email,
      first_name: readMapped(row, mapping.first_name),
      last_name: readMapped(row, mapping.last_name),
      account: readMapped(row, mapping.account),
      title: readMapped(row, mapping.title),
      country,
      // Derive region from country at import time. The user can override
      // later via the Lead drawer; the lock contract preserves overrides
      // across re-imports.
      region: regionForCountry(country),
      owner: readMapped(row, mapping.owner),
      lead_source: readMapped(row, mapping.lead_source),
      current_stage: stage,
      marketing_sourced_date: parsedDate,
      sfdc_lead_id: readMapped(row, mapping.sfdc_lead_id),
      sfdc_contact_id: readMapped(row, mapping.sfdc_contact_id),
      parent_campaign: readMapped(row, mapping.parent_campaign),
      sub_campaign: readMapped(row, mapping.sub_campaign),
      event_activations: eventActivations,
    };

    byEmail.set(email, candidate);
  });

  if (rowsSkipped > 0 && skippedSamples.length > 0) {
    warnings.unshift(
      `${rowsSkipped} row(s) skipped for empty email. First examples: line ${skippedSamples.join(', ')}`,
    );
  }
  if (badDateCount > 5) {
    warnings.push(`...and ${badDateCount - 5} more date parse failures`);
  }

  return {
    candidates: [...byEmail.values()],
    duplicatesCollapsed,
    rowsSkipped,
    parseWarnings: warnings,
  };
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const HEADER_ALIASES: Record<MappableField, string[]> = {
  email: ['email'],
  first_name: ['firstname'],
  last_name: ['lastname'],
  account: [
    'contactaccountnameaccountname',
    'accountname',
    'account',
    'companyname',
    'company',
  ],
  title: ['title', 'jobtitle'],
  country: ['country'],
  owner: ['owner', 'leadowner', 'contactowner'],
  lead_source: ['leadsource'],
  current_stage: ['hubspotlifecyclestage', 'lifecyclestage', 'stage'],
  marketing_sourced_date: [
    'memberfirstassociateddate',
    'firstassociateddate',
    'sourceddate',
    'marketingsourceddate',
  ],
  sfdc_lead_id: ['leadleadid', 'leadid'],
  sfdc_contact_id: ['contactcontactid', 'contactid'],
  parent_campaign: ['parentcampaigncampaignname', 'parentcampaign'],
  sub_campaign: ['campaignname', 'campaign'],
  event_activations: ['eventactivation', 'eventactivations'],
};

const CONTACT_PREFIX = 'contact';
const LEAD_PREFIX = 'lead';

function findHeader(
  headers: string[],
  aliases: string[],
  prefix?: string,
): string | undefined {
  for (const h of headers) {
    const norm = normalizeHeader(h);
    if (prefix && !norm.startsWith(prefix)) continue;
    const stripped = prefix ? norm.slice(prefix.length) : norm;
    for (const a of aliases) {
      if (stripped === a || stripped === normalizeHeader(prefix ? prefix + a : a)) {
        return h;
      }
    }
  }
  return undefined;
}

function findExact(headers: string[], aliases: string[]): string | undefined {
  for (const h of headers) {
    const norm = normalizeHeader(h);
    if (aliases.includes(norm)) return h;
  }
  return undefined;
}

export function suggestMapping(headers: string[]): ColumnMapping {
  const out: ColumnMapping = {};

  // Direct, non-coalesced fields.
  for (const f of [
    'email',
    'first_name',
    'last_name',
    'account',
    'title',
    'owner',
    'marketing_sourced_date',
    'parent_campaign',
    'sub_campaign',
  ] as MappableField[]) {
    const found = findExact(headers, HEADER_ALIASES[f]);
    if (found) out[f] = found;
  }

  // Coalesced fields: prefer Contact: prefix first, fall back to Lead: prefix.
  for (const f of [
    'country',
    'lead_source',
    'current_stage',
    'event_activations',
  ] as MappableField[]) {
    const aliases = HEADER_ALIASES[f];
    const primary =
      findHeader(headers, aliases, CONTACT_PREFIX) ?? findExact(headers, aliases);
    const fallback = findHeader(headers, aliases, LEAD_PREFIX);
    if (primary && fallback && primary !== fallback) {
      out[f] = { primary, fallback };
    } else if (primary) {
      out[f] = primary;
    } else if (fallback) {
      out[f] = fallback;
    }
  }

  // System IDs: prefer their prefixed form.
  const contactId =
    findHeader(headers, HEADER_ALIASES.sfdc_contact_id, CONTACT_PREFIX) ??
    findExact(headers, HEADER_ALIASES.sfdc_contact_id);
  if (contactId) out.sfdc_contact_id = contactId;
  const leadId =
    findHeader(headers, HEADER_ALIASES.sfdc_lead_id, LEAD_PREFIX) ??
    findExact(headers, HEADER_ALIASES.sfdc_lead_id);
  if (leadId) out.sfdc_lead_id = leadId;

  return out;
}

export function headerSetKey(headers: string[]): string {
  const sorted = [...headers].map((h) => h.trim().toLowerCase()).sort();
  // Simple stable hash (FNV-1a 32-bit).
  let hash = 0x811c9dc5;
  for (const s of sorted) {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x2c; // separator (',')
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
