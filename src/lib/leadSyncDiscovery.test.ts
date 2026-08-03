// Bite 4G1: pure discovery/summary module and the static safety gates for
// the disabled read-only discovery workflow. Synthetic data only: no real
// API names beyond documented standard Salesforce ones, no record ids, no
// person data, no credentials, no URLs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoIdentifierLeakage,
  summarizeDiscovery,
} from './leadSyncDiscovery';
import type {
  CampaignMemberVolume,
  DiscoveryInput,
  DiscoveredField,
  ObjectFieldDiscovery,
} from './leadSyncDiscovery';
import type {
  LifecycleHistoryConfig,
  PersonIdentityMap,
  SalesforceHistoryRow,
} from './salesforceLifecycleHistory';

// --- synthetic fixtures ----------------------------------------------------

function field(over: Partial<DiscoveredField> = {}): DiscoveredField {
  return {
    apiName: 'Synth_Field__c',
    label: 'Synth Field',
    dataType: 'Picklist',
    isHistoryTracked: false,
    ...over,
  };
}

function fields(object: ObjectFieldDiscovery['object'], list: DiscoveredField[]): ObjectFieldDiscovery {
  return { object, fields: list };
}

const LIFECYCLE_FIELD = 'Synth_Lifecycle_Stage__c';

const CONFIG: LifecycleHistoryConfig = {
  lifecycleFieldApiName: LIFECYCLE_FIELD,
  stageValueMap: {
    'Synth Lead': 'lead',
    'Synth MQL': 'mql',
    'Synth Customer': 'out_of_scope',
  },
  historyAvailableSince: '2025-01-01',
};

const IDENTITY: PersonIdentityMap = {
  byLeadId: { 'SYNTH-LEAD-1': 'person-1', 'SYNTH-LEAD-2': 'person-2' },
  byContactId: { 'SYNTH-CONTACT-1': 'person-1' },
};

function historyRow(over: Partial<SalesforceHistoryRow> = {}): SalesforceHistoryRow {
  return {
    historyId: 'SYNTH-HIST-1',
    parentId: 'SYNTH-LEAD-1',
    parentObject: 'Lead',
    field: LIFECYCLE_FIELD,
    oldValue: 'Synth Lead',
    newValue: 'Synth MQL',
    changedAt: '2026-03-01T10:00:00.000Z',
    ...over,
  };
}

const VOLUME: CampaignMemberVolume = {
  incrementalWindowRows: 120,
  fullReconciliationRows: 2600,
  currentRowLimit: 5000,
  leadMemberRows: 900,
  contactMemberRows: 1700,
  convertedLeadsWithContactLink: 300,
  convertedLeadsMissingContactLink: 4,
  missingCampaignMemberId: 0,
  missingCampaignId: 0,
  missingPersonIdentity: 0,
  missingTouchDate: 0,
  missingCampaignChannelMapping: 0,
};

function input(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    leadFields: fields('Lead', [
      field({ apiName: LIFECYCLE_FIELD, label: 'Lifecycle Stage', isHistoryTracked: true }),
    ]),
    contactFields: fields('Contact', [
      field({ apiName: LIFECYCLE_FIELD, label: 'Lifecycle Stage', isHistoryTracked: true }),
    ]),
    campaignMemberFields: fields('CampaignMember', [
      field({ apiName: 'CreatedDate', label: 'Created Date', dataType: 'DateTime' }),
      field({ apiName: 'FirstRespondedDate', label: 'First Responded Date', dataType: 'Date' }),
    ]),
    leadHistory: { queryable: true, rowsSampled: 1, oldest: '2025-02-01T00:00:00.000Z', newest: '2026-07-01T00:00:00.000Z' },
    contactHistory: { queryable: true, rowsSampled: 1, oldest: '2025-03-01T00:00:00.000Z', newest: '2026-07-15T00:00:00.000Z' },
    lifecycleValues: [
      { value: 'Synth Lead', count: 1800 },
      { value: 'Synth MQL', count: 400 },
    ],
    historyRows: [],
    historyConfig: CONFIG,
    identity: IDENTITY,
    campaignMembers: VOLUME,
    unresolvedDecisions: ['Member First Associated Date API field unconfirmed'],
    plannedBatchSize: 2000,
    ...over,
  };
}

// --- field discovery -------------------------------------------------------

describe('lifecycle field discovery', () => {
  it('reports the field found on both objects with tracking flags', () => {
    const s = summarizeDiscovery(input());
    expect(s.lifecycleField.lead.found).toBe(true);
    expect(s.lifecycleField.contact.found).toBe(true);
    expect(s.lifecycleField.lead.apiNames).toEqual([LIFECYCLE_FIELD]);
    expect(s.lifecycleField.lead.historyTrackedApiNames).toEqual([LIFECYCLE_FIELD]);
    expect(s.lifecycleField.apiNamesMatch).toBe(true);
  });

  it('reports the field absent when the object exposes no lifecycle field', () => {
    const s = summarizeDiscovery(
      input({ contactFields: fields('Contact', [field({ apiName: 'Other__c', label: 'Other' })]) }),
    );
    expect(s.lifecycleField.contact.found).toBe(false);
    expect(s.lifecycleField.contact.apiNames).toEqual([]);
    expect(s.lifecycleField.apiNamesMatch).toBe(false);
  });

  it('flags DIFFERENT API names on Lead and Contact instead of assuming one shape', () => {
    const s = summarizeDiscovery(
      input({
        contactFields: fields('Contact', [
          field({ apiName: 'Contact_Lifecycle__c', label: 'Lifecycle Stage', isHistoryTracked: true }),
        ]),
      }),
    );
    expect(s.lifecycleField.lead.found).toBe(true);
    expect(s.lifecycleField.contact.found).toBe(true);
    // The current production code assumes one shape; discovery must surface
    // the mismatch rather than hide it.
    expect(s.lifecycleField.apiNamesMatch).toBe(false);
  });

  it('separates history-tracked from untracked candidates', () => {
    const s = summarizeDiscovery(
      input({
        leadFields: fields('Lead', [
          field({ apiName: LIFECYCLE_FIELD, label: 'Lifecycle Stage', isHistoryTracked: false }),
        ]),
      }),
    );
    expect(s.lifecycleField.lead.historyTrackedApiNames).toEqual([]);
    expect(s.lifecycleField.lead.notHistoryTrackedApiNames).toEqual([LIFECYCLE_FIELD]);
  });

  it('surfaces candidate date fields without choosing one', () => {
    const s = summarizeDiscovery(
      input({
        leadFields: fields('Lead', [
          field({ apiName: LIFECYCLE_FIELD, label: 'Lifecycle Stage' }),
          field({ apiName: 'Became_MQL_Date__c', label: 'Became MQL Date', dataType: 'Date' }),
        ]),
      }),
    );
    expect(s.candidateDateFields.becameMql).toContain('Became_MQL_Date__c');
    expect(s.candidateDateFields.campaignMemberDateFields).toContain('CreatedDate');
    // "Member First Associated Date" stays an explicit unresolved decision.
    expect(s.unresolvedDecisions.join(' ')).toContain('Member First Associated Date');
  });
});

// --- history access --------------------------------------------------------

describe('history access', () => {
  it('records granted access with window bounds', () => {
    const s = summarizeDiscovery(input());
    expect(s.history.lead.queryable).toBe(true);
    expect(s.history.lead.oldestTimestamp).toBe('2025-02-01T00:00:00.000Z');
    expect(s.history.contact.newestTimestamp).toBe('2026-07-15T00:00:00.000Z');
    expect(s.history.lead.deniedReason).toBeNull();
  });

  it('records denied access distinctly from an empty result', () => {
    const s = summarizeDiscovery(
      input({ leadHistory: { queryable: false, reason: 'permission_denied' } }),
    );
    expect(s.history.lead.queryable).toBe(false);
    expect(s.history.lead.deniedReason).toBe('permission_denied');
    expect(s.history.lead.oldestTimestamp).toBeNull();
    // Denied is not the same as "no history exists".
    expect(s.history.lead.rowsSampled).toBe(0);
  });
});

// --- transition classification (delegated to the 4B adapter) ---------------

describe('transition counting', () => {
  it('counts a same-day Lead to MQL transition', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [
          historyRow({
            historyId: 'SYNTH-HIST-A',
            oldValue: 'Synth Lead',
            newValue: 'Synth MQL',
            changedAt: '2026-03-01T09:00:00.000Z',
          }),
        ],
      }),
    );
    expect(s.transitions.leadToMql).toBe(1);
    expect(s.transitions.mqlToLead).toBe(0);
  });

  it('counts an MQL to Lead demotion and a later requalification separately', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [
          historyRow({ historyId: 'H1', oldValue: 'Synth Lead', newValue: 'Synth MQL', changedAt: '2026-03-01T09:00:00.000Z' }),
          historyRow({ historyId: 'H2', oldValue: 'Synth MQL', newValue: 'Synth Lead', changedAt: '2026-05-01T09:00:00.000Z' }),
          historyRow({ historyId: 'H3', oldValue: 'Synth Lead', newValue: 'Synth MQL', changedAt: '2027-01-15T09:00:00.000Z' }),
        ],
      }),
    );
    // Program decision 1.6: demotion and requalification are separate events.
    expect(s.transitions.leadToMql).toBe(2);
    expect(s.transitions.mqlToLead).toBe(1);
  });

  it('counts blank and unknown lifecycle values without guessing a mapping', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [
          historyRow({ historyId: 'H1', oldValue: 'Synth Lead', newValue: '' }),
          historyRow({ historyId: 'H2', oldValue: 'Synth Lead', newValue: 'Synth Unheard Of' }),
        ],
      }),
    );
    expect(s.transitions.blank + s.transitions.unknown).toBeGreaterThan(0);
    // Neither becomes a lead/mql transition.
    expect(s.transitions.leadToMql).toBe(0);
  });

  it('counts out-of-scope transitions without turning them into lifecycle events', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [
          historyRow({ historyId: 'H1', oldValue: 'Synth MQL', newValue: 'Synth Customer' }),
        ],
      }),
    );
    expect(s.transitions.outOfScope).toBeGreaterThan(0);
    expect(s.transitions.leadToMql).toBe(0);
    expect(s.transitions.mqlToLead).toBe(0);
  });

  it('handles a Lead converted to a Contact through the identity map', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [
          historyRow({ historyId: 'H1', parentId: 'SYNTH-LEAD-1', parentObject: 'Lead', oldValue: 'Synth Lead', newValue: 'Synth MQL', changedAt: '2026-02-01T09:00:00.000Z' }),
          historyRow({ historyId: 'H2', parentId: 'SYNTH-CONTACT-1', parentObject: 'Contact', oldValue: 'Synth MQL', newValue: 'Synth Lead', changedAt: '2026-04-01T09:00:00.000Z' }),
        ],
      }),
    );
    // Both rows belong to person-1; the demotion is seen across the
    // conversion boundary rather than lost.
    expect(s.transitions.leadToMql).toBe(1);
    expect(s.transitions.mqlToLead).toBe(1);
  });

  it('treats exact duplicate history rows as safe duplicates', () => {
    const row = historyRow({ historyId: 'H-DUP' });
    const s = summarizeDiscovery(input({ historyRows: [row, { ...row }] }));
    expect(s.transitions.duplicatesIgnored).toBeGreaterThan(0);
    expect(s.transitions.leadToMql).toBe(1);
  });

  it('flags conflicting duplicate history ids instead of silently choosing one', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [
          historyRow({ historyId: 'H-CONFLICT', newValue: 'Synth MQL' }),
          historyRow({ historyId: 'H-CONFLICT', newValue: 'Synth Lead', oldValue: 'Synth MQL' }),
        ],
      }),
    );
    expect(s.transitions.conflictingDuplicateHistoryIds).toBeGreaterThan(0);
  });
});

// --- volume and touch identity --------------------------------------------

describe('volume and touch-identity gaps', () => {
  it('reports lead-vs-contact membership counts and converted linkage coverage', () => {
    const s = summarizeDiscovery(input());
    expect(s.volume.leadMemberRows).toBe(900);
    expect(s.volume.contactMemberRows).toBe(1700);
    expect(s.volume.convertedLeadsWithContactLink).toBe(300);
    expect(s.volume.convertedLeadsMissingContactLink).toBe(4);
  });

  it('counts missing CampaignMember Id, Campaign Id, identity, and touch date', () => {
    const s = summarizeDiscovery(
      input({
        campaignMembers: {
          ...VOLUME,
          missingCampaignMemberId: 12,
          missingCampaignId: 7,
          missingPersonIdentity: 3,
          missingTouchDate: 5,
          missingCampaignChannelMapping: 9,
        },
      }),
    );
    expect(s.volume.missingCampaignMemberId).toBe(12);
    expect(s.volume.missingCampaignId).toBe(7);
    expect(s.volume.missingPersonIdentity).toBe(3);
    expect(s.volume.missingTouchDate).toBe(5);
    expect(s.volume.missingCampaignChannelMapping).toBe(9);
  });

  it('flags a feed that would exceed the current 5,000-row assumption', () => {
    const under = summarizeDiscovery(input());
    expect(under.volume.exceedsCurrentRowLimit).toBe(false);
    const over = summarizeDiscovery(
      input({ campaignMembers: { ...VOLUME, fullReconciliationRows: 7400 } }),
    );
    expect(over.volume.exceedsCurrentRowLimit).toBe(true);
    expect(over.volume.estimatedReconciliationBatches).toBe(4); // ceil(7400 / 2000)
  });

  it('estimates pagination batches from the planned batch size', () => {
    const s = summarizeDiscovery(input({ plannedBatchSize: 500 }));
    expect(s.volume.estimatedIncrementalBatches).toBe(1); // ceil(120 / 500)
    expect(s.volume.estimatedReconciliationBatches).toBe(6); // ceil(2600 / 500)
  });
});

// --- output contract -------------------------------------------------------

describe('summary output contract', () => {
  it('always reports dry_run true and zero writes attempted', () => {
    const s = summarizeDiscovery(input());
    expect(s.dry_run).toBe(true);
    expect(s.writes_attempted).toBe(0);
  });

  it('is aggregate-only and leaks no identifiers', () => {
    const s = summarizeDiscovery(
      input({
        historyRows: [historyRow({ historyId: 'H1' })],
        lifecycleValues: [{ value: 'Synth Lead', count: 1800 }],
      }),
    );
    expect(() => assertNoIdentifierLeakage(s)).not.toThrow();
    const serialized = JSON.stringify(s);
    // No source rows, parent ids, or history ids reach the summary.
    expect(serialized).not.toContain('SYNTH-LEAD-1');
    expect(serialized).not.toContain('SYNTH-CONTACT-1');
    expect(serialized).not.toContain('H1');
    expect(serialized).not.toMatch(/@/);
  });

  it('the leakage guard rejects a Salesforce-id-shaped or email-shaped value', () => {
    const s = summarizeDiscovery(input());
    const withId = { ...s, unresolvedDecisions: ['0035f00000AbCdEfGh'] };
    expect(() => assertNoIdentifierLeakage(withId)).toThrow(/Salesforce-record-id-shaped/);
    const withEmail = { ...s, unresolvedDecisions: ['contact synth.person@example.test'] };
    expect(() => assertNoIdentifierLeakage(withEmail)).toThrow(/email-shaped/);
  });

  it('reports distinct lifecycle values with counts', () => {
    const s = summarizeDiscovery(input());
    expect(s.distinctLifecycleValueCount).toBe(2);
    expect(s.lifecycleValues.find((v) => v.value === 'Synth MQL')?.count).toBe(400);
  });
});

// --- static workflow-template safety --------------------------------------

describe('discovery workflow template safety (static)', () => {
  const doc = readFileSync(resolve(process.cwd(), 'docs/lead-sync-discovery.md'), 'utf8');
  const match = /```json\n([\s\S]*?)\n```/.exec(doc);
  const template = JSON.parse(match![1]) as {
    active: boolean;
    settings: Record<string, unknown>;
    pinData: Record<string, unknown>;
    nodes: Array<{
      name: string;
      type: string;
      executeOnce?: boolean;
      credentials?: Record<string, unknown>;
      parameters: Record<string, unknown>;
    }>;
    connections: Record<string, { main: Array<Array<{ node: string }>> }>;
  };
  const raw = match![1];

  it('is disabled and manual-trigger only, with no schedule trigger', () => {
    expect(template.active).toBe(false);
    expect(template.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
    expect(template.nodes.some((n) => n.type.toLowerCase().includes('scheduletrigger'))).toBe(false);
    expect(template.nodes.some((n) => n.type.toLowerCase().includes('cron'))).toBe(false);
  });

  it('records the America/Denver timezone for the future scheduled workflow', () => {
    expect(template.settings.timezone).toBe('America/Denver');
    expect(raw).toContain('future_schedule_timezone');
  });

  it('contains no write-capable node of any kind', () => {
    const forbidden = [
      'httpRequest', 'googleSheets', 'slack', 'emailSend', 'postgres',
      'supabase', 'webhook', 'ftp', 'executeCommand', 'writeBinaryFile',
    ];
    for (const f of forbidden) {
      expect(
        template.nodes.some((n) => n.type.toLowerCase().includes(f.toLowerCase())),
        `write-capable node present: ${f}`,
      ).toBe(false);
    }
  });

  it('every Salesforce node is a read-only search operation', () => {
    const sfNodes = template.nodes.filter((n) => n.type === 'n8n-nodes-base.salesforce');
    expect(sfNodes.length).toBeGreaterThanOrEqual(9);
    for (const n of sfNodes) {
      expect(n.parameters.resource, `${n.name} must be a search`).toBe('search');
      expect(typeof n.parameters.query).toBe('string');
      // No create/update/upsert/delete operation may appear.
      expect(JSON.stringify(n.parameters)).not.toMatch(/"operation"\s*:\s*"(create|update|upsert|delete)"/);
    }
  });

  it('binds no credentials and pins no data', () => {
    for (const n of template.nodes) {
      expect(n.credentials ?? {}, `${n.name} must bind no credential`).toEqual({});
    }
    expect(template.pinData).toEqual({});
  });

  it('every global query sets executeOnce so item counts cannot amplify it', () => {
    const globals = template.nodes.filter(
      (n) => n.type === 'n8n-nodes-base.salesforce' || n.name.startsWith('CONFIG'),
    );
    for (const n of globals) {
      expect(n.executeOnce, `${n.name} must set executeOnce`).toBe(true);
    }
  });

  it('every referenced node is an executed ancestor', () => {
    // Build the ancestor set by walking the linear chain from the trigger.
    const nextOf = (name: string): string[] =>
      (template.connections[name]?.main?.[0] ?? []).map((c) => c.node);
    const order: string[] = [];
    let cursor: string | undefined = 'When clicking Execute (manual only)';
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      order.push(cursor);
      cursor = nextOf(cursor)[0];
    }
    const indexOf = (name: string) => order.indexOf(name);
    for (const node of template.nodes) {
      const js = String((node.parameters as { jsCode?: string }).jsCode ?? '');
      for (const m of js.matchAll(/\$\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
        const referenced = m[1];
        expect(indexOf(referenced), `${node.name} references non-ancestor ${referenced}`)
          .toBeGreaterThanOrEqual(0);
        expect(indexOf(referenced), `${node.name} references later node ${referenced}`)
          .toBeLessThan(indexOf(node.name));
      }
    }
  });

  it('the guard is the only successful terminal node', () => {
    const terminals = template.nodes
      .map((n) => n.name)
      .filter((name) => (template.connections[name]?.main?.[0] ?? []).length === 0);
    expect(terminals).toEqual(['GUARD: dry-run summary (shared, aggregate only)']);
    const guard = template.nodes.find((n) => n.name.startsWith('GUARD'))!;
    const js = String((guard.parameters as { jsCode: string }).jsCode);
    expect(js).toContain('dry_run');
    expect(js).toContain('writes_attempted');
    expect(js).toContain('throw new Error');
  });

  it('fails loudly on empty required results rather than passing silently', () => {
    const validate = template.nodes.find((n) => n.name.startsWith('VALIDATE'))!;
    const js = String((validate.parameters as { jsCode: string }).jsCode);
    expect(js).toContain('throw new Error');
    expect(js).toContain('DISCOVERY FAILED');
  });

  it('labels the private diagnostic and keeps it out of the shared summary', () => {
    const priv = template.nodes.find((n) => n.name.includes('PRIVATE'))!;
    expect(priv.name).toContain('DO NOT SHARE');
    const guard = template.nodes.find((n) => n.name.startsWith('GUARD'))!;
    const js = String((guard.parameters as { jsCode: string }).jsCode);
    // The guard must not fold the private node's output into its summary.
    expect(js).not.toContain("$('PRIVATE");
  });

  it('commits no credential, URL, document id, customer data, or Salesforce-id fixture', () => {
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(raw).not.toMatch(/\b(001|003|00Q|00v|701|005|006)[A-Za-z0-9]{12}\b/);
    expect(raw).not.toMatch(/documentId"\s*:\s*"[^"]+"/);
    expect(raw.toLowerCase()).not.toMatch(/"credentials"\s*:\s*\{\s*"/);
    expect(raw).not.toMatch(/api[_-]?key|bearer |secret/i);
  });
});
