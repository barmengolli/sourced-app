// Duplicate-opportunity detection helpers for the Create HPP flow.
// Three layers, evaluated in order per existing deal:
//
//   1. Salesforce link exact match (after URL normalization)
//   2. Name exact match (trim + lowercase + collapse whitespace)
//   3. Fuzzy name match via Dice coefficient on character bigrams,
//      threshold 0.85
//
// Layer 1 and 2 produce a hard block; layer 3 is a soft warning.
// All matching is purely client-side off the already-loaded
// attribution list — no extra round-trip.

import type { Attribution } from '../types/db';

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeSalesforceLink(
  url: string | null | undefined,
): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    u.search = '';
    u.hash = '';
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return trimmed.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

// Dice coefficient on character bigrams. Returns 0..1, where 1 is
// an exact normalized match. Robust to small typos and punctuation
// drift ("Acme Corp" vs "Acme Corp.") which is the common dup case.
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  for (const [bg, count] of ba) {
    const other = bb.get(bg) ?? 0;
    overlap += Math.min(count, other);
  }
  const total =
    [...ba.values()].reduce((s, n) => s + n, 0) +
    [...bb.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export interface DupeExactMatch {
  dealId: string;
  matchedOn: 'sf_link' | 'name';
  // The existing deal's display name, surfaced in the error banner.
  name: string;
}

export interface DupeFuzzyMatch {
  dealId: string;
  name: string;
  similarity: number;
}

export interface DupeCheckResult {
  exactMatch: DupeExactMatch | null;
  fuzzyMatches: DupeFuzzyMatch[];
}

const FUZZY_THRESHOLD = 0.85;
const FUZZY_MATCH_CAP = 3;

interface DealEntry {
  name: string;
  sfLink: string;
}

// Collapse attribution rows to one canonical entry per deal_id. We
// prefer the HPP row's name + sf_link since that's where users
// originally enter deal metadata; fall back to whichever row sits
// first in the chain.
function collapseToDealEntries(
  attributions: Attribution[],
  currentDealId: string | undefined,
): Map<string, DealEntry> {
  const byDeal = new Map<string, { entry: DealEntry; isHpp: boolean }>();
  for (const a of attributions) {
    if (!a.deal_id) continue;
    if (currentDealId && a.deal_id === currentDealId) continue;
    const existing = byDeal.get(a.deal_id);
    const isHpp = a.stage_key === 'hpp';
    const candidate: DealEntry = {
      name: a.label ?? '',
      sfLink: a.sf_link ?? '',
    };
    if (!existing) {
      byDeal.set(a.deal_id, { entry: candidate, isHpp });
    } else if (isHpp && !existing.isHpp) {
      byDeal.set(a.deal_id, { entry: candidate, isHpp });
    }
  }
  const out = new Map<string, DealEntry>();
  for (const [id, v] of byDeal) out.set(id, v.entry);
  return out;
}

export function checkForDuplicates(args: {
  name: string;
  sfLink: string | null | undefined;
  attributions: Attribution[];
  // Optional — exclude this deal from matching so an edit-mode
  // uniqueness check (future) won't flag the deal against itself.
  currentDealId?: string;
}): DupeCheckResult {
  const { name, sfLink, attributions, currentDealId } = args;
  const targetName = normalizeName(name);
  const targetLink = normalizeSalesforceLink(sfLink);
  if (!targetName && !targetLink) {
    return { exactMatch: null, fuzzyMatches: [] };
  }

  const byDeal = collapseToDealEntries(attributions, currentDealId);

  let exactMatch: DupeExactMatch | null = null;
  const fuzzyMatches: DupeFuzzyMatch[] = [];

  for (const [dealId, entry] of byDeal) {
    if (targetLink && normalizeSalesforceLink(entry.sfLink) === targetLink) {
      exactMatch = { dealId, matchedOn: 'sf_link', name: entry.name };
      break;
    }
    if (targetName && normalizeName(entry.name) === targetName) {
      exactMatch = { dealId, matchedOn: 'name', name: entry.name };
      break;
    }
    if (targetName) {
      const sim = nameSimilarity(name, entry.name);
      if (sim >= FUZZY_THRESHOLD) {
        fuzzyMatches.push({ dealId, name: entry.name, similarity: sim });
      }
    }
  }

  fuzzyMatches.sort((a, b) => b.similarity - a.similarity);
  return { exactMatch, fuzzyMatches: fuzzyMatches.slice(0, FUZZY_MATCH_CAP) };
}
