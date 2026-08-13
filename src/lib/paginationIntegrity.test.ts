import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertUniquePagedIds } from './paginationIntegrity';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing source markers: ${start} / ${end}`);
  return source.slice(from, to);
}

describe('reporting pagination integrity', () => {
  it('accepts a complete page set whose primary keys are unique', () => {
    expect(() =>
      assertUniquePagedIds([{ id: 'row-a' }, { id: 'row-b' }], 'Test rows'),
    ).not.toThrow();
  });

  it('fails closed on a duplicate without leaking its identifier', () => {
    const duplicateId = 'private-record-id';
    expect(() =>
      assertUniquePagedIds(
        [{ id: duplicateId }, { id: 'row-b' }, { id: duplicateId }],
        'Test rows',
      ),
    ).toThrow('Test rows pagination returned duplicate rows; refusing incomplete reporting data.');

    try {
      assertUniquePagedIds([{ id: duplicateId }, { id: duplicateId }], 'Test rows');
    } catch (error) {
      expect(String(error)).not.toContain(duplicateId);
    }
  });

  it('pages Leads by immutable unique id, never by the tied update timestamp', () => {
    const source = read('src/hooks/useLeads.ts');
    const fetcher = between(source, 'async function fetchAllLeads', '// Resolve channel hierarchy');

    expect(fetcher).toContain(".order('id', { ascending: true })");
    expect(fetcher).toContain("assertUniquePagedIds(all, 'Lead')");
    expect(fetcher).not.toContain(".order('updated_at'");
    expect(fetcher.indexOf(".order('id'")).toBeLessThan(fetcher.indexOf('.range('));
  });

  it('pages campaign memberships by immutable unique id, never by the tied creation timestamp', () => {
    const source = read('src/hooks/useLeadCampaignTouches.ts');
    const fetcher = between(
      source,
      'async function fetchAllLeadCampaignTouches',
      'export function useLeadCampaignTouches',
    );

    expect(fetcher).toContain(".order('id', { ascending: true })");
    expect(fetcher).toContain("assertUniquePagedIds(all, 'Campaign membership')");
    expect(fetcher).not.toContain(".order('created_at'");
    expect(fetcher.indexOf(".order('id'")).toBeLessThan(fetcher.indexOf('.range('));
  });
});
