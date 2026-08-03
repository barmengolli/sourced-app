// Bite 4G1: pure discovery/summary module and the static safety gates for
// the disabled read-only discovery workflow. Synthetic data only: no real
// API names beyond documented standard Salesforce ones, no record ids, no
// person data, no credentials, no URLs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  CANONICAL_LIFECYCLE_FIELD,
  assertNoIdentifierLeakage,
  normalizeLifecycleHistoryRows,
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
  changedOrCreatedWindowRows: 180,
  fullReconciliationRows: 2600,
  incrementalScope: 'organization_wide',
  fullReconciliationScope: 'organization_wide',
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
    lifecycleFieldConfig: { leadLifecycleField: LIFECYCLE_FIELD, contactLifecycleField: LIFECYCLE_FIELD },
    leadHistory: { outcome: 'succeeded_with_rows', lifecycleField: LIFECYCLE_FIELD, rowCount: 40, earliest: '2025-02-01T00:00:00.000Z', latest: '2026-07-01T00:00:00.000Z' },
    contactHistory: { outcome: 'succeeded_with_rows', lifecycleField: LIFECYCLE_FIELD, rowCount: 90, earliest: '2025-03-01T00:00:00.000Z', latest: '2026-07-15T00:00:00.000Z' },
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
  it('reports lifecycle-FILTERED coverage, tied to the confirmed field', () => {
    const s = summarizeDiscovery(input());
    expect(s.history.lead.querySucceeded).toBe(true);
    expect(s.history.lead.hasLifecycleRows).toBe(true);
    expect(s.history.lead.lifecycleField).toBe(LIFECYCLE_FIELD);
    expect(s.history.lead.lifecycleRowCount).toBe(40);
    expect(s.history.lead.earliestLifecycleTimestamp).toBe('2025-02-01T00:00:00.000Z');
    expect(s.history.contact.latestLifecycleTimestamp).toBe('2026-07-15T00:00:00.000Z');
  });

  it('distinguishes a successful ZERO-ROW result from a failed query', () => {
    const zero = summarizeDiscovery(
      input({ leadHistory: { outcome: 'succeeded_zero_rows', lifecycleField: LIFECYCLE_FIELD } }),
    );
    expect(zero.history.lead.querySucceeded).toBe(true);
    expect(zero.history.lead.hasLifecycleRows).toBe(false);
    expect(zero.history.lead.failureReason).toBeNull();
    expect(zero.history.lead.lifecycleRowCount).toBe(0);

    const failed = summarizeDiscovery(
      input({ leadHistory: { outcome: 'query_failed', reason: 'permission_denied' } }),
    );
    expect(failed.history.lead.querySucceeded).toBe(false);
    expect(failed.history.lead.failureReason).toBe('permission_denied');
    // A failure is NOT "no history exists".
    expect(failed.history.lead.lifecycleField).toBeNull();
    expect(failed.complete).toBe(false);
    expect(failed.incompleteReasons.join(' ')).toContain('LeadHistory not queryable');
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

  it('separates incremental truncation risk from reconciliation pagination', () => {
    const base = summarizeDiscovery(input());
    // 120 incremental rows: no truncation risk. 2600 reconciliation rows at
    // a 2000 batch size: pagination IS required. One flag could not say both.
    expect(base.volume.incrementalCanExceedRowLimit).toBe(false);
    expect(base.volume.reconciliationRequiresPagination).toBe(true);

    const bigIncremental = summarizeDiscovery(
      input({ campaignMembers: { ...VOLUME, incrementalWindowRows: 6200 } }),
    );
    expect(bigIncremental.volume.incrementalCanExceedRowLimit).toBe(true);

    // A future changed-or-created window can breach the limit on its own.
    const bigChanged = summarizeDiscovery(
      input({ campaignMembers: { ...VOLUME, changedOrCreatedWindowRows: 5200 } }),
    );
    expect(bigChanged.volume.incrementalCanExceedRowLimit).toBe(true);
  });

  it('labels volumes organization-wide unless a campaign scope was applied', () => {
    const orgWide = summarizeDiscovery(input());
    expect(orgWide.volume.incrementalScope).toBe('organization_wide');
    expect(orgWide.volume.fullReconciliationScope).toBe('organization_wide');
    const scoped = summarizeDiscovery(
      input({
        campaignMembers: {
          ...VOLUME,
          incrementalScope: 'approved_campaign_scope',
          fullReconciliationScope: 'approved_campaign_scope',
        },
      }),
    );
    expect(scoped.volume.fullReconciliationScope).toBe('approved_campaign_scope');
  });

  it('flags an undetermined changed-or-created strategy instead of assuming zero', () => {
    const s = summarizeDiscovery(
      input({ campaignMembers: { ...VOLUME, changedOrCreatedWindowRows: null } }),
    );
    expect(s.volume.changedOrCreatedStrategyUndetermined).toBe(true);
    expect(s.volume.changedOrCreatedWindowRows).toBeNull();
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

// --- two-pass validation (issues 1, 2, 5) ---------------------------------

describe('two-pass execution model', () => {
  it('Pass A (no field config) is never complete and says why', () => {
    const { lifecycleFieldConfig, ...passA } = input();
    void lifecycleFieldConfig;
    const s = summarizeDiscovery(passA as DiscoveryInput);
    expect(s.pass).toBe('A');
    expect(s.complete).toBe(false);
    expect(s.lifecycleField.validation).toEqual([]);
    expect(s.lifecycleField.configurationValid).toBe(false);
    expect(s.incompleteReasons.join(' ')).toContain('Pass B is required');
  });

  it('Pass B with valid config for BOTH objects is complete', () => {
    const s = summarizeDiscovery(input());
    expect(s.pass).toBe('B');
    expect(s.lifecycleField.configurationValid).toBe(true);
    expect(s.complete).toBe(true);
    expect(s.incompleteReasons).toEqual([]);
  });

  it('validates Lead and Contact INDEPENDENTLY, including different API names', () => {
    const s = summarizeDiscovery(
      input({
        contactFields: fields('Contact', [
          field({ apiName: 'Contact_Lifecycle__c', label: 'Lifecycle Stage', isHistoryTracked: true }),
        ]),
        lifecycleFieldConfig: {
          leadLifecycleField: LIFECYCLE_FIELD,
          contactLifecycleField: 'Contact_Lifecycle__c',
        },
      }),
    );
    expect(s.lifecycleField.configurationValid).toBe(true);
    expect(s.lifecycleField.apiNamesMatch).toBe(false);
    const [lead, contact] = s.lifecycleField.validation;
    expect(lead.configured).toBe(LIFECYCLE_FIELD);
    expect(contact.configured).toBe('Contact_Lifecycle__c');
    expect(s.complete).toBe(true);
  });

  it('rejects an unreplaced placeholder on either object', () => {
    for (const placeholder of ['LEAD_LIFECYCLE_FIELD', 'FIELD_API_NAME', 'REPLACE_ME']) {
      const s = summarizeDiscovery(
        input({
          lifecycleFieldConfig: { leadLifecycleField: placeholder, contactLifecycleField: LIFECYCLE_FIELD },
        }),
      );
      expect(s.lifecycleField.configurationValid, placeholder).toBe(false);
      expect(s.lifecycleField.validation[0].rejection).toBe('placeholder_not_replaced');
      // A run with a placeholder can NEVER be complete.
      expect(s.complete).toBe(false);
    }
  });

  it('rejects a blank field name', () => {
    const s = summarizeDiscovery(
      input({ lifecycleFieldConfig: { leadLifecycleField: '  ', contactLifecycleField: LIFECYCLE_FIELD } }),
    );
    expect(s.lifecycleField.validation[0].rejection).toBe('blank');
    expect(s.complete).toBe(false);
  });

  it('rejects a name FieldDefinition never returned, and never falls back to the other object', () => {
    const s = summarizeDiscovery(
      input({
        lifecycleFieldConfig: { leadLifecycleField: 'Invented_Field__c', contactLifecycleField: LIFECYCLE_FIELD },
      }),
    );
    expect(s.lifecycleField.validation[0].rejection).toBe('not_returned_by_field_definition');
    expect(s.complete).toBe(false);
  });

  it('rejects a field whose history is not queryable', () => {
    const s = summarizeDiscovery(
      input({ leadHistory: { outcome: 'query_failed', reason: 'permission_denied' } }),
    );
    expect(s.lifecycleField.validation[0].rejection).toBe('not_history_queryable');
    expect(s.complete).toBe(false);
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
      notes?: string;
    }>;
    connections: Record<string, { main: Array<Array<{ node: string }>> }>;
  };
  const raw = match![1];

  it('is disabled and manual-trigger only, with no schedule trigger', () => {
    expect(template.active).toBe(false);
    // Two manual triggers: one per pass. Neither is a schedule.
    const triggers = template.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger');
    expect(triggers).toHaveLength(2);
    expect(triggers.map((t) => t.name).sort()).toEqual([
      'PASS A: click Execute (manual only)',
      'PASS B: click Execute (manual only)',
    ]);
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

  it('every referenced node is an executed ancestor within its own pass', () => {
    const nextOf = (name: string): string[] =>
      (template.connections[name]?.main?.[0] ?? []).map((c) => c.node);
    // Each pass is its own linear chain from its own manual trigger.
    const chains = [
      'PASS A: click Execute (manual only)',
      'PASS B: click Execute (manual only)',
    ].map((start) => {
      const order: string[] = [];
      let cursor: string | undefined = start;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        order.push(cursor);
        cursor = nextOf(cursor)[0];
      }
      return order;
    });
    for (const node of template.nodes) {
      const js = String((node.parameters as { jsCode?: string }).jsCode ?? '');
      const query = String((node.parameters as { query?: string }).query ?? '');
      const chain = chains.find((c) => c.includes(node.name));
      expect(chain, `${node.name} belongs to no pass chain`).toBeTruthy();
      const idx = chain!.indexOf(node.name);
      for (const source of [js, query]) {
        for (const m of source.matchAll(/\$\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
          const referenced = m[1];
          const refIdx = chain!.indexOf(referenced);
          expect(refIdx, `${node.name} references non-ancestor ${referenced}`)
            .toBeGreaterThanOrEqual(0);
          expect(refIdx, `${node.name} references later node ${referenced}`).toBeLessThan(idx);
        }
      }
    }
  });

  it('a guard is the only successful terminal of each pass', () => {
    const terminals = template.nodes
      .map((n) => n.name)
      .filter((name) => (template.connections[name]?.main?.[0] ?? []).length === 0)
      .sort();
    expect(terminals).toEqual([
      'GUARD A: Pass A summary (shared, aggregate only)',
      'GUARD B: Pass B summary (shared, aggregate only)',
    ]);
    for (const guard of template.nodes.filter((n) => n.name.startsWith('GUARD'))) {
      const js = String((guard.parameters as { jsCode: string }).jsCode);
      expect(js).toContain('dry_run');
      expect(js).toContain('writes_attempted');
      expect(js).toContain('throw new Error');
    }
    // Pass B's guard must additionally refuse any surviving placeholder.
    const guardB = template.nodes.find((n) => n.name.startsWith('GUARD B'))!;
    const jsB = String((guardB.parameters as { jsCode: string }).jsCode);
    expect(jsB).toContain('unresolved placeholder');
  });

  it('fails loudly on empty required results rather than passing silently', () => {
    const validate = template.nodes.find((n) => n.name.startsWith('A2: VALIDATE'))!;
    const js = String((validate.parameters as { jsCode: string }).jsCode);
    expect(js).toContain('throw new Error');
    expect(js).toContain('DISCOVERY FAILED');
  });

  it('rejects placeholders BEFORE any Pass B query runs', () => {
    const reject = template.nodes.find((n) => n.name.startsWith('B0: REJECT'))!;
    const js = String((reject.parameters as { jsCode: string }).jsCode);
    expect(js).toContain('PASS B FAILED');
    expect(js).toContain('LEAD_LIFECYCLE_FIELD');
    expect(js).toContain('CONTACT_LIFECYCLE_FIELD');
    // B0 must sit before every Pass B Salesforce query.
    const order: string[] = [];
    let cursor: string | undefined = 'PASS B: click Execute (manual only)';
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      order.push(cursor);
      cursor = (template.connections[cursor]?.main?.[0] ?? []).map((c) => c.node)[0];
    }
    const rejectIdx = order.indexOf(reject.name);
    const firstQuery = order.findIndex(
      (name) => template.nodes.find((n) => n.name === name)?.type === 'n8n-nodes-base.salesforce',
    );
    expect(rejectIdx).toBeLessThan(firstQuery);
  });

  it('filters history coverage queries to the confirmed lifecycle field', () => {
    for (const name of [
      'B3: LeadHistory lifecycle coverage (field-filtered)',
      'B4: ContactHistory lifecycle coverage (field-filtered)',
    ]) {
      const node = template.nodes.find((n) => n.name === name)!;
      const q = String((node.parameters as { query: string }).query);
      // Whole-object history is NOT lifecycle coverage.
      expect(q).toContain('WHERE Field =');
      expect(q).toMatch(/lifecycle_field/);
    }
  });

  it('fetches actual history ROWS with values and timestamps, paginated', () => {
    for (const name of [
      'B5: LeadHistory lifecycle rows (page 1)',
      'B6: ContactHistory lifecycle rows (page 1)',
    ]) {
      const node = template.nodes.find((n) => n.name === name)!;
      const q = String((node.parameters as { query: string }).query);
      expect(q).toContain('OldValue');
      expect(q).toContain('NewValue');
      expect(q).toContain('CreatedDate');
      expect(q).toContain('WHERE Field =');
      // Explicit pagination, so truncation is visible rather than silent.
      expect(q).toMatch(/LIMIT \d+ OFFSET \d+/);
    }
  });

  it('never counts an alwaysOutputData empty sentinel as a row', () => {
    const codeNodes = template.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
    const counting = codeNodes.filter((n) =>
      String((n.parameters as { jsCode: string }).jsCode).includes('.all()'),
    );
    expect(counting.length).toBeGreaterThan(0);
    for (const n of counting) {
      const js = String((n.parameters as { jsCode: string }).jsCode);
      expect(js, `${n.name} must filter empty sentinels`).toContain('Object.keys');
    }
  });

  it('keeps campaign names in the PRIVATE node and out of every guard', () => {
    const priv = template.nodes.find((n) => n.name.includes('campaign scope'))!;
    const q = String((priv.parameters as { query: string }).query);
    // Names are deliberately present here to support the scope decision.
    expect(q).toContain('Campaign.Name');
    expect(priv.name).toContain('DO NOT SHARE');
    for (const guard of template.nodes.filter((n) => n.name.startsWith('GUARD'))) {
      const js = String((guard.parameters as { jsCode: string }).jsCode);
      expect(js).not.toContain('Campaign.Name');
      expect(js).not.toContain("$('PRIVATE (n8n only): DO NOT SHARE - campaign scope");
    }
  });

  it('labels CampaignMember volume queries organization-wide', () => {
    for (const name of [
      'A3: CampaignMember incremental volume (org-wide, 2-day CreatedDate)',
      'A5: CampaignMember reconciliation volume (org-wide)',
    ]) {
      const node = template.nodes.find((n) => n.name === name)!;
      expect(node.name).toContain('org-wide');
      expect(String(node.notes ?? '')).toMatch(/ORGANIZATION-WIDE/);
    }
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

// --- Lead/Contact normalization (evaluator correction, issue 2) ------------

describe('lifecycle field normalization across Lead and Contact', () => {
  const LEAD_FIELD = 'Synth_Lead_Lifecycle__c';
  const CONTACT_FIELD = 'Synth_Contact_Lifecycle__c';

  it('keeps each object\'s own field, rewrites both to one canonical token', () => {
    const result = normalizeLifecycleHistoryRows({
      rows: [
        historyRow({ historyId: 'L1', parentObject: 'Lead', parentId: 'SYNTH-LEAD-1', field: LEAD_FIELD }),
        historyRow({ historyId: 'C1', parentObject: 'Contact', parentId: 'SYNTH-CONTACT-1', field: CONTACT_FIELD }),
      ],
      leadLifecycleField: LEAD_FIELD,
      contactLifecycleField: CONTACT_FIELD,
    });
    expect(result.keptLeadRows).toBe(1);
    expect(result.keptContactRows).toBe(1);
    expect(result.rows.every((r) => r.field === CANONICAL_LIFECYCLE_FIELD)).toBe(true);
  });

  it('ignores unrelated fields, including the other object\'s lifecycle field', () => {
    const result = normalizeLifecycleHistoryRows({
      rows: [
        historyRow({ historyId: 'L1', parentObject: 'Lead', field: LEAD_FIELD }),
        historyRow({ historyId: 'L2', parentObject: 'Lead', field: 'Status' }),
        // The CONTACT field appearing on a Lead row is not that Lead's
        // lifecycle field and must be dropped, not silently accepted.
        historyRow({ historyId: 'L3', parentObject: 'Lead', field: CONTACT_FIELD }),
      ],
      leadLifecycleField: LEAD_FIELD,
      contactLifecycleField: CONTACT_FIELD,
    });
    expect(result.keptLeadRows).toBe(1);
    expect(result.ignoredOtherFieldRows).toBe(2);
  });

  it('never mutates the caller\'s rows: exported evidence keeps real field names', () => {
    const original = historyRow({ historyId: 'L1', parentObject: 'Lead', field: LEAD_FIELD });
    const rows = [original];
    normalizeLifecycleHistoryRows({ rows, leadLifecycleField: LEAD_FIELD, contactLifecycleField: CONTACT_FIELD });
    expect(original.field).toBe(LEAD_FIELD);
    expect(rows[0].field).toBe(LEAD_FIELD);
  });

  it('counts transitions correctly when the two API names DIFFER', () => {
    const normalized = normalizeLifecycleHistoryRows({
      rows: [
        historyRow({ historyId: 'L1', parentObject: 'Lead', parentId: 'SYNTH-LEAD-1', field: LEAD_FIELD,
          oldValue: 'Synth Lead', newValue: 'Synth MQL', changedAt: '2026-01-10T09:00:00.000Z' }),
        historyRow({ historyId: 'C1', parentObject: 'Contact', parentId: 'SYNTH-CONTACT-1', field: CONTACT_FIELD,
          oldValue: 'Synth MQL', newValue: 'Synth Lead', changedAt: '2026-03-10T09:00:00.000Z' }),
      ],
      leadLifecycleField: LEAD_FIELD,
      contactLifecycleField: CONTACT_FIELD,
    });
    const s = summarizeDiscovery(
      input({
        historyRows: normalized.rows,
        historyConfig: { ...CONFIG, lifecycleFieldApiName: CANONICAL_LIFECYCLE_FIELD },
      }),
    );
    // Both objects' rows counted; neither dropped.
    expect(s.transitions.leadToMql).toBe(1);
    expect(s.transitions.mqlToLead).toBe(1);
  });

  it('keeps a converted person as ONE chronology across the conversion', () => {
    // Lead row then Contact row for the SAME person, via the identity map.
    const normalized = normalizeLifecycleHistoryRows({
      rows: [
        historyRow({ historyId: 'L1', parentObject: 'Lead', parentId: 'SYNTH-LEAD-1', field: LEAD_FIELD,
          oldValue: 'Synth Lead', newValue: 'Synth MQL', changedAt: '2026-01-10T09:00:00.000Z' }),
        historyRow({ historyId: 'C1', parentObject: 'Contact', parentId: 'SYNTH-CONTACT-1', field: CONTACT_FIELD,
          oldValue: 'Synth MQL', newValue: 'Synth Lead', changedAt: '2026-03-10T09:00:00.000Z' }),
        historyRow({ historyId: 'C2', parentObject: 'Contact', parentId: 'SYNTH-CONTACT-1', field: CONTACT_FIELD,
          oldValue: 'Synth Lead', newValue: 'Synth MQL', changedAt: '2026-09-10T09:00:00.000Z' }),
      ],
      leadLifecycleField: LEAD_FIELD,
      contactLifecycleField: CONTACT_FIELD,
    });
    const s = summarizeDiscovery(
      input({
        historyRows: normalized.rows,
        historyConfig: { ...CONFIG, lifecycleFieldApiName: CANONICAL_LIFECYCLE_FIELD },
      }),
    );
    // One person: qualify, demote, requalify. Two separate calculations
    // would lose the demotion that spans the conversion boundary.
    expect(s.transitions.leadToMql).toBe(2);
    expect(s.transitions.mqlToLead).toBe(1);
  });

  it('still works when both objects share the SAME API name', () => {
    const normalized = normalizeLifecycleHistoryRows({
      rows: [
        historyRow({ historyId: 'L1', parentObject: 'Lead', field: LIFECYCLE_FIELD }),
        historyRow({ historyId: 'C1', parentObject: 'Contact', parentId: 'SYNTH-CONTACT-1', field: LIFECYCLE_FIELD }),
      ],
      leadLifecycleField: LIFECYCLE_FIELD,
      contactLifecycleField: LIFECYCLE_FIELD,
    });
    expect(normalized.keptLeadRows).toBe(1);
    expect(normalized.keptContactRows).toBe(1);
    expect(normalized.ignoredOtherFieldRows).toBe(0);
  });
});

// --- truncation and unknown-vs-zero (issues 4 and 5) ----------------------

describe('truncation makes a run incomplete', () => {
  it('Lead-only truncation marks totals partial and the run incomplete', () => {
    const s = summarizeDiscovery(
      input({ historyTruncation: { leadPossiblyTruncated: true, contactPossiblyTruncated: false } }),
    );
    expect(s.truncation.transitionTotalsArePartial).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.incompleteReasons.join(' ')).toContain('LeadHistory export may be truncated');
  });

  it('Contact-only truncation is identified by object', () => {
    const s = summarizeDiscovery(
      input({ historyTruncation: { leadPossiblyTruncated: false, contactPossiblyTruncated: true } }),
    );
    expect(s.complete).toBe(false);
    expect(s.incompleteReasons.join(' ')).toContain('ContactHistory export may be truncated');
    expect(s.incompleteReasons.join(' ')).not.toContain('LeadHistory export');
  });

  it('both truncated reports both objects', () => {
    const s = summarizeDiscovery(
      input({ historyTruncation: { leadPossiblyTruncated: true, contactPossiblyTruncated: true } }),
    );
    expect(s.truncation.transitionTotalsArePartial).toBe(true);
    expect(s.incompleteReasons.filter((r) => r.includes('truncated'))).toHaveLength(2);
  });

  it('no truncation leaves a valid run complete', () => {
    const s = summarizeDiscovery(
      input({ historyTruncation: { leadPossiblyTruncated: false, contactPossiblyTruncated: false } }),
    );
    expect(s.truncation.transitionTotalsArePartial).toBe(false);
    expect(s.complete).toBe(true);
  });
});

describe('unmeasured metrics are unknown, never zero', () => {
  it('a null volume stays null and yields null batch estimates', () => {
    const s = summarizeDiscovery(
      input({
        campaignMembers: {
          ...VOLUME,
          incrementalWindowRows: null,
          fullReconciliationRows: null,
          leadMemberRows: null,
          convertedLeadsMissingContactLink: null,
        },
      }),
    );
    expect(s.volume.incrementalWindowRows).toBeNull();
    expect(s.volume.estimatedIncrementalBatches).toBeNull();
    expect(s.volume.estimatedReconciliationBatches).toBeNull();
    expect(s.volume.leadMemberRows).toBeNull();
    // An unmeasured volume must not be read as "safely under the limit".
    expect(s.volume.incrementalCanExceedRowLimit).toBe(false);
    expect(s.volume.reconciliationRequiresPagination).toBe(false);
  });

  it('real Pass A volumes propagate unchanged', () => {
    const s = summarizeDiscovery(
      input({
        campaignMembers: { ...VOLUME, incrementalWindowRows: 137, fullReconciliationRows: 2612, leadMemberRows: 903 },
      }),
    );
    expect(s.volume.incrementalWindowRows).toBe(137);
    expect(s.volume.fullReconciliationRows).toBe(2612);
    expect(s.volume.leadMemberRows).toBe(903);
    expect(s.volume.estimatedReconciliationBatches).toBe(2); // ceil(2612/2000)
  });
});

describe('lifecycle value mapping must be deliberate', () => {
  it('an unmapped observed value makes the run incomplete and is reported', () => {
    const s = summarizeDiscovery(
      input({
        observedLeadLifecycleValues: ['Synth Lead', 'Synth Unmapped Value'],
        observedContactLifecycleValues: ['Synth MQL'],
      }),
    );
    expect(s.unmappedLifecycleValues).toEqual(['Synth Unmapped Value']);
    expect(s.complete).toBe(false);
    expect(s.incompleteReasons.join(' ')).toContain('not mapped');
  });

  it('blank values are not treated as unmapped', () => {
    const s = summarizeDiscovery(
      input({ observedLeadLifecycleValues: ['Synth Lead', '', '   '] }),
    );
    expect(s.unmappedLifecycleValues).toEqual([]);
    expect(s.complete).toBe(true);
  });

  it('fully mapped values leave the run complete', () => {
    const s = summarizeDiscovery(
      input({
        observedLeadLifecycleValues: ['Synth Lead', 'Synth MQL'],
        observedContactLifecycleValues: ['Synth Customer'],
      }),
    );
    expect(s.unmappedLifecycleValues).toEqual([]);
    expect(s.complete).toBe(true);
  });

  it('reports unmapped labels without record identifiers', () => {
    const s = summarizeDiscovery(input({ observedLeadLifecycleValues: ['Synth Unmapped Value'] }));
    expect(() => assertNoIdentifierLeakage(s)).not.toThrow();
  });
});

// --- generated evaluator: end-to-end from OUTSIDE the repository ----------
//
// The evaluator lives outside the repo (Downloads). ES module specifiers
// resolve relative to the evaluator FILE, not the terminal's cwd, so a
// relative './src/...' import silently pointed at Downloads/src. These tests
// copy the generated evaluator into a temp directory well away from the
// repository and prove it still loads the REAL repository module.

describe('generated local evaluator (external module resolution)', () => {
  const EVALUATOR = '/Users/barmengolli/Downloads/4g1-local-evaluator.mjs';
  const repoRoot = process.cwd();

  const evaluatorExists = (() => {
    try {
      readFileSync(EVALUATOR, 'utf8');
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(evaluatorExists)('resolves the repository module from a temp dir via an explicit repo-root argument', () => {
    const dir = mkdtempSync(resolve(tmpdir(), '4g1-eval-'));
    try {
      // Copy the evaluator OUT of Downloads so nothing about its location
      // can accidentally make a relative path work.
      const copied = resolve(dir, 'evaluator.mjs');
      writeFileSync(copied, readFileSync(EVALUATOR, 'utf8'));
      // Minimal valid inputs; STAGE_VALUE_MAP is intentionally unfilled, so
      // the run must stop at that guard AFTER successfully importing the
      // module. That is precisely what proves resolution worked.
      const guardA = resolve(dir, 'guard-a.json');
      const passB = resolve(dir, 'pass-b.json');
      writeFileSync(guardA, JSON.stringify({ pass: 'A', campaign_member_volumes: {} }));
      writeFileSync(
        passB,
        JSON.stringify({
          lead_lifecycle_field: 'Synth_Lead_Lifecycle__c',
          contact_lifecycle_field: 'Synth_Contact_Lifecycle__c',
          lead_history_status: { outcome: 'succeeded_zero_rows' },
          contact_history_status: { outcome: 'succeeded_zero_rows' },
          lead_history_rows: [],
          contact_history_rows: [],
          converted_identity_rows: [],
        }),
      );
      let stderr = '';
      let importFailed = false;
      try {
        execFileSync('npx', ['tsx', copied, repoRoot, guardA, passB], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string };
        stderr = String(e.stderr ?? '') + String(e.stdout ?? '');
        importFailed = /Could not load the repository module/.test(stderr);
      }
      // The module MUST have loaded: the only expected stop is the
      // deliberate stage-map guard, never a resolution failure.
      expect(importFailed, `module resolution failed:\n${stderr}`).toBe(false);
      expect(stderr).toMatch(/STAGE_VALUE_MAP/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(evaluatorExists)('fails clearly when the repo root argument is wrong', () => {
    const dir = mkdtempSync(resolve(tmpdir(), '4g1-eval-bad-'));
    try {
      const copied = resolve(dir, 'evaluator.mjs');
      writeFileSync(copied, readFileSync(EVALUATOR, 'utf8'));
      const guardA = resolve(dir, 'guard-a.json');
      const passB = resolve(dir, 'pass-b.json');
      writeFileSync(guardA, '{}');
      writeFileSync(passB, '{}');
      let combined = '';
      try {
        execFileSync('npx', ['tsx', copied, dir, guardA, passB], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as { stderr?: string; stdout?: string };
        combined = String(e.stderr ?? '') + String(e.stdout ?? '');
      }
      expect(combined).toMatch(/Could not load the repository module|sourced-4g1 worktree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(evaluatorExists)('takes an explicit repo root and hardcodes no absolute worktree path', () => {
    const src = readFileSync(EVALUATOR, 'utf8');
    expect(src).toContain('pathToFileURL');
    expect(src).toContain('process.argv.slice(2)');
    // No relative './src/...' import, and no hardcoded worktree path.
    expect(src).not.toMatch(/from '\.\/src\/lib/);
    expect(src).not.toMatch(/\/Users\/[^/]+\/Desktop/);
  });

  it.runIf(evaluatorExists)('requires query status and never assumes success', () => {
    const src = readFileSync(EVALUATOR, 'utf8');
    expect(src).toContain('lead_history_status');
    expect(src).toContain('contact_history_status');
    expect(src).toContain('succeeded_zero_rows');
    expect(src).toContain('query_failed');
    // The old always-success construction must be gone.
    expect(src).not.toMatch(/outcome: 'succeeded_with_rows', lifecycleField: payload/);
  });

  it.runIf(evaluatorExists)('uses the canonical token, not one object\'s raw API name', () => {
    const src = readFileSync(EVALUATOR, 'utf8');
    expect(src).toContain('normalizeLifecycleHistoryRows');
    expect(src).toContain('CANONICAL_LIFECYCLE_FIELD');
    expect(src).not.toMatch(/lifecycleFieldApiName: payload\.lead_lifecycle_field/);
  });

  it.runIf(evaluatorExists)('warns about deleting the identifier-bearing export', () => {
    const src = readFileSync(EVALUATOR, 'utf8');
    expect(src).toMatch(/DELETE the private export/);
    expect(src).toMatch(/Salesforce record ids/);
  });
});
