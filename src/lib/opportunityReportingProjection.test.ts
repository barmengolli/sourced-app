import { describe, expect, it } from 'vitest';
import { attribution } from '../test/fixtures/factories';
import type { OpportunityDerivedState } from './opportunityStageHistory';
import {
  normalizeOpportunityReportingRegion,
  projectOpportunityToReporting,
  type OpportunityReportingReview,
  type OpportunityReportingSnapshot,
} from './opportunityReportingProjection';

const snapshot: OpportunityReportingSnapshot = {
  sfOpportunityId: 'SYNTH-OPPORTUNITY',
  opportunityName: 'Synthetic Deal',
  accountId: 'SYNTH-ACCOUNT',
  accountName: 'Synthetic Account',
  saasRevenueUsd: 125000,
  commercialRegion: 'NA',
  suggestedBdrName: 'Synthetic BDR',
};

const review: OpportunityReportingReview = {
  reviewState: 'approved',
  channelId: 'SYNTH-CHANNEL',
  leadId: null,
  bdrName: null,
  commercialRegionOverride: null,
};

const derived = (over: Partial<OpportunityDerivedState> = {}): OpportunityDerivedState => ({
  opportunityId: snapshot.sfOpportunityId,
  currentStage: 'pursuit',
  currentState: 'pursuit',
  activeDates: { hpp: '2026-05-01', opp: '2026-08-05', pursuit: '2026-10-10' },
  terminalStatus: 'open',
  forwardMoves: 2,
  backwardMoves: 0,
  skips: { forward: 0, backward: 0 },
  reEntries: { hpp: 0, opp: 0, pursuit: 0 },
  incompleteBaseline: false,
  velocity: { hppToOppDays: 96, oppToPursuitDays: 66, hppToPursuitDays: null },
  issues: [],
  reportable: true,
  ...over,
});

describe('Opportunity reporting projection', () => {
  it('creates one current-qualified row per reached stage in its own entry period', () => {
    const result = projectOpportunityToReporting({
      derived: derived(),
      snapshot,
      review,
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
    });
    expect(result.state).toBe('ready');
    expect(result.rows.map((row) => [row.stage_key, row.year, row.period_index])).toEqual([
      ['hpp', 2026, 2],
      ['opp', 2026, 3],
      ['pursuit', 2026, 4],
    ]);
    expect(result.rows.every((row) => row.deal_id === 'SYNTH-DEAL')).toBe(true);
    expect(result.rows.every((row) => row.amount === 125000)).toBe(true);
  });

  it('removes generated higher stages after a regression while keeping manual rows out of scope', () => {
    const result = projectOpportunityToReporting({
      derived: derived({
        currentStage: 'hpp',
        currentState: 'hpp',
        activeDates: { hpp: '2026-11-01', opp: null, pursuit: null },
      }),
      snapshot,
      review,
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
      existingGeneratedRows: [
        attribution({
          source_system: 'salesforce',
          sf_opportunity_id: snapshot.sfOpportunityId,
          stage_key: 'hpp',
          deal_id: 'SYNTH-DEAL',
        }),
        attribution({
          source_system: 'salesforce',
          sf_opportunity_id: snapshot.sfOpportunityId,
          stage_key: 'opp',
          deal_id: 'SYNTH-DEAL',
        }),
        attribution({
          source_system: 'salesforce',
          sf_opportunity_id: snapshot.sfOpportunityId,
          stage_key: 'pursuit',
          deal_id: 'SYNTH-DEAL',
        }),
        // Same deal/stage but reviewer-created: never automation-owned.
        attribution({
          source_system: 'manual',
          sf_opportunity_id: snapshot.sfOpportunityId,
          stage_key: 'pursuit',
          deal_id: 'SYNTH-MANUAL',
        }),
        // Generated, but belongs to a different Opportunity.
        attribution({
          source_system: 'salesforce',
          sf_opportunity_id: 'SYNTH-OTHER-OPPORTUNITY',
          stage_key: 'opp',
          deal_id: 'SYNTH-OTHER-DEAL',
        }),
      ],
    });
    expect(result.rows.map((row) => row.stage_key)).toEqual(['hpp']);
    expect(result.rows[0].period_index).toBe(4);
    expect(result.removeGeneratedStages).toEqual(['opp', 'pursuit']);
  });

  it('uses the reviewer Commercial Region override and never overwrites it with Salesforce', () => {
    const result = projectOpportunityToReporting({
      derived: derived({ currentStage: 'hpp', currentState: 'hpp' }),
      snapshot: { ...snapshot, commercialRegion: 'NA' },
      review: { ...review, commercialRegionOverride: 'EMEA cont & LATAM' },
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
    });
    expect(result.rows[0].region).toBe('EMEA cont & LATAM');
  });

  it('refuses an unsupported raw region instead of silently classifying it as Other', () => {
    const result = projectOpportunityToReporting({
      derived: derived({ currentStage: 'hpp', currentState: 'hpp' }),
      snapshot: { ...snapshot, commercialRegion: 'Unmapped Region' },
      review,
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
    });
    expect(result.state).toBe('partial');
    expect(result.rows).toEqual([]);
    expect(result.issues).toContain('unsupported_commercial_region');
  });

  it('does not fabricate missing historical stage dates', () => {
    const result = projectOpportunityToReporting({
      derived: derived({
        activeDates: { hpp: null, opp: '2026-08-05', pursuit: '2026-10-10' },
        incompleteBaseline: true,
      }),
      snapshot,
      review,
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
    });
    expect(result.state).toBe('partial');
    expect(result.rows.map((row) => row.stage_key)).toEqual(['opp', 'pursuit']);
    expect(result.issues).toContain('missing_stage_entry_date');
  });

  it('keeps pending reviews out of reporting', () => {
    const result = projectOpportunityToReporting({
      derived: derived(),
      snapshot,
      review: { ...review, reviewState: 'pending' },
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
    });
    expect(result.state).toBe('not_approved');
    expect(result.rows).toEqual([]);
  });

  it('removes only owned generated rows when the Opportunity becomes out of scope', () => {
    const result = projectOpportunityToReporting({
      derived: derived({
        currentStage: null,
        currentState: 'out_of_scope',
        activeDates: { hpp: null, opp: null, pursuit: null },
      }),
      snapshot,
      review,
      link: { dealId: 'SYNTH-DEAL', linkState: 'active' },
      existingGeneratedRows: [
        attribution({
          source_system: 'salesforce',
          sf_opportunity_id: snapshot.sfOpportunityId,
          stage_key: 'hpp',
        }),
        attribution({
          source_system: 'manual',
          sf_opportunity_id: snapshot.sfOpportunityId,
          stage_key: 'opp',
        }),
      ],
    });
    expect(result.state).toBe('out_of_scope');
    expect(result.removeGeneratedStages).toEqual(['hpp']);
  });

  it('accepts only the exact app reporting taxonomy', () => {
    expect(normalizeOpportunityReportingRegion('NA')).toBe('NA');
    expect(normalizeOpportunityReportingRegion('UK&IRE, ME, Japan')).toBe('UK&IRE, ME, Japan');
    expect(normalizeOpportunityReportingRegion('EMEA')).toBeNull();
    expect(normalizeOpportunityReportingRegion(null)).toBeNull();
  });
});
