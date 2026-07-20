// Step 4B: pure tests for the realtime pending-field merge and the comparable-
// field accessor. No Supabase, no network.

import { describe, it, expect } from 'vitest';
import { mergePendingLeadFields, comparableField } from './leadSync';
import { lead } from '../test/fixtures/factories';

describe('mergePendingLeadFields — optimistic-echo merge', () => {
  it('keeps the local value for a field still pending, takes server for the rest', () => {
    const local = lead({ id: 'L', account: 'Optimistic', owner: 'Old owner' });
    const incoming = lead({ id: 'L', account: 'Server echo (stale)', owner: 'New owner' });
    // account is mid-flight locally; owner is not.
    const merged = mergePendingLeadFields(incoming, local, (f) => f === 'account');
    expect(merged.account).toBe('Optimistic'); // local wins
    expect(merged.owner).toBe('New owner'); // server wins
  });

  it('takes the full server row when nothing is pending', () => {
    const local = lead({ id: 'L', account: 'A', title: 'T1' });
    const incoming = lead({ id: 'L', account: 'B', title: 'T2' });
    const merged = mergePendingLeadFields(incoming, local, () => false);
    expect(merged.account).toBe('B');
    expect(merged.title).toBe('T2');
  });

  it('settles to server state once the pending flag clears (later echo)', () => {
    const local = lead({ id: 'L', account: 'Optimistic' });
    const incoming = lead({ id: 'L', account: 'Server final' });
    // First echo while pending keeps local; a later echo with pending cleared
    // takes the server value.
    const whilePending = mergePendingLeadFields(incoming, local, (f) => f === 'account');
    expect(whilePending.account).toBe('Optimistic');
    const afterSettle = mergePendingLeadFields(incoming, whilePending, () => false);
    expect(afterSettle.account).toBe('Server final');
  });

  it('does not mutate the inputs', () => {
    const local = lead({ id: 'L', account: 'A' });
    const incoming = lead({ id: 'L', account: 'B' });
    const before = { ...incoming };
    mergePendingLeadFields(incoming, local, () => true);
    expect(incoming).toEqual(before);
  });
});

describe('comparableField — typed diff accessor', () => {
  it('reads an editable field from a Lead', () => {
    const l = lead({ account: 'Acme' });
    expect(comparableField(l, 'account')).toBe('Acme');
  });

  it('returns undefined for a field the candidate did not set', () => {
    expect(comparableField({}, 'account')).toBeUndefined();
  });
});
